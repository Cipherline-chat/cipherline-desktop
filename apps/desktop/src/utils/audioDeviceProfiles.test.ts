import { describe, it, expect } from 'vitest';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../hooks/useVoiceSettings';
import {
    connectedProfileKeys, emptyDeviceProfiles, findDeviceProfile, forgetDeviceProfile, kindsTouched,
    MAX_PROFILES_PER_KIND, normalizeDeviceLabel, parseDeviceProfiles, pickProfileSettings, profileDiff,
    recordProfileChange, rememberActiveDevice, resolveActiveDevice, resolveDefaultDevice, seedDeviceProfiles,
    type DeviceIdentity, type DeviceProfiles,
} from './audioDeviceProfiles';

/**
 * Per-device audio settings: which device is "the one in use", how a device is
 * recognised across unplug / replug / restart / Windows re-enumeration, first
 * sight inheriting the current settings, saving a change to the right device,
 * the first-run migration, and forgetting.
 */

const dev = (deviceId: string, label: string, groupId: string, kind: MediaDeviceKind = 'audioinput') =>
    ({ deviceId, label, groupId, kind, toJSON: () => ({}) }) as MediaDeviceInfo;

const S = (o: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...DEFAULT_VOICE_SETTINGS, ...o });
const T0 = 1_700_000_000_000;

// A Windows box: a USB mic, a headset (mic + earphones), built-in speakers.
const WIN = [
    dev('default', 'Default - Microphone (Shure MV7)', 'g-mv7'),
    dev('communications', 'Communications - Headset Microphone (Arctis 7)', 'g-arctis'),
    dev('id-mv7', 'Microphone (Shure MV7)', 'g-mv7'),
    dev('id-arctis-mic', 'Headset Microphone (Arctis 7)', 'g-arctis'),
    dev('default', 'Default - Speakers (Realtek(R) Audio)', 'g-rt', 'audiooutput'),
    dev('communications', 'Communications - Headset Earphone (Arctis 7)', 'g-arctis', 'audiooutput'),
    dev('id-rt', 'Speakers (Realtek(R) Audio)', 'g-rt', 'audiooutput'),
    dev('id-arctis-out', 'Headset Earphone (Arctis 7)', 'g-arctis', 'audiooutput'),
];

describe('normalizeDeviceLabel', () => {
    it('drops the pseudo-device prefix, the Windows "(2- " instance number, case and spacing', () => {
        expect(normalizeDeviceLabel('Default - Microphone (Shure MV7)')).toBe('microphone (shure mv7)');
        expect(normalizeDeviceLabel('Communications - Microphone (Shure MV7)')).toBe('microphone (shure mv7)');
        expect(normalizeDeviceLabel('Microphone (2- Shure MV7)')).toBe('microphone (shure mv7)');
        expect(normalizeDeviceLabel('Microphone  (12-  Shure   MV7) ')).toBe('microphone (shure mv7)');
    });
    it('keeps what tells two different devices apart', () => {
        expect(normalizeDeviceLabel('Microphone (Shure MV7)')).not.toBe(normalizeDeviceLabel('Microphone (Realtek(R) Audio)'));
        expect(normalizeDeviceLabel('USB Audio (046d:0a87)')).toBe('usb audio (046d:0a87)');
    });
});

