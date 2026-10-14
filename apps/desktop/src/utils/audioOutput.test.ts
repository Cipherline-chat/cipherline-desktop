import { describe, it, expect, beforeEach, vi } from 'vitest';

// secureLocalStore is a synchronous facade over AES-GCM IndexedDB that is
// hydrated at app boot; unhydrated (as here) every read returns null. Swap in
// a plain map so these cases exercise the routing, not the store.
vi.mock('./secureLocalStore', () => {
    const mem = new Map<string, string>();
    return {
        default: {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => { mem.set(k, v); },
            removeItem: (k: string) => { mem.delete(k); },
        },
    };
});

import {
    applyOutputDevice,
    unregisterOutputDeviceTarget,
    registerOutputAudioContext,
    unregisterOutputAudioContext,
    onOutputDeviceChange,
    getOutputDevice,
    setOutputDeviceFailureHandler,
    setOutputDeviceFallbackHandler,
    refreshOutputDevices,
    reapplyOutputDevice,
    __resetOutputRoutingForTests,
} from './audioOutput';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The regression these cover: call audio is played through Web Audio, not
 * through the <audio> elements we attach (those are muted — see
 * useParticipantAudio.buildMicInternals). Routing only the elements meant
 * picking an output device moved silence to the new device and left every
 * voice in the call on the system default. The AudioContext expectations
 * below are the ones that fail without the fix.
 */

// Minimal stand-ins — vitest runs in the node environment here, so there is no
// DOM and no Web Audio. Only the one method each side of the fix calls matters.
function fakeElement() {
    return { setSinkId: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()) };
}
function fakeContext() {
    return { setSinkId: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()) };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const asEl = (e: ReturnType<typeof fakeElement>) => e as unknown as HTMLMediaElement;
const asCtx = (c: ReturnType<typeof fakeContext>) => c as unknown as AudioContext;

describe('audioOutput device routing', () => {
    beforeEach(() => {
        setOutputDeviceFailureHandler(null);
        onOutputDeviceChange(''); // back to the system default between cases
    });

    it('routes a device change to the AudioContext that actually plays the audio', async () => {
        const ctx = fakeContext();
        registerOutputAudioContext(asCtx(ctx));

        onOutputDeviceChange('headphones-1');
        await flush();

        expect(ctx.setSinkId).toHaveBeenCalledWith('headphones-1');
        unregisterOutputAudioContext(asCtx(ctx));
    });

    it('routes a device change to attached elements AND contexts', async () => {
        const el = fakeElement();
        const ctx = fakeContext();
        applyOutputDevice(asEl(el));
        registerOutputAudioContext(asCtx(ctx));

        onOutputDeviceChange('headphones-1');
        await flush();

        expect(el.setSinkId).toHaveBeenCalledWith('headphones-1');
        expect(ctx.setSinkId).toHaveBeenCalledWith('headphones-1');
        unregisterOutputDeviceTarget(asEl(el));
        unregisterOutputAudioContext(asCtx(ctx));
    });

    it('pushes "" (back to system default) to contexts, not just elements', async () => {
        const ctx = fakeContext();
        registerOutputAudioContext(asCtx(ctx));
        onOutputDeviceChange('headphones-1');
        await flush();
        ctx.setSinkId.mockClear();

        onOutputDeviceChange('');
        await flush();

        // Returning early on '' would leave the context pinned to the previous
        // device — the output-side twin of the mic default-device bug.
        expect(ctx.setSinkId).toHaveBeenCalledWith('');
        unregisterOutputAudioContext(asCtx(ctx));
    });

    it('seeds a context registered after the device was chosen', async () => {
        onOutputDeviceChange('headphones-1');
        await flush();
        const ctx = fakeContext();

        registerOutputAudioContext(asCtx(ctx));

        // A context built mid-call (first remote participant joining after the
        // pick) must not come up on the system default.
        expect(ctx.setSinkId).toHaveBeenCalledWith('headphones-1');
        expect(getOutputDevice()).toBe('headphones-1');
        unregisterOutputAudioContext(asCtx(ctx));
    });

    it('does not call setSinkId when a fresh context is already on the default', () => {
        const ctx = fakeContext();
        registerOutputAudioContext(asCtx(ctx));
        expect(ctx.setSinkId).not.toHaveBeenCalled();
        unregisterOutputAudioContext(asCtx(ctx));
    });

    it('stops routing to an unregistered context', async () => {
        const ctx = fakeContext();
        registerOutputAudioContext(asCtx(ctx));
        unregisterOutputAudioContext(asCtx(ctx));

        onOutputDeviceChange('headphones-1');
        await flush();

        expect(ctx.setSinkId).not.toHaveBeenCalled();
    });

    it('reports a context sink failure instead of throwing through the caller', async () => {
        const failures: unknown[] = [];
        setOutputDeviceFailureHandler(err => failures.push(err));
        const rejecting = { setSinkId: vi.fn(() => Promise.reject(new Error('device gone'))) };
        const throwing = { setSinkId: vi.fn(() => { throw new TypeError('unknown sink'); }) };
        registerOutputAudioContext(rejecting as unknown as AudioContext);
        registerOutputAudioContext(throwing as unknown as AudioContext);

        expect(() => onOutputDeviceChange('gone-1')).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();

        // Two targets failed, ONE notice: a bad id fails every routed target at
        // once, and the toast used to fire per element.
        expect(failures).toHaveLength(1);
        unregisterOutputAudioContext(rejecting as unknown as AudioContext);
        unregisterOutputAudioContext(throwing as unknown as AudioContext);
    });

    it('tolerates a context without setSinkId (pre-Chromium-110)', () => {
        const old = {} as unknown as AudioContext;
        registerOutputAudioContext(old);
        expect(() => onOutputDeviceChange('headphones-1')).not.toThrow();
        unregisterOutputAudioContext(old);
    });
});

