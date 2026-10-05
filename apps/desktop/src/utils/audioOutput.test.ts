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
    shouldAdoptOutputReroute,
} from './audioOutput';

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
const asEl = (e: ReturnType<typeof fakeElement>) => e as unknown as HTMLMediaElement;
const asCtx = (c: ReturnType<typeof fakeContext>) => c as unknown as AudioContext;

describe('audioOutput device routing', () => {
    beforeEach(() => {
        setOutputDeviceFailureHandler(null);
        onOutputDeviceChange(''); // back to the system default between cases
    });

    it('routes a device change to the AudioContext that actually plays the audio', () => {
        const ctx = fakeContext();
        registerOutputAudioContext(asCtx(ctx));

        onOutputDeviceChange('headphones-1');

        expect(ctx.setSinkId).toHaveBeenCalledWith('headphones-1');
        unregisterOutputAudioContext(asCtx(ctx));
    });

    it('routes a device change to attached elements AND contexts', () => {
        const el = fakeElement();
        const ctx = fakeContext();
        applyOutputDevice(asEl(el));
        registerOutputAudioContext(asCtx(ctx));

        onOutputDeviceChange('headphones-1');

        expect(el.setSinkId).toHaveBeenCalledWith('headphones-1');
        expect(ctx.setSinkId).toHaveBeenCalledWith('headphones-1');
        unregisterOutputDeviceTarget(asEl(el));
        unregisterOutputAudioContext(asCtx(ctx));
    });

    it('pushes "" (back to system default) to contexts, not just elements', () => {
        const ctx = fakeContext();
        registerOutputAudioContext(asCtx(ctx));
        onOutputDeviceChange('headphones-1');
        ctx.setSinkId.mockClear();

        onOutputDeviceChange('');

        // Returning early on '' would leave the context pinned to the previous
        // device — the output-side twin of the mic default-device bug.
        expect(ctx.setSinkId).toHaveBeenCalledWith('');
        unregisterOutputAudioContext(asCtx(ctx));
    });

    it('seeds a context registered after the device was chosen', () => {
        onOutputDeviceChange('headphones-1');
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

    it('stops routing to an unregistered context', () => {
        const ctx = fakeContext();
        registerOutputAudioContext(asCtx(ctx));
        unregisterOutputAudioContext(asCtx(ctx));

        onOutputDeviceChange('headphones-1');

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

        expect(failures).toHaveLength(2);
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
 * The regression these cover: SidebarConference adopted every LiveKit
 * `ActiveDeviceChanged('audiooutput', …)` as the new speaker setting. Because
 * this app never calls `switchActiveDevice('audiooutput', …)`, livekit-client's
 * activeDeviceMap is stuck on 'default' and its selectDefaultDevices() emits
 * that event on ANY device change, believing we're following the OS default —
 * so plugging in a headset silently overwrote an explicit speaker choice, at
 * precisely the moment a user is likely to be making one.
 *
 * The one case that must still be adopted is the one the handler was written
 * for: the picked device is genuinely gone.
 */
const out = (deviceId: string, label: string) =>
    ({ deviceId, label, kind: 'audiooutput', groupId: 'g' } as MediaDeviceInfo);

const HEADSET = out('headset-1', 'USB Headset');
const SPEAKERS = out('speakers-1', 'Desktop Speakers');

describe('shouldAdoptOutputReroute', () => {
    it('does NOT stomp an explicit pick that is still available', () => {
        // The bug, stated directly: user picked the headset, the OS default
        // moved to the speakers, LiveKit says "the default is speakers-1 now".
        // Their explicit choice still exists and must win.
        expect(shouldAdoptOutputReroute('headset-1', 'speakers-1', [HEADSET, SPEAKERS])).toBe(false);
    });

    it('DOES adopt the reroute once the explicit pick has disappeared', () => {
        // Positive control for the case above — same explicit pick, same event,
        // the only difference is that the headset is no longer enumerated. If
        // this returned false the guard would be over-broad and would reintroduce
        // the stale-device split-brain it replaced.
        expect(shouldAdoptOutputReroute('headset-1', 'speakers-1', [SPEAKERS])).toBe(true);
    });

    it('never converts "follow the system default" into a pin', () => {
        // '' means follow the default; the browser already does that. Adopting
        // a concrete id here silently pinned the user to whatever happened to
        // be default at that instant.
        expect(shouldAdoptOutputReroute('', 'speakers-1', [HEADSET, SPEAKERS])).toBe(false);
    });

    it('ignores an event that reports the device we are already on', () => {
        expect(shouldAdoptOutputReroute('headset-1', 'headset-1', [HEADSET, SPEAKERS])).toBe(false);
    });

    it('refuses to act on the pre-permission placeholder list', () => {
        // One blank entry per kind. Concluding "your device vanished" from that
        // would drop the user off a perfectly live device.
        expect(shouldAdoptOutputReroute('headset-1', 'speakers-1', [out('', '')])).toBe(false);
    });

    it('refuses to act on an empty enumeration', () => {
        expect(shouldAdoptOutputReroute('headset-1', 'speakers-1', [])).toBe(false);
    });

    it('adopts a reroute back to the system default when the pick is gone', () => {
        // LiveKit can hand us the literal 'default' id rather than a concrete
        // one; the pick being absent is what matters, not what replaces it.
        expect(shouldAdoptOutputReroute('headset-1', 'default', [SPEAKERS])).toBe(true);
    });
});
