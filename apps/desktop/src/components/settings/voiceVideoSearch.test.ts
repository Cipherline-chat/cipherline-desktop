// @vitest-environment jsdom
/**
 * Voice & Video, rendered for real: every setting the settings search indexes
 * for this pane is on the page and the search can land on it (open its fold,
 * flash its row); every explanation sits behind an "About <setting>" info
 * button; the one-control noise suppression writes the same two settings the
 * old switch + engine picker did; and opening the pane never turns the camera on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// jsdom has no matchMedia; the kit reads it at import time (clPhysics).
vi.hoisted(() => {
    if (!window.matchMedia) {
        window.matchMedia = ((q: string) => ({
            matches: false, media: q, onchange: null,
            addListener: () => {}, removeListener: () => {},
            addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
});

const mem = new Map<string, string>();
vi.mock('../../utils/secureLocalStore', () => {
    const store = {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
        removeItem: (k: string) => { mem.delete(k); },
    };
    return { secureLocalStore: store, default: store };
});
// Call-audio plumbing the pane imports but a DOM test has no use for.
vi.mock('../../hooks/useParticipantAudio', () => ({ setMasterVolume: () => {} }));
vi.mock('../../utils/voiceProcessor', () => ({ CipherlineVoiceProcessor: class {} }));
vi.mock('../../utils/notificationSounds', () => ({ testSpeakers: async () => ({}), DEFAULT_SOUNDS: { message: '' } }));

import { VoiceVideoSettings } from '../VoiceVideoSettings';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings, type VoiceSettingsHook } from '../../hooks/useVoiceSettings';
import { SETTINGS_INDEX } from './settingsSearchIndex';
import { findSettingTarget, revealSetting } from './revealSetting';
import { __resetDisclosureCache } from './settingsDisclosureStore';
import { __resetGamingVideoModeForTests, GAMING_VIDEO_LABEL } from '../../utils/gamingVideoMode';
import { pickProfileSettings, type DeviceProfiles } from '../../utils/audioDeviceProfiles';
import type { AudioDeviceProfilesApi } from '../../hooks/useAudioDeviceProfiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getUserMedia = vi.fn(async (_c: MediaStreamConstraints): Promise<MediaStream> => { throw new Error('no devices in jsdom'); });

/** Per-device profiles as the hook would hand them over: a headset in use (as
 *  the system default) both ways, a USB mic plugged in, a Yeti unplugged. */
function fakeProfiles(): { api: AudioDeviceProfilesApi; updates: unknown[][]; forgets: unknown[][] } {
    const updates: unknown[][] = [];
    const forgets: unknown[][] = [];
    const inS = pickProfileSettings('input', DEFAULT_VOICE_SETTINGS);
    const outS = pickProfileSettings('output', DEFAULT_VOICE_SETTINGS);
    const now = Date.now();
    const profiles: DeviceProfiles = {
        v: 1,
        input: {
            'headset microphone (arctis 7)': { label: 'Headset Microphone (Arctis 7)', deviceId: 'a', groupId: 'g', lastUsedAt: now, settings: inS },
            'microphone (shure mv7)': { label: 'Microphone (Shure MV7)', deviceId: 'm', groupId: 'gm', lastUsedAt: now - 2 * 86400000, settings: { ...inS, micVolume: 140 } },
            'yeti': { label: 'Yeti', deviceId: 'y', groupId: 'gy', lastUsedAt: now - 9 * 86400000, settings: { ...inS, echoCancellation: true } },
        },
        output: {
            'headset earphone (arctis 7)': { label: 'Headset Earphone (Arctis 7)', deviceId: 'o', groupId: 'g', lastUsedAt: now, settings: outS },
        },
    };
    const api: AudioDeviceProfilesApi = {
        ready: true,
        profiles,
        activeInput: { key: 'headset microphone (arctis 7)', label: 'Headset Microphone (Arctis 7)', viaDefault: true },
        activeOutput: { key: 'headset earphone (arctis 7)', label: 'Headset Earphone (Arctis 7)', viaDefault: true },
        connected: { input: new Set(['headset microphone (arctis 7)', 'microphone (shure mv7)']), output: new Set(['headset earphone (arctis 7)']) },
        updateProfile: (...a: unknown[]) => { updates.push(a); },
        forget: (...a: unknown[]) => { forgets.push(a); },
    };
    return { api, updates, forgets };
}