describe('which device is in use', () => {
    it('"follow the default" resolves Chromium\'s default row to the REAL device (groupId + label)', () => {
        expect(resolveActiveDevice(WIN, 'input', '', null)).toEqual({ deviceId: 'id-mv7', groupId: 'g-mv7', label: 'Microphone (Shure MV7)', viaDefault: true });
        expect(resolveActiveDevice(WIN, 'output', '', null)).toMatchObject({ deviceId: 'id-rt', label: 'Speakers (Realtek(R) Audio)', viaDefault: true });
    });

    it('the Windows default moving to the headset is seen as the headset', () => {
        const moved = WIN.map(d => d.deviceId === 'default' && d.kind === 'audiooutput'
            ? dev('default', 'Default - Headset Earphone (Arctis 7)', 'g-arctis', 'audiooutput') : d);
        expect(resolveActiveDevice(moved, 'output', '', null)).toMatchObject({ deviceId: 'id-arctis-out', viaDefault: true });
    });

    it('an explicit pick that is plugged in wins; one that is unplugged falls back to the default, like the call', () => {
        expect(resolveActiveDevice(WIN, 'input', 'id-arctis-mic', null)).toMatchObject({ deviceId: 'id-arctis-mic', viaDefault: false });
        expect(resolveActiveDevice(WIN, 'input', 'id-gone', { label: 'Yeti', groupId: 'g-yeti' })).toMatchObject({ deviceId: 'id-mv7', viaDefault: true });
    });

    it('a pick whose id changed (Windows re-created the endpoint) is followed by label + groupId', () => {
        expect(resolveActiveDevice(WIN, 'input', 'id-arctis-OLD', { label: 'Headset Microphone (Arctis 7)', groupId: 'g-arctis' }))
            .toMatchObject({ deviceId: 'id-arctis-mic', viaDefault: false });
    });

    it('before media permission (placeholders, no labels) nothing is recognised', () => {
        expect(resolveActiveDevice([dev('', '', ''), dev('', '', '', 'audiooutput')], 'input', '', null)).toBeNull();
    });

    it('default row with a bare label (Linux "Default") is remembered as itself; no default row → the first device', () => {
        expect(resolveDefaultDevice([dev('default', 'Default', 'g-x'), dev('a', 'Built-in Audio', 'g-a'), dev('b', 'USB Mic', 'g-b')]))
            .toMatchObject({ deviceId: 'default', label: 'Default' });
        expect(resolveDefaultDevice([dev('a', 'Built-in Audio', 'g-a'), dev('b', 'USB Mic', 'g-b')])).toMatchObject({ deviceId: 'a' });
    });

    it('default row whose groupId is shared by two endpoints is told apart by its label', () => {
        const list = [dev('default', 'Default - Line In (Realtek)', 'g-rt'), dev('mic', 'Microphone (Realtek)', 'g-rt'), dev('line', 'Line In (Realtek)', 'g-rt')];
        expect(resolveDefaultDevice(list)).toMatchObject({ deviceId: 'line' });
    });
});

const ident = (deviceId: string, label: string, groupId: string, viaDefault = false): DeviceIdentity => ({ deviceId, label, groupId, viaDefault });

describe('remembering devices', () => {
    it('first time a device is seen it inherits the CURRENT settings (nothing changes)', () => {
        const live = S({ micVolume: 140, noiseSuppressionMode: 'light', voiceGateThreshold: -38 });
        const r = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('id-mv7', 'Microphone (Shure MV7)', 'g-mv7'), live, T0, true);
        expect(r.created).toBe(true);
        expect(r.profiles.input[r.key].settings).toEqual(pickProfileSettings('input', live));
        expect(profileDiff('input', live, r.profiles.input[r.key].settings)).toEqual({});
    });

    it('unplug + replug with a NEW deviceId but the same label/groupId is the same profile', () => {
        let p = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('id-1', 'Microphone (Shure MV7)', 'g-mv7'), S({ micVolume: 150 }), T0, true).profiles;
        const r = rememberActiveDevice(p, 'input', ident('id-2', 'Microphone (2- Shure MV7)', 'g-mv7-2'), S(), T0 + 1000, true);
        expect(r.created).toBe(false);
        p = r.profiles;
        expect(Object.keys(p.input)).toEqual(['microphone (shure mv7)']);
        expect(p.input['microphone (shure mv7)']).toMatchObject({ deviceId: 'id-2', groupId: 'g-mv7-2', label: 'Microphone (2- Shure MV7)', lastUsedAt: T0 + 1000 });
        expect(p.input['microphone (shure mv7)'].settings.micVolume).toBe(150);
    });

    it('a device renamed in Windows (label changed, same id) keeps its profile, re-keyed', () => {
        const p = rememberActiveDevice(emptyDeviceProfiles(), 'output', ident('id-x', 'Headphones (WH-1000XM5)', 'g'), S({ speakerVolume: 60 }), T0, true).profiles;
        expect(findDeviceProfile(p, 'output', ident('id-x', "Dawson's headphones", 'g'))).toEqual({ key: 'headphones (wh-1000xm5)', match: 'device_id' });
        const r = rememberActiveDevice(p, 'output', ident('id-x', "Dawson's headphones", 'g'), S(), T0, true);
        expect(r.created).toBe(false);
        expect(Object.keys(r.profiles.output)).toEqual(["dawson's headphones"]);
        expect(r.profiles.output["dawson's headphones"].settings.speakerVolume).toBe(60);
    });

    it('the USB vendor:product suffix coming or going still finds the device', () => {
        const p = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('a', 'USB Audio Device (0d8c:0014)', 'g1'), S({ micVolume: 90 }), T0, true).profiles;
        expect(findDeviceProfile(p, 'input', ident('b', 'USB Audio Device', 'g2'))).toMatchObject({ key: 'usb audio device (0d8c:0014)', match: 'loose_label' });
    });

    it('input and output are separate even when they share a groupId (a headset)', () => {
        let p = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('m', 'Headset (Arctis 7)', 'g-arctis'), S(), T0, true).profiles;
        p = rememberActiveDevice(p, 'output', ident('o', 'Headset (Arctis 7)', 'g-arctis'), S(), T0, true).profiles;
        expect(Object.keys(p.input)).toHaveLength(1);
        expect(Object.keys(p.output)).toHaveLength(1);
    });

    it('a device seen again with nothing new is not a change (no write)', () => {
        const a = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('m', 'Mic', 'g'), S(), T0, true);
        const b = rememberActiveDevice(a.profiles, 'input', ident('m', 'Mic', 'g'), S(), T0 + 5, false);
        expect(b.changed).toBe(false);
        expect(b.profiles).toBe(a.profiles);
    });

    it('never keeps more than the cap; the least recently used go first, never the one in use', () => {
        let p: DeviceProfiles = emptyDeviceProfiles();
        for (let i = 0; i < MAX_PROFILES_PER_KIND + 3; i++) {
            p = rememberActiveDevice(p, 'input', ident(`id${i}`, `Mic ${i}`, `g${i}`), S(), T0 + i, true).profiles;
        }
        expect(Object.keys(p.input)).toHaveLength(MAX_PROFILES_PER_KIND);
        expect(p.input['mic 0']).toBeUndefined();
        expect(p.input[`mic ${MAX_PROFILES_PER_KIND + 2}`]).toBeDefined();
    });
});

