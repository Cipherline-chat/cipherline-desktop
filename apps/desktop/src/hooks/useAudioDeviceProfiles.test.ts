// @vitest-environment jsdom
/**
 * Per-device audio settings, end to end through the REAL useVoiceSettings hook:
 * the first run inherits (and migrates) without changing anything, a headset
 * plugged in mid-session gets its own settings back, a change made with the
 * normal setters is saved for the device in use and only that device, editing
 * an unplugged device never touches the live settings, and nothing is read or
 * written before the account's encrypted records are loaded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mem = new Map<string, string>();
const store = vi.hoisted(() => ({ ready: new Set<string>(), resolveReady: null as null | (() => void) }));
vi.mock('../utils/secureLocalStore', () => {
    const s = {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
        removeItem: (k: string) => { mem.delete(k); },
        isAccountReady: (u: string) => store.ready.has(u),
        whenAccountReady: () => new Promise<void>(r => { store.resolveReady = r; }),
    };
    return { secureLocalStore: s, default: s };
});

import { useVoiceSettings, VOICE_SETTINGS_STORAGE_KEY, DEFAULT_VOICE_SETTINGS, type VoiceSettingsHook } from './useVoiceSettings';
import { audioDeviceProfilesKey, type DeviceProfiles } from '../utils/audioDeviceProfiles';
import { requestAudioDeviceResync } from './useAudioDeviceProfiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dev = (deviceId: string, label: string, groupId: string, kind: MediaDeviceKind = 'audioinput') =>
    ({ deviceId, label, groupId, kind, toJSON: () => ({}) }) as MediaDeviceInfo;

const SPEAKERS_ONLY = [
    dev('default', 'Default - Microphone (Realtek Audio)', 'g-rt'),
    dev('id-rt-mic', 'Microphone (Realtek Audio)', 'g-rt'),
    dev('default', 'Default - Speakers (Realtek Audio)', 'g-rt', 'audiooutput'),
    dev('id-rt-out', 'Speakers (Realtek Audio)', 'g-rt', 'audiooutput'),
];
// The headset plugged in and Windows made it the default both ways — under a
// DIFFERENT deviceId each time it is plugged in.
const withHeadset = (n: number) => [
    dev('default', 'Default - Headset Microphone (Arctis 7)', `g-a${n}`),
    dev('id-rt-mic', 'Microphone (Realtek Audio)', 'g-rt'),
    dev(`id-a-mic-${n}`, `Headset Microphone (${n > 1 ? `${n}- ` : ''}Arctis 7)`, `g-a${n}`),
    dev('default', 'Default - Headset Earphone (Arctis 7)', `g-a${n}`, 'audiooutput'),
    dev('id-rt-out', 'Speakers (Realtek Audio)', 'g-rt', 'audiooutput'),
    dev(`id-a-out-${n}`, 'Headset Earphone (Arctis 7)', `g-a${n}`, 'audiooutput'),
];

let devices: MediaDeviceInfo[] = SPEAKERS_ONLY;
const changeListeners = new Set<() => void>();
let host: HTMLDivElement;
let root: Root;
let hook: VoiceSettingsHook;

const UID = 'u-1';
const profiles = (): DeviceProfiles => JSON.parse(mem.get(audioDeviceProfilesKey(UID))!);
const flush = async (ms = 0) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };

async function mount(userId: string | null = UID) {
    const Probe: React.FC = () => { hook = useVoiceSettings(userId); return null; };
    await act(async () => { root.render(React.createElement(Probe)); });
    await flush();
    await flush();
}
async function plug(next: MediaDeviceInfo[]) {
    devices = next;
    await act(async () => { changeListeners.forEach(l => l()); });
    await flush(450); // devicechange is debounced
    await flush();
}

beforeEach(() => {
    vi.useRealTimers();
    mem.clear();
    store.ready = new Set([UID]);
    devices = SPEAKERS_ONLY;
    changeListeners.clear();
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
            enumerateDevices: async () => devices,
            addEventListener: (t: string, l: () => void) => { if (t === 'devicechange') changeListeners.add(l); },
            removeEventListener: (t: string, l: () => void) => { if (t === 'devicechange') changeListeners.delete(l); },
        },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('first run (migration)', () => {
    it('the devices in use inherit today\'s settings — nothing changes, everything is remembered', async () => {
        mem.set(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, micVolume: 140, speakerVolume: 80, noiseSuppressionMode: 'light' }));
        await mount();
        expect(hook.settings).toMatchObject({ micVolume: 140, speakerVolume: 80, noiseSuppressionMode: 'light' });
        const p = profiles();
        expect(p.input['microphone (realtek audio)'].settings).toMatchObject({ micVolume: 140, noiseSuppressionMode: 'light' });
        expect(p.output['speakers (realtek audio)'].settings).toMatchObject({ speakerVolume: 80 });
        expect(hook.deviceProfiles.activeInput).toMatchObject({ label: 'Microphone (Realtek Audio)', viaDefault: true });
        expect(hook.deviceProfiles.activeOutput).toMatchObject({ label: 'Speakers (Realtek Audio)', viaDefault: true });
    });
});

describe('plugging a headset in and out', () => {
    it('first plug-in inherits, later plug-ins (new deviceId, "(2- " label) bring the headset\'s own settings back', async () => {
        await mount();
        act(() => { hook.setSpeakerVolume(120); hook.setEchoCancellation(true); });
        await flush();
        expect(profiles().output['speakers (realtek audio)'].settings.speakerVolume).toBe(120);

        await plug(withHeadset(1)); // first time: inherits, nothing jumps
        expect(hook.settings).toMatchObject({ speakerVolume: 120, echoCancellation: true });
        expect(hook.deviceProfiles.activeOutput?.label).toBe('Headset Earphone (Arctis 7)');
        act(() => { hook.setSpeakerVolume(40); hook.setEchoCancellation(false); });
        await flush();

        await plug(SPEAKERS_ONLY); // unplugged: the speakers' settings come back
        expect(hook.settings).toMatchObject({ speakerVolume: 120, echoCancellation: true });

        await plug(withHeadset(2)); // back in, re-enumerated under new ids
        expect(hook.settings).toMatchObject({ speakerVolume: 40, echoCancellation: false });
        const p = profiles();
        expect(Object.keys(p.input).sort()).toEqual(['headset microphone (arctis 7)', 'microphone (realtek audio)']);
        expect(p.input['headset microphone (arctis 7)'].deviceId).toBe('id-a-mic-2');
    });

    it('picking a device explicitly (Settings / call menu) applies that device\'s settings', async () => {
        devices = withHeadset(1);
        await mount();
        act(() => { hook.setMicVolume(60); });
        await flush(200);
        act(() => { hook.setMicDeviceId('id-rt-mic', devices[1]); });
        await flush();
        expect(hook.deviceProfiles.activeInput).toMatchObject({ label: 'Microphone (Realtek Audio)', viaDefault: false });
        // first time this mic is used: it inherits (nothing jumps)...
        expect(hook.settings.micVolume).toBe(60);
        act(() => { hook.setMicVolume(90); });
        await flush(200);
        // ...back to following the default (the headset): its 60 returns...
        act(() => { hook.setMicDeviceId(''); });
        await flush();
        expect(hook.settings.micVolume).toBe(60);
        // ...and picking the Realtek mic again brings its own 90 back.
        act(() => { hook.setMicDeviceId('id-rt-mic', devices[1]); });
        await flush();
        expect(hook.settings.micVolume).toBe(90);
    });
});

describe('saving changes', () => {
    it('a change is saved for the device in use only, and global settings are never per device', async () => {
        devices = withHeadset(1);
        await mount();
        act(() => { hook.setVoiceGateThreshold(-30); hook.setPushToTalk(true); hook.setEqBand(2, 6); });
        await flush();
        const p = profiles();
        expect(p.input['headset microphone (arctis 7)'].settings).toMatchObject({ voiceGateThreshold: -30, eqBands: [0, 0, 6, 0, 0] });
        expect(p.input['headset microphone (arctis 7)'].settings).not.toHaveProperty('pushToTalk');
        await plug(SPEAKERS_ONLY);
        // Realtek mic is new → inherits the gate; push to talk stays on (global).
        expect(hook.settings).toMatchObject({ voiceGateThreshold: -30, pushToTalk: true });
        act(() => { hook.setVoiceGateThreshold(-50); });
        await flush();
        expect(profiles().input['headset microphone (arctis 7)'].settings.voiceGateThreshold).toBe(-30);
    });

    it('editing an UNPLUGGED device from the device list never touches the live settings', async () => {
        devices = withHeadset(1);
        await mount();
        await plug(SPEAKERS_ONLY);
        const live = { ...hook.settings };
        act(() => { hook.deviceProfiles.updateProfile('input', 'headset microphone (arctis 7)', { micVolume: 33 }); });
        await flush();
        expect(hook.settings).toEqual(live);
        expect(profiles().input['headset microphone (arctis 7)'].settings.micVolume).toBe(33);
        // ...and editing the device IN USE from the list applies live.
        act(() => { hook.deviceProfiles.updateProfile('output', 'speakers (realtek audio)', { speakerVolume: 150 }); });
        await flush();
        expect(hook.settings.speakerVolume).toBe(150);
    });

    it('forget removes a device that is not in use, and refuses the one in use', async () => {
        devices = withHeadset(1);
        await mount();
        await plug(SPEAKERS_ONLY);
        act(() => { hook.deviceProfiles.forget('input', 'microphone (realtek audio)'); });
        act(() => { hook.deviceProfiles.forget('input', 'headset microphone (arctis 7)'); });
        await flush();
        expect(Object.keys(profiles().input)).toEqual(['microphone (realtek audio)']);
        expect(hook.deviceProfiles.connected.input.has('microphone (realtek audio)')).toBe(true);
    });
});

describe('account readiness (secureLocalStore rebind)', () => {
    it('nothing is read or written until the account\'s records are loaded, then it loads', async () => {
        store.ready = new Set();
        await mount();
        expect(mem.has(audioDeviceProfilesKey(UID))).toBe(false);
        expect(hook.deviceProfiles.ready).toBe(false);
        act(() => { hook.setMicVolume(170); });
        await flush(200);
        expect(mem.has(audioDeviceProfilesKey(UID))).toBe(false);
        store.ready.add(UID);
        await act(async () => { store.resolveReady?.(); });
        await flush();
        expect(hook.deviceProfiles.ready).toBe(true);
        expect(profiles().input['microphone (realtek audio)'].settings.micVolume).toBe(170);
    });

    it('signed out (no user id): the settings work as before, no profiles', async () => {
        await mount(null);
        act(() => { hook.setMicVolume(150); });
        await flush(200);
        expect(hook.settings.micVolume).toBe(150);
        expect([...mem.keys()].some(k => k.startsWith('cipherline_audio_device_profiles_'))).toBe(false);
    });

    it('a loaded record is never written back on mount', async () => {
        devices = withHeadset(1);
        await mount();
        act(() => root.unmount());
        root = createRoot(host);
        const before = mem.get(audioDeviceProfilesKey(UID));
        const writes: string[] = [];
        const spy = vi.spyOn(mem, 'set').mockImplementation(function (this: Map<string, string>, k: string, v: string) {
            writes.push(k);
            return Map.prototype.set.call(this, k, v) as Map<string, string>;
        });
        await mount();
        spy.mockRestore();
        expect(writes).not.toContain(audioDeviceProfilesKey(UID));
        expect(mem.get(audioDeviceProfilesKey(UID))).toBe(before);
    });
});

describe('labels become readable later (permission granted after boot)', () => {
    it('a resync request after the first capture picks the devices up', async () => {
        devices = [dev('', '', ''), dev('', '', '', 'audiooutput')];
        await mount();
        expect(hook.deviceProfiles.activeInput).toBeNull();
        devices = SPEAKERS_ONLY;
        await act(async () => { requestAudioDeviceResync(); });
        await flush();
        expect(hook.deviceProfiles.activeInput?.label).toBe('Microphone (Realtek Audio)');
    });
});