function fakeVoice(overrides: Partial<VoiceSettings> = {}, deviceProfiles: AudioDeviceProfilesApi = fakeProfiles().api) {
    const calls: Record<string, unknown[][]> = {};
    const settings = { ...DEFAULT_VOICE_SETTINGS, ...overrides };
    const voice = new Proxy({ settings, deviceProfiles } as Record<string, unknown>, {
        get(t, prop: string) {
            if (prop in t) return t[prop];
            // every setter / reset: record the call
            return (...args: unknown[]) => { (calls[prop] ??= []).push(args); };
        },
    }) as unknown as VoiceSettingsHook;
    return { voice, calls };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    mem.clear();
    __resetDisclosureCache();
    __resetGamingVideoModeForTests();
    getUserMedia.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
            enumerateDevices: async () => [],
            getUserMedia,
            addEventListener: () => {},
            removeEventListener: () => {},
        },
    });
    // A main process that knows the startup flags, so the "while gaming" row renders.
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        getStartupFlags: async () => ({ platform: 'win32', saved: {}, active: {} }),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.restoreAllMocks();
});

async function renderPane(overrides: Partial<VoiceSettings> = {}, profiles?: AudioDeviceProfilesApi) {
    const fake = fakeVoice(overrides, profiles);
    await act(async () => { root.render(React.createElement(VoiceVideoSettings, { voice: fake.voice })); });
    // let the startup-flags load and the device enumeration settle
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return fake;
}

describe('Voice & Video: the settings search lands on every setting', () => {
    it('renders the gaming row (so the index entry below is meaningful)', async () => {
        await renderPane();
        expect(host.textContent).toContain(GAMING_VIDEO_LABEL);
    });

    it.each(SETTINGS_INDEX.voice.map(e => e.label))('"%s" resolves to a row or fold on the pane', async (label) => {
        await renderPane();
        const found = findSettingTarget(host, label);
        expect(found, `search label "${label}" finds nothing on the Voice & Video pane`).not.toBeNull();
        // a row, a fold, or a card's own title (Your audio devices is a whole card)
        expect(found!.target.closest('.vv-row, .sx-disc, .vv-head'), `"${label}" is not inside a settings row, fold or card title`).not.toBeNull();
    });

    it('a setting folded away (Mic EQ) is revealed: the fold opens and the row flashes', async () => {
        await renderPane();
        const fold = host.querySelector('[data-disclosure="voice.mic-eq"]') as HTMLElement;
        expect(fold.getAttribute('data-open')).toBe('false');
        let ok = false;
        act(() => { ok = revealSetting(host, 'Mic EQ', fn => fn()); });
        expect(ok).toBe(true);
        expect(fold.getAttribute('data-open')).toBe('true');
        const row = Array.from(host.querySelectorAll('.vv-row')).find(r => r.querySelector('b')?.textContent === 'Mic EQ')!;
        expect(row.classList.contains('sx-flash')).toBe(true);
    });

    it('"Camera adjustments" (old name) still opens Picture adjustments', async () => {
        await renderPane();
        const fold = host.querySelector('[data-disclosure="voice.picture"]') as HTMLElement;
        act(() => { revealSetting(host, 'Camera adjustments', fn => fn()); });
        expect(fold.getAttribute('data-open')).toBe('true');
        expect(fold.textContent).toContain('Brightness');
    });

    it('only expert tuning is folded: everyday settings are visible without opening anything', async () => {
        await renderPane();
        const folded = new Set(Array.from(host.querySelectorAll('.sx-disc-body .vv-row b')).map(b => b.textContent));
        expect([...folded].sort()).toEqual(['Audio health', 'Brightness', 'Contrast', 'Mic EQ', 'Saturation']);
        for (const visible of ['Microphone', 'Input volume', 'Mic test', 'Noise suppression', 'Voice gate', 'Push to talk',
            'Echo cancellation', 'Auto gain control', 'Speakers', 'Output volume', 'Normalize voice volume', 'Camera',
            'Camera quality', 'Incoming video quality', GAMING_VIDEO_LABEL]) {
            const b = Array.from(host.querySelectorAll('.vv-row b')).find(x => x.textContent === visible);
            expect(b, visible).toBeTruthy();
            expect(b!.closest('.sx-disc-body'), `${visible} should not be folded`).toBeNull();
        }
    });
});