describe('switching between devices', () => {
    it('headphones ↔ speakers: each gets its own volume and echo cancellation back', () => {
        let p = emptyDeviceProfiles();
        // On speakers: loud, echo cancellation on.
        let live = S({ speakerVolume: 120, echoCancellation: true });
        p = rememberActiveDevice(p, 'output', ident('rt', 'Speakers (Realtek)', 'g-rt'), live, T0, true).profiles;
        p = rememberActiveDevice(p, 'input', ident('mic', 'Microphone (Realtek)', 'g-rt'), live, T0, true).profiles;
        // Plug in the headset: first seen → inherits; then the user turns things down.
        p = rememberActiveDevice(p, 'output', ident('hs', 'Headset Earphone (Arctis 7)', 'g-a'), live, T0, true).profiles;
        p = rememberActiveDevice(p, 'input', ident('hsm', 'Headset Microphone (Arctis 7)', 'g-a'), live, T0, true).profiles;
        p = recordProfileChange(p, 'output', 'headset earphone (arctis 7)', { speakerVolume: 45 }, T0);
        p = recordProfileChange(p, 'input', 'headset microphone (arctis 7)', { echoCancellation: false }, T0);
        live = S({ speakerVolume: 45, echoCancellation: false });
        // Unplug: back on the speakers, their settings return.
        expect(profileDiff('output', live, p.output['speakers (realtek)'].settings)).toEqual({ speakerVolume: 120 });
        expect(profileDiff('input', live, p.input['microphone (realtek)'].settings)).toEqual({ echoCancellation: true });
    });

    it('a change is saved only for its own direction and only for the device given', () => {
        let p = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('a', 'Mic A', 'g'), S(), T0, true).profiles;
        p = rememberActiveDevice(p, 'input', ident('b', 'Mic B', 'g2'), S(), T0, true).profiles;
        const next = recordProfileChange(p, 'input', 'mic a', { micVolume: 175, speakerVolume: 10, pushToTalk: true }, T0 + 1);
        expect(next.input['mic a'].settings.micVolume).toBe(175);
        expect(next.input['mic b'].settings.micVolume).toBe(100);
        expect(next.input['mic a'].settings).not.toHaveProperty('speakerVolume');
        expect(next.input['mic a'].settings).not.toHaveProperty('pushToTalk');
        expect(recordProfileChange(p, 'input', 'mic a', { pushToTalk: true }, T0)).toBe(p);
        expect(recordProfileChange(p, 'input', 'nope', { micVolume: 1 }, T0)).toBe(p);
    });

    it('recorded values are clamped like the live setters (volume ≤ 200 %, gate -60..-20, EQ ±12)', () => {
        const p = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('a', 'Mic A', 'g'), S(), T0, true).profiles;
        const n = recordProfileChange(p, 'input', 'mic a', { micVolume: 900, voiceGateThreshold: -5, eqBands: [40, -40, 0, 0, 0] }, T0);
        expect(n.input['mic a'].settings).toMatchObject({ micVolume: 200, voiceGateThreshold: -20, eqBands: [12, -12, 0, 0, 0] });
    });

    it('push to talk, device picks and camera settings are never per device', () => {
        expect(kindsTouched({ pushToTalk: true, pushToTalkKey: 'f', micDeviceId: 'x', speakerDeviceId: 'y', cameraBrightness: 1 })).toEqual([]);
        expect(kindsTouched({ micVolume: 1 })).toEqual(['input']);
        expect(kindsTouched({ normalizeIncomingVolume: false })).toEqual(['output']);
    });
});

