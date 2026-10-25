import { describe, it, expect, vi } from 'vitest';
import {
    startHdrSharePipeline, parseHdrProbe, parseHdrStart, fitOutputSize, BLANK_CHECK_FRAMES,
    type HdrShareApi,
} from './hdrSharePipeline';

class FakeFrame { closed = false; blank: boolean; constructor(blank = false) { this.blank = blank; } close() { this.closed = true; } }

function fakeGenerator() {
    const written: FakeFrame[] = [];
    const writer = {
        desiredSize: 1 as number | null,
        write: vi.fn(async (f: FakeFrame) => { written.push(f); f.close(); }),
        close: vi.fn(async () => {}),
    };
    let stopped = false;
    class Gen {
        kind = 'video';
        writable = { getWriter: () => writer };
        stop() { stopped = true; }
    }
    return { Gen, writer, written, isStopped: () => stopped };
}

function fakeApi(startResult: unknown = { ok: true, session: 7, info: { width: 2560, height: 1440, srcWidth: 2560, srcHeight: 1440, hdr: true, inputFormat: 'fp16', sdrWhiteNits: 240, peakNits: 1000, knee: 0.8 } }) {
    let receiver: ((f: VideoFrame, s: number) => void) | null = null;
    let ended: ((s: number, r: string) => void) | null = null;
    const api: HdrShareApi & { stop: ReturnType<typeof vi.fn> } = {
        probe: vi.fn(),
        start: vi.fn(async () => startResult),
        stop: vi.fn(async () => {}),
        stats: vi.fn(),
        setFrameReceiver: (cb) => { receiver = cb; },
        onEnded: (cb) => { ended = cb; },
    };
    return {
        api,
        push: (f: FakeFrame, s = 7) => {
            if (receiver) receiver(f as unknown as VideoFrame, s);
            else f.close(); // what preload does with no receiver
        },
        end: (s: number, r: string) => ended?.(s, r),
        hasReceiver: () => receiver !== null,
    };
}

const isBlank = (f: VideoFrame) => (f as unknown as FakeFrame).blank;
const OPTS = { width: 2560, height: 1440, maxFps: 90 };

describe('parsing what main returns', () => {
    it('probe: narrows field by field', () => {
        expect(parseHdrProbe(null)).toEqual({ use: false, reason: 'unknown', hdr: null, display: null });
        expect(parseHdrProbe({ use: true, reason: 'hdr', hdr: true, display: { width: 3840, height: 2160, sdrWhiteNits: 240, maxLuminance: 1000, bitsPerColor: 10 } }))
            .toEqual({ use: true, reason: 'hdr', hdr: true, display: { width: 3840, height: 2160, sdrWhiteNits: 240, maxLuminance: 1000, bitsPerColor: 10 } });
        expect(parseHdrProbe({ use: 'yes', hdr: 'true' }).use).toBe(false);
    });
    it('start: refuses a result without a usable session/size', () => {
        expect(parseHdrStart({ ok: false, error: 'cross_adapter' })).toEqual({ ok: false, error: 'cross_adapter' });
        expect(parseHdrStart({ ok: true, session: 1, info: { width: 0, height: 0 } })).toEqual({ ok: false, error: 'bad_start' });
        expect(parseHdrStart(undefined)).toEqual({ ok: false, error: 'start_failed' });
    });
});