describe('Voice & Video: explanations live behind the "i"', () => {
    it('every setting with a longer explanation has an "About <setting>" button and no inline paragraph', async () => {
        await renderPane();
        const names = Array.from(host.querySelectorAll('button.vv-info')).map(b => b.getAttribute('aria-label'));
        expect(names.sort()).toEqual([
            'About Audio health', 'About Auto gain control', 'About Camera', 'About Camera quality',
            'About Echo cancellation', 'About Incoming video quality', 'About Input volume', 'About Mic EQ', 'About Mic test',
            'About Noise suppression', 'About Normalize voice volume', 'About Output volume', `About ${GAMING_VIDEO_LABEL}`,
            'About Push to talk', 'About Voice gate', 'About Your audio devices',
        ].sort());
        // the old long inline descriptions are gone from the page itself
        expect(host.textContent).not.toContain('Stops others from hearing themselves');
        expect(host.textContent).not.toContain('Evens out how loud each person sounds');
    });

    it('Echo cancellation says "speakers only" on the page AND in its "i"', async () => {
        await renderPane();
        const NOTE = 'Only recommended when using speakers — leave it off with headphones.';
        const row = Array.from(host.querySelectorAll('.vv-row')).find(r => r.querySelector('b')?.textContent === 'Echo cancellation')!;
        expect(row.querySelector('.vv-rnote')!.textContent).toBe(NOTE);
        const b = row.querySelector('button[aria-label="About Echo cancellation"]') as HTMLButtonElement;
        act(() => { b.click(); });
        const tip = document.getElementById(b.getAttribute('aria-describedby')!)!;
        expect(tip.getAttribute('role')).toBe('tooltip');
        expect(tip.textContent).toContain(NOTE);
        expect(tip.textContent).toContain('Remembered per microphone');
        act(() => { b.click(); });
    });
});