/**
 * The output pick against a changing device list: refreshOutputDevices() runs
 * at startup and on every devicechange (useVoiceSettings).
 *
 * The regression these cover: SidebarConference used to ADOPT livekit-client's
 * `ActiveDeviceChanged('audiooutput', …)` as the new setting once the pick
 * looked gone — LiveKit reports the literal 'default' when the OS default moves,
 * which is what happens when a Bluetooth headset drops — so the explicit pick
 * was overwritten and never came back when the headset did. Now the pick is
 * kept, the audio falls back to the default while it is absent (one notice),
 * and returns to the pick when it is back.
 */
const out = (deviceId: string, label: string, groupId = `grp-${deviceId}`) =>
    ({ deviceId, label, kind: 'audiooutput', groupId } as MediaDeviceInfo);

const DEFAULT_ROW = out('default', 'Default - Desktop Speakers', 'grp-speakers-1');
const HEADSET = out('headset-1', 'USB Headset');
const SPEAKERS = out('speakers-1', 'Desktop Speakers');

describe('refreshOutputDevices — pick present / absent / back', () => {
    beforeEach(() => {
        __resetOutputRoutingForTests();
        onOutputDeviceChange('');
    });

    it('routes every element AND context — including ones created later — to the pick', async () => {
        const before = fakeElement();
        const ctx = fakeContext();
        applyOutputDevice(asEl(before));
        registerOutputAudioContext(asCtx(ctx));
        onOutputDeviceChange('headset-1', { label: 'USB Headset', groupId: 'grp-headset-1' });
        await flush();
        refreshOutputDevices([DEFAULT_ROW, HEADSET, SPEAKERS]);
        await flush();
        expect(before.setSinkId).toHaveBeenLastCalledWith('headset-1');
        expect(ctx.setSinkId).toHaveBeenLastCalledWith('headset-1');

        // Created AFTER the selection (a new participant, a chain rebuild, the
        // ringback, the Settings monitor): routed at birth.
        const late = fakeElement();
        applyOutputDevice(asEl(late));
        const lateCtx = fakeContext();
        registerOutputAudioContext(asCtx(lateCtx));
        expect(late.setSinkId).toHaveBeenCalledWith('headset-1');
        expect(lateCtx.setSinkId).toHaveBeenCalledWith('headset-1');
    });

    it('pick unplugged → system default for everything, ONE notice, and the pick is kept', async () => {
        const el = fakeElement();
        applyOutputDevice(asEl(el));
        const notice = vi.fn();
        setOutputDeviceFallbackHandler(notice);
        onOutputDeviceChange('headset-1', { label: 'USB Headset', groupId: 'grp-headset-1' });
        await flush();

        refreshOutputDevices([DEFAULT_ROW, SPEAKERS]);
        await flush();
        expect(el.setSinkId).toHaveBeenLastCalledWith('');
        expect(getOutputDevice()).toBe('');
        expect(notice).toHaveBeenCalledTimes(1);

        // The device-change storm that follows must not repeat the notice.
        refreshOutputDevices([DEFAULT_ROW, SPEAKERS]);
        await flush();
        refreshOutputDevices([DEFAULT_ROW, SPEAKERS]);
        await flush();
        expect(notice).toHaveBeenCalledTimes(1);

        // The NEXT element (someone joins while the headset is off) goes to the
        // default too, not to a dead id.
        const late = fakeElement();
        applyOutputDevice(asEl(late));
        expect(late.setSinkId).not.toHaveBeenCalled(); // '' = a fresh element is already on the default
    });

    it('pick plugged back in → routed to it again (the setting was never overwritten)', async () => {
        const el = fakeElement();
        applyOutputDevice(asEl(el));
        onOutputDeviceChange('headset-1', { label: 'USB Headset', groupId: 'grp-headset-1' });
        await flush();
        refreshOutputDevices([DEFAULT_ROW, SPEAKERS]);
        await flush();
        expect(el.setSinkId).toHaveBeenLastCalledWith('');

        refreshOutputDevices([DEFAULT_ROW, HEADSET, SPEAKERS]);
        await flush();
        expect(el.setSinkId).toHaveBeenLastCalledWith('headset-1');
        expect(getOutputDevice()).toBe('headset-1');
    });

    it('a notice handler registered while the pick is ALREADY gone fires once (unplugged before the call)', async () => {
        onOutputDeviceChange('headset-1', { label: 'USB Headset' });
        await flush();
        refreshOutputDevices([DEFAULT_ROW, SPEAKERS]);
        await flush();
        const notice = vi.fn();
        setOutputDeviceFallbackHandler(notice);
        expect(notice).toHaveBeenCalledTimes(1);
        setOutputDeviceFallbackHandler(null);
        setOutputDeviceFallbackHandler(notice);
        expect(notice).toHaveBeenCalledTimes(1);
    });

    it('a stale id (Windows re-enumerated the headset) is followed to the same device by groupId+label', async () => {
        const el = fakeElement();
        applyOutputDevice(asEl(el));
        const notice = vi.fn();
        setOutputDeviceFallbackHandler(notice);
        onOutputDeviceChange('headset-OLD', { label: 'USB Headset', groupId: 'grp-headset-1' });
        await flush();
        refreshOutputDevices([DEFAULT_ROW, HEADSET, SPEAKERS]);
        await flush();
        expect(el.setSinkId).toHaveBeenLastCalledWith('headset-1');
        expect(notice).not.toHaveBeenCalled();
    });

    it('following the system default is never "missing" and never notifies', async () => {
        const notice = vi.fn();
        setOutputDeviceFallbackHandler(notice);
        onOutputDeviceChange('');
        await flush();
        refreshOutputDevices([DEFAULT_ROW, SPEAKERS]);
        await flush();
        refreshOutputDevices([DEFAULT_ROW]);
        await flush();
        expect(notice).not.toHaveBeenCalled();
        expect(getOutputDevice()).toBe('');
    });

    it('refuses to act on the pre-permission placeholder list or an empty enumeration', async () => {
        const el = fakeElement();
        applyOutputDevice(asEl(el));
        onOutputDeviceChange('headset-1');
        await flush();
        el.setSinkId.mockClear();
        refreshOutputDevices([out('', '')]);
        await flush();
        refreshOutputDevices([]);
        await flush();
        expect(el.setSinkId).not.toHaveBeenCalled();
        expect(getOutputDevice()).toBe('headset-1');
    });

    it('reapplyOutputDevice undoes a livekit-client reroute of the attached elements', async () => {
        const el = fakeElement();
        applyOutputDevice(asEl(el));
        onOutputDeviceChange('headset-1');
        await flush();
        // livekit's selectDefaultDevices → switchActiveDevice('audiooutput', x)
        // → RemoteAudioTrack.setSinkId on every attached element:
        void el.setSinkId('speakers-1');
        reapplyOutputDevice();
        await flush();
        expect(el.setSinkId).toHaveBeenLastCalledWith('headset-1');
    });
});

/** Source pins for the wiring that has no unit seam (React components). */
describe('output routing wiring (source pins)', () => {
    const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

    it('the speaker setting is applied for the whole session from useVoiceSettings, with its device hint', () => {
        const src = read('../hooks/useVoiceSettings.ts');
        expect(src).toMatch(/onOutputDeviceChange\(speakerDeviceId, \{ label: speakerDeviceLabel, groupId: speakerDeviceGroupId \}\)/);
        expect(src).toMatch(/addEventListener\('devicechange', resyncOutputDevices\)/);
    });

    it('SidebarConference no longer adopts LiveKit output reroutes as the setting — it re-applies ours', () => {
        const src = read('../components/SidebarConference.tsx');
        expect(src).not.toMatch(/setSpeakerDeviceId\(/);
        expect(src).not.toMatch(/onOutputDeviceChange\(/);
        expect(src).toMatch(/if \(kind === 'audiooutput'\) reapplyOutputDevice\(\)/);
    });
});