describe('fitOutputSize', () => {
    it('never upscales, keeps aspect, even dimensions', () => {
        expect(fitOutputSize({ width: 2560, height: 1440 }, { width: 3840, height: 2160 })).toEqual({ width: 2560, height: 1440 });
        expect(fitOutputSize({ width: 3840, height: 2160 }, { width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
        expect(fitOutputSize({ width: 3440, height: 1440 }, { width: 2560, height: 1440 })).toEqual({ width: 2560, height: 1070 });
        expect(fitOutputSize({ width: 1366, height: 769 }, { width: 4000, height: 4000 })).toEqual({ width: 1366, height: 768 });
    });
});

describe('startHdrSharePipeline', () => {
    it('resolves with a track only after a real (non-blank) frame flowed, and writes it', async () => {
        const g = fakeGenerator();
        const a = fakeApi();
        const p = startHdrSharePipeline('screen:1:0', 'tok', OPTS, { api: a.api, Generator: g.Gen as never, isBlank, firstFrameTimeoutMs: 1000 });
        await Promise.resolve();
        a.push(new FakeFrame(false));
        const r = await p;
        expect(r.ok).toBe(true);
        expect(a.api.start).toHaveBeenCalledWith('screen:1:0', 'tok', OPTS);
        expect(g.written).toHaveLength(1);
        if (r.ok) {
            expect(r.pipeline.session).toBe(7);
            expect(r.pipeline.captureSettings()).toMatchObject({ width: 2560, height: 1440, frameRate: 1 });
        }
    });

    it('falls back when main refuses (the caller then shares the normal way)', async () => {
        const g = fakeGenerator();
        const a = fakeApi({ ok: false, error: 'not_hdr' });
        const r = await startHdrSharePipeline('screen:1:0', 'tok', OPTS, { api: a.api, Generator: g.Gen as never, isBlank });
        expect(r).toEqual({ ok: false, reason: 'not_hdr' });
        expect(g.isStopped()).toBe(true);
        expect(a.hasReceiver()).toBe(false);
    });

    it('falls back when no frame arrives in time, and stops the native session', async () => {
        vi.useFakeTimers();
        try {
            const g = fakeGenerator();
            const a = fakeApi();
            const p = startHdrSharePipeline('screen:1:0', undefined, OPTS, { api: a.api, Generator: g.Gen as never, isBlank, firstFrameTimeoutMs: 3000 });
            await vi.advanceTimersByTimeAsync(3001);
            expect(await p).toEqual({ ok: false, reason: 'no_frames' });
            expect(a.api.stop).toHaveBeenCalledWith(7);
            expect(g.isStopped()).toBe(true);
        } finally { vi.useRealTimers(); }
    });

    it('falls back when the first frames are all blank (a texture Chromium could not open reads as black)', async () => {
        const g = fakeGenerator();
        const a = fakeApi();
        const p = startHdrSharePipeline('screen:1:0', 'tok', OPTS, { api: a.api, Generator: g.Gen as never, isBlank, firstFrameTimeoutMs: 60_000 });
        await Promise.resolve(); await Promise.resolve();
        for (let i = 0; i < BLANK_CHECK_FRAMES; i++) a.push(new FakeFrame(true));
        expect(await p).toEqual({ ok: false, reason: 'blank_frames' });
    });

    it('drops (closes) frames while the encoder is behind instead of queueing them', async () => {
        const g = fakeGenerator();
        const a = fakeApi();
        const p = startHdrSharePipeline('screen:1:0', 'tok', OPTS, { api: a.api, Generator: g.Gen as never, isBlank });
        await Promise.resolve();
        a.push(new FakeFrame());
        const r = await p;
        g.writer.desiredSize = 0;
        const late = new FakeFrame();
        a.push(late);
        expect(late.closed).toBe(true);
        expect(r.ok && r.pipeline.stats()).toEqual({ written: 1, dropped: 1 });
    });

    it('ignores frames of another session; stop() is idempotent and releases everything', async () => {
        const g = fakeGenerator();
        const a = fakeApi();
        const p = startHdrSharePipeline('screen:1:0', 'tok', OPTS, { api: a.api, Generator: g.Gen as never, isBlank });
        await Promise.resolve();
        a.push(new FakeFrame());
        const r = await p;
        const stale = new FakeFrame();
        a.push(stale, 6);
        expect(stale.closed).toBe(true);
        expect(g.written).toHaveLength(1);
        if (!r.ok) throw new Error('expected ok');
        r.pipeline.stop();
        r.pipeline.stop();
        expect(a.api.stop).toHaveBeenCalledTimes(1);
        expect(a.hasReceiver()).toBe(false);
        expect(g.isStopped()).toBe(true);
    });

    it('reports the capture ending on its own (display unplugged / HDR switched off)', async () => {
        const g = fakeGenerator();
        const a = fakeApi();
        const p = startHdrSharePipeline('screen:1:0', 'tok', OPTS, { api: a.api, Generator: g.Gen as never, isBlank });
        await Promise.resolve();
        a.push(new FakeFrame());
        const r = await p;
        if (!r.ok) throw new Error('expected ok');
        const onEnd = vi.fn();
        r.pipeline.onSourceEnded(onEnd);
        a.end(6, 'display_gone'); // someone else's
        expect(onEnd).not.toHaveBeenCalled();
        a.end(7, 'not_hdr');
        expect(onEnd).toHaveBeenCalledWith('not_hdr');
        expect(g.isStopped()).toBe(true);
    });

    it('without MediaStreamTrackGenerator it declines up front', async () => {
        const a = fakeApi();
        expect(await startHdrSharePipeline('screen:1:0', 'tok', OPTS, { api: a.api, Generator: undefined as never })).toEqual(
            typeof (globalThis as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator === 'function'
                ? expect.anything() : { ok: false, reason: 'no_generator' },
        );
        expect(a.api.start).not.toHaveBeenCalled();
    });
});