describe('Voice & Video: noise suppression as one Off / Light / Strong control', () => {
    // The main control (the device editor below has its own copy, closed by default).
    const seg = (label: string) => Array.from(host.querySelectorAll('.vv-card .vv-row--block .vv-ns button'))
        .find(b => b.querySelector('b')?.textContent === label) as HTMLButtonElement;

    it('reflects the two stored settings', async () => {
        await renderPane({ noiseSuppression: true, noiseSuppressionMode: 'light' });
        expect(seg('Light').getAttribute('aria-checked')).toBe('true');
        expect(seg('Strong').getAttribute('aria-checked')).toBe('false');
        act(() => root.unmount());
        root = createRoot(host);
        await renderPane({ noiseSuppression: false, noiseSuppressionMode: 'strong' });
        expect(seg('Off').getAttribute('aria-checked')).toBe('true');
    });

    it('uses the Update channel option cards (same component, same classes), in a radiogroup', async () => {
        await renderPane();
        const group = host.querySelector('.vv-ns')!;
        expect(group.classList.contains('sd-opts')).toBe(true);
        expect(group.getAttribute('role')).toBe('radiogroup');
        const cards = Array.from(group.querySelectorAll('button'));
        expect(cards.map(c => c.querySelector('b')!.textContent)).toEqual(['Off', 'Light', 'Strong']);
        for (const c of cards) {
            expect(c.className).toMatch(/^sd-opt( sd-on)?$/);
            expect(c.getAttribute('role')).toBe('radio');
        }
    });

    it('each card says what it removes and its measured delay; one line under them says how Light and Strong differ', async () => {
        await renderPane();
        expect(seg('Light').textContent).toContain('Steady hum and fans');
        expect(seg('Light').textContent!.replace(/\u00a0/g, ' ')).toContain('Adds 2.7 ms');
        expect(seg('Strong').textContent).toContain('keyboard clacks');
        expect(seg('Strong').textContent!.replace(/\u00a0/g, ' ')).toContain('Adds 39 ms');
        const line = host.querySelector('[data-testid="ns-difference"]')!.textContent!;
        expect(line).toContain('Light only removes steady noise');
        expect(line).toContain('Strong is an AI model');
        expect(line).toContain('39 ms');
        // and the fuller version is in the "i": the engines by name, what each removes, the honest limit
        const b = host.querySelector('button[aria-label="About Noise suppression"]') as HTMLButtonElement;
        act(() => { b.click(); });
        const tip = document.getElementById(b.getAttribute('aria-describedby')!)!.textContent!;
        expect(tip).toContain('Speex, adds 2.7 ms');
        expect(tip).toContain('RNNoise');
        expect(tip).toContain('adds 39 ms');
        expect(tip).toContain('keyboard clacks');
        expect(tip).toContain('Neither removes other people talking near you');
        act(() => { b.click(); });
    });

    it('Off only switches suppression off (the engine choice is kept)', async () => {
        const { calls } = await renderPane({ noiseSuppression: true, noiseSuppressionMode: 'strong' });
        act(() => { seg('Off').click(); });
        expect(calls.setNoiseSuppression).toEqual([[false]]);
        expect(calls.setNoiseSuppressionMode).toBeUndefined();
    });

    it('picking an engine while off sets the engine AND switches suppression on', async () => {
        const { calls } = await renderPane({ noiseSuppression: false, noiseSuppressionMode: 'strong' });
        act(() => { seg('Light').click(); });
        expect(calls.setNoiseSuppressionMode).toEqual([['light']]);
        expect(calls.setNoiseSuppression).toEqual([[true]]);
    });

    it('switching engine while on leaves the on/off setting alone', async () => {
        const { calls } = await renderPane({ noiseSuppression: true, noiseSuppressionMode: 'light' });
        act(() => { seg('Strong').click(); });
        expect(calls.setNoiseSuppressionMode).toEqual([['strong']]);
        expect(calls.setNoiseSuppression).toBeUndefined();
    });
});

describe('Voice & Video: the camera stays off until asked', () => {
    it('rendering the pane opens the microphone preview only, never the camera', async () => {
        await renderPane();
        expect(getUserMedia).toHaveBeenCalled();
        for (const [c] of getUserMedia.mock.calls) expect(c.video).toBeFalsy();
        expect(host.querySelector('video')).toBeNull();
    });
});

describe('Voice & Video: no control was lost in the redesigns', () => {
    it('Output sits right after Input again, and keeps every output control', async () => {
        await renderPane();
        const titles = Array.from(host.querySelectorAll('.vv-card h3')).map(h => h.textContent);
        expect(titles.slice(0, 3)).toEqual(['Input', 'Output', 'Voice processing']);
        const out = Array.from(host.querySelectorAll('.vv-card')).find(c => c.querySelector('h3')?.textContent === 'Output')!;
        expect(out.querySelector('[aria-label="Speakers"]')).not.toBeNull();
        expect(Array.from(out.querySelectorAll('.vv-row b')).map(b => b.textContent)).toEqual(['Speakers', 'Output volume', 'Normalize voice volume']);
        expect(out.textContent).toContain('Test speakers');
    });
});