describe('storage', () => {
    it('round-trips', () => {
        let p = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('a', 'Mic A', 'g'), S({ eqEnabled: true, eqBands: [1, 2, 3, 4, 5] }), T0, true).profiles;
        p = rememberActiveDevice(p, 'output', ident('o', 'Speakers', 'g'), S({ normalizeIncomingVolume: false }), T0, true).profiles;
        expect(parseDeviceProfiles(JSON.stringify(p), DEFAULT_VOICE_SETTINGS)).toEqual(p);
    });

    it.each([null, '', 'not json', '[]', '{"v":2}', 'null'])('nothing usable stored (%j) → null (caller seeds)', (raw) => {
        expect(parseDeviceProfiles(raw, DEFAULT_VOICE_SETTINGS)).toBeNull();
    });

    it('a bad profile is repaired or dropped, never poisons the rest', () => {
        const raw = JSON.stringify({ v: 1, input: {
            good: { label: 'Mic A', deviceId: 'a', groupId: 'g', lastUsedAt: T0, settings: { micVolume: 300, noiseSuppressionMode: 'turbo', eqBands: [1] } },
            nolabel: { deviceId: 'x', settings: {} },
            junk: 7,
        }, output: 'x' });
        const p = parseDeviceProfiles(raw, DEFAULT_VOICE_SETTINGS)!;
        expect(Object.keys(p.input)).toEqual(['mic a']);
        expect(p.input['mic a'].settings).toMatchObject({ micVolume: 200, noiseSuppressionMode: 'strong', eqBands: [0, 0, 0, 0, 0] });
        expect(p.output).toEqual({});
    });
});

describe('migration (first run with per-device settings)', () => {
    it('an explicitly picked mic and speaker are remembered at once with today\'s settings, even if unplugged', () => {
        const live = S({
            micDeviceId: 'id-yeti', micDeviceLabel: 'Microphone (Yeti Stereo Microphone)', micDeviceGroupId: 'g-yeti', micVolume: 130, voiceGate: false,
            speakerDeviceId: 'id-hp', speakerDeviceLabel: 'Headphones (Jabra)', speakerDeviceGroupId: 'g-j', speakerVolume: 70,
        });
        const p = seedDeviceProfiles(live, T0);
        expect(p.input['microphone (yeti stereo microphone)'].settings).toEqual(pickProfileSettings('input', live));
        expect(p.output['headphones (jabra)'].settings).toEqual({ speakerVolume: 70, normalizeIncomingVolume: true });
    });

    it('"follow the default" users start empty — the device in use then inherits on first sight', () => {
        expect(seedDeviceProfiles(S(), T0)).toEqual(emptyDeviceProfiles());
    });
});

describe('forgetting and the device list', () => {
    it('forget removes only that device', () => {
        let p = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('a', 'Mic A', 'g'), S(), T0, true).profiles;
        p = rememberActiveDevice(p, 'input', ident('b', 'Mic B', 'g'), S(), T0, true).profiles;
        const f = forgetDeviceProfile(p, 'input', 'mic a');
        expect(Object.keys(f.input)).toEqual(['mic b']);
        expect(forgetDeviceProfile(f, 'input', 'mic a')).toBe(f);
        // Seen again later → a fresh profile from the then-current settings.
        expect(rememberActiveDevice(f, 'input', ident('a', 'Mic A', 'g'), S({ micVolume: 55 }), T0, true)).toMatchObject({ created: true });
    });

    it('connectedProfileKeys says which remembered devices are plugged in right now', () => {
        let p = rememberActiveDevice(emptyDeviceProfiles(), 'input', ident('id-mv7', 'Microphone (Shure MV7)', 'g-mv7'), S(), T0, true).profiles;
        p = rememberActiveDevice(p, 'input', ident('id-yeti', 'Yeti', 'g-yeti'), S(), T0, true).profiles;
        p = rememberActiveDevice(p, 'output', ident('id-arctis-out', 'Headset Earphone (Arctis 7)', 'g-arctis'), S(), T0, true).profiles;
        const c = connectedProfileKeys(p, WIN);
        expect([...c.input]).toEqual(['microphone (shure mv7)']);
        expect([...c.output]).toEqual(['headset earphone (arctis 7)']);
    });
});
