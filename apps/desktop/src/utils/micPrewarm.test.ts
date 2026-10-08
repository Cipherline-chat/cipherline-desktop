import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The warm-up capture must never outlive the join it serves. These pin every
 * way it ends, against a fake getUserMedia (vitest runs in node).
 */
type FakeTrack = { stop: ReturnType<typeof vi.fn>; stopped: boolean };

function installFakeMedia(delayMs = 0) {
    const tracks: FakeTrack[] = [];
    const calls: MediaStreamConstraints[] = [];
    const getUserMedia = vi.fn((c: MediaStreamConstraints) => {
        calls.push(c);
        const t: FakeTrack = { stopped: false, stop: vi.fn(() => { t.stopped = true; }) };
        tracks.push(t);
        const stream = { getTracks: () => [t] } as unknown as MediaStream;
        return new Promise<MediaStream>(res => setTimeout(() => res(stream), delayMs));
    });
    Object.defineProperty(globalThis, 'navigator', {
        value: { mediaDevices: { getUserMedia } },
        configurable: true,
        writable: true,
    });
    return { tracks, calls, getUserMedia };
}

let mod: typeof import('./micPrewarm');

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mod = await import('./micPrewarm');
});
afterEach(() => {
    mod.releaseMicPrewarm();
    vi.useRealTimers();
});

describe('micPrewarm', () => {
    it('opens the call device with the call constraints, once', async () => {
        const { calls, getUserMedia } = installFakeMedia();
        mod.prewarmMic('default');
        mod.prewarmMic('default'); // second click while warm/in flight → no second capture
        await vi.advanceTimersByTimeAsync(1);
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        const audio = calls[0].audio as MediaTrackConstraints;
        expect(audio.deviceId).toBe('default');
        expect(audio.echoCancellation).toBe(false); // same processing as the call (MIC_CAPTURE_CONSTRAINTS)
        expect(mod.__micPrewarmStateForTests().open).toBe(true);
    });

    it('release stops the warm capture (call mic published / join ended)', async () => {
        const { tracks } = installFakeMedia();
        mod.prewarmMic('default');
        await vi.advanceTimersByTimeAsync(1);
        mod.releaseMicPrewarm();
        expect(tracks[0].stopped).toBe(true);
        expect(mod.__micPrewarmStateForTests().open).toBe(false);
    });

    it('a release that lands while getUserMedia is still pending stops the stream when it arrives', async () => {
        const { tracks } = installFakeMedia(50);
        mod.prewarmMic('default');
        mod.releaseMicPrewarm(); // e.g. user muted on the joining controls immediately
        await vi.advanceTimersByTimeAsync(60);
        expect(tracks[0].stopped).toBe(true);
        expect(mod.__micPrewarmStateForTests().open).toBe(false);
    });

    it('is force-released after PREWARM_MAX_MS even if nothing else releases it', async () => {
        const { tracks } = installFakeMedia();
        mod.prewarmMic('default');
        await vi.advanceTimersByTimeAsync(1);
        expect(tracks[0].stopped).toBe(false); // positive control: still open before the cap
        await vi.advanceTimersByTimeAsync(mod.PREWARM_MAX_MS);
        expect(tracks[0].stopped).toBe(true);
    });

    it('a failed getUserMedia is swallowed (the call surfaces its own capture errors)', async () => {
        Object.defineProperty(globalThis, 'navigator', {
            value: { mediaDevices: { getUserMedia: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) } },
            configurable: true, writable: true,
        });
        expect(() => mod.prewarmMic('default')).not.toThrow();
        await vi.advanceTimersByTimeAsync(1);
        expect(mod.__micPrewarmStateForTests()).toEqual({ open: false, pending: false });
    });

    it('no mediaDevices (non-browser host) → does nothing', () => {
        Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
        expect(() => mod.prewarmMic('default')).not.toThrow();
        expect(mod.__micPrewarmStateForTests()).toEqual({ open: false, pending: false });
    });
});