describe('Voice & Video: settings remembered per device', () => {
    it('Input, Output and Voice processing say which device they are saving for', async () => {
        await renderPane();
        const chips = Array.from(host.querySelectorAll('.vv-for'));
        expect(chips.map(c => c.closest('.vv-card')!.querySelector('h3')!.textContent)).toEqual(['Input', 'Output', 'Voice processing']);
        expect(host.querySelector('[data-testid="saving-for-mic"]')!.textContent).toBe('Saving forHeadset Microphone (Arctis 7)default');
        expect(host.querySelector('[data-testid="saving-for-output"]')!.textContent).toContain('Headset Earphone (Arctis 7)');
    });

    it('no chip and no device list before the devices are known (signed out / before permission)', async () => {
        const api = { ...fakeProfiles().api, ready: false, profiles: null, activeInput: null, activeOutput: null };
        await renderPane({}, api);
        expect(host.querySelector('.vv-for')).toBeNull();
        expect(host.textContent).not.toContain('Your audio devices');
    });

    it('lists remembered devices with their state, in use first, unplugged ones too', async () => {
        await renderPane();
        const rows = Array.from(host.querySelectorAll('.vv-dev[data-device-kind="input"] .vv-dev-txt')).map(r => r.textContent);
        expect(rows[0]).toBe('Headset Microphone (Arctis 7)In use · system default');
        expect(rows[1]).toMatch(/^Microphone \(Shure MV7\)Plugged in · Used 2 days ago$/);
        expect(rows[2]).toMatch(/^YetiNot plugged in · Used 9 days ago$/);
    });

    it('an unplugged device can be opened and edited; the edit goes to THAT device', async () => {
        const fake = fakeProfiles();
        await renderPane({}, fake.api);
        const yeti = Array.from(host.querySelectorAll('.vv-dev')).find(r => r.textContent!.includes('Yeti'))!;
        act(() => { (yeti.querySelector('.vv-dev-main') as HTMLButtonElement).click(); });
        const edit = yeti.querySelector('.vv-dev-edit')!;
        expect(edit).not.toBeNull();
        const echo = edit.querySelector('[aria-label="Echo cancellation"] [role="switch"], [aria-label="Echo cancellation"][role="switch"], button[aria-label="Echo cancellation"], input[aria-label="Echo cancellation"]') as HTMLElement;
        act(() => { echo.click(); });
        const strong = Array.from(edit.querySelectorAll('.vv-ns button')).find(b => b.querySelector('b')?.textContent === 'Light') as HTMLButtonElement;
        act(() => { strong.click(); });
        expect(fake.updates).toEqual([
            ['input', 'yeti', { echoCancellation: false }],
            ['input', 'yeti', { noiseSuppressionMode: 'light' }],
        ]);
    });

    it('Forget asks first, and is not offered for the device in use', async () => {
        const fake = fakeProfiles();
        await renderPane({}, fake.api);
        const open = (txt: string) => {
            const row = Array.from(host.querySelectorAll('.vv-dev')).find(r => r.textContent!.includes(txt))!;
            act(() => { (row.querySelector('.vv-dev-main') as HTMLButtonElement).click(); });
            return row;
        };
        const inUse = open('Headset Microphone');
        const forgetInUse = Array.from(inUse.querySelectorAll('button')).find(b => b.textContent === 'Forget device') as HTMLButtonElement;
        expect(forgetInUse.disabled).toBe(true);
        const yeti = open('Yeti');
        const forget = Array.from(yeti.querySelectorAll('button')).find(b => b.textContent === 'Forget device') as HTMLButtonElement;
        act(() => { forget.click(); });
        expect(fake.forgets).toEqual([]);
        const confirm = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Forget') as HTMLButtonElement;
        act(() => { confirm.click(); });
        expect(fake.forgets).toEqual([['input', 'yeti']]);
    });
});
