/**
 * The sender's frame grab (embeds-always-thumb): which moments are sampled,
 * that the best (brightest / most detailed) frame wins, that a third moment is
 * only sampled when the first two are poor, that an all-black video gives
 * nothing, and that the element is set up muted + CORS and emptied after.
 * The video element is a fake (Node has no decoder); the real one runs in the
 * real-Electron harness against live Medal / mp4 files.
 */
import { describe, it, expect, vi } from 'vitest';
import { grabFrame, sampleTimes, type GrabVideo } from './frameGrab';
import { isFlatPicture, lumaStats, pictureScore } from './thumb';
import type { Canvas } from './thumb';

describe('sampleTimes', () => {
    it('~1 s, 10 %, 25 % of the way in; never 0, never past the end, >= 0.25 s apart', () => {
        expect(sampleTimes(24.15)).toEqual([1, 2.415, 6.038]);
        expect(sampleTimes(145.63)).toEqual([1, 14.563, 36.408]);
        expect(sampleTimes(5)).toEqual([1, 0.5, 1.25]);
        expect(sampleTimes(0.6)).toEqual([0.3]);
        // Unknown / live / broken durations.
        for (const d of [undefined, NaN, Infinity, 0, -3]) expect(sampleTimes(d)).toEqual([1, 2, 3]);
    });
});

describe('frame scores (thumb.ts)', () => {
    const px = (vals: number[]) => new Uint8ClampedArray(vals.flatMap((v) => [v, v, v, 255]));
    it('one flat colour, near-black and near-white are flat; a real frame is not', () => {
        expect(isFlatPicture(lumaStats(px([0, 0, 0, 0])))).toBe(true); // Medal's black first frame
        expect(isFlatPicture(lumaStats(px([120, 121, 120, 122])))).toBe(true); // one grey
        expect(isFlatPicture(lumaStats(px([250, 255, 252, 255])))).toBe(true); // a flashbang
        expect(isFlatPicture(lumaStats(px([5, 8, 30, 10])))).toBe(true); // nearly black (mean < 14)
        expect(isFlatPicture(lumaStats(px([20, 200, 90, 140])))).toBe(false);
    });
    it('detail and exposure rank frames; a flat one always loses', () => {
        const dark = pictureScore(lumaStats(px([10, 60, 15, 50])));
        const good = pictureScore(lumaStats(px([40, 200, 90, 160])));
        const black = pictureScore(lumaStats(px([0, 0, 0, 0])));
        expect(good).toBeGreaterThan(dark);
        expect(dark).toBeGreaterThan(black);
    });
});

/** A <video> that "plays" a list of frames: `frames(t)` gives the luma stats at time t. */
function fakeVideo(opts: { duration?: number; w?: number; h?: number; noMeta?: boolean; failSeekAt?: number[] } = {}) {
    const listeners = new Map<string, Set<() => void>>();
    const emit = (e: string) => { for (const l of [...(listeners.get(e) ?? [])]) l(); };
    const v = {
        muted: false, defaultMuted: false, playsInline: false, preload: '', crossOrigin: null as string | null,
        duration: NaN, videoWidth: 0, videoHeight: 0, readyState: 0,
        _src: '', _t: 0, seeks: [] as number[], emptied: false, srcSetWhen: {} as Record<string, unknown>,
        addEventListener: (e: string, l: () => void) => { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e)!.add(l); },
        removeEventListener: (e: string, l: () => void) => { listeners.get(e)?.delete(l); },
        removeAttribute: (a: string) => { if (a === 'src') v._src = ''; },
        load: () => { v.emptied = v._src === ''; },
        get src() { return v._src; },
        set src(s: string) {
            v._src = s;
            v.srcSetWhen = { muted: v.muted, crossOrigin: v.crossOrigin, preload: v.preload };
            if (opts.noMeta) return;
            setTimeout(() => { v.duration = opts.duration ?? 24.15; v.videoWidth = opts.w ?? 1280; v.videoHeight = opts.h ?? 720; v.readyState = 1; emit('loadedmetadata'); }, 1);
        },
        get currentTime() { return v._t; },
        set currentTime(t: number) {
            v._t = t; v.seeks.push(t);
            setTimeout(() => emit(opts.failSeekAt?.includes(t) ? 'error' : 'seeked'), 1);
        },
    };
    return v;
}

const statsAt = (table: Record<number, { mean: number; std: number }>) => (v: GrabVideo) => table[v.currentTime] ?? { mean: 0, std: 0 };
const copy = (v: GrabVideo, w: number, h: number) => ({ width: w, height: h, getContext: () => null, at: v.currentTime } as unknown as Canvas);
const encode = vi.fn(async (frame: Canvas) => ({ blob: new Blob(['x']), mime: 'image/webp' as const, width: frame.width, height: frame.height, at: (frame as unknown as { at: number }).at }));

describe('grabFrame', () => {
    it('Medal-like clip that fades in: samples 1 s and 10 %, keeps the better one, records size and duration; muted, CORS, emptied after', async () => {
        const v = fakeVideo({ duration: 24.15 });
        const g = await grabFrame('clmedia://media/abc', { makeVideo: () => v as unknown as GrabVideo, stats: statsAt({ 1: { mean: 8.8, std: 9 }, 2.415: { mean: 92, std: 41 } }), copy, encode });
        expect(v.seeks).toEqual([1, 2.415]);
        expect(g).toMatchObject({ width: 1280, height: 720, durationS: 24.15, atS: 2.415, samples: 2 });
        expect(v.srcSetWhen).toEqual({ muted: true, crossOrigin: 'anonymous', preload: 'metadata' });
        expect(v.emptied).toBe(true);
    });

    it('the brightest / most detailed of the two wins even when the first is fine', async () => {
        const v = fakeVideo({ duration: 60 });
        const g = await grabFrame('clmedia://media/abc', { makeVideo: () => v as unknown as GrabVideo, stats: statsAt({ 1: { mean: 60, std: 20 }, 6: { mean: 120, std: 55 } }), copy, encode });
        expect(g?.atS).toBe(6);
        expect(v.seeks).toEqual([1, 6]);
    });

    it('a third moment (25 %) only when the first two are both flat / black', async () => {
        const v = fakeVideo({ duration: 40 });
        const g = await grabFrame('clmedia://media/abc', { makeVideo: () => v as unknown as GrabVideo, stats: statsAt({ 1: { mean: 0, std: 0 }, 4: { mean: 3, std: 2 }, 10: { mean: 80, std: 30 } }), copy, encode });
        expect(v.seeks).toEqual([1, 4, 10]);
        expect(g?.atS).toBe(10);
    });

    it('an all-black video gives nothing (the chain goes on to the snapshot / designed picture)', async () => {
        const v = fakeVideo({ duration: 40 });
        expect(await grabFrame('clmedia://media/abc', { makeVideo: () => v as unknown as GrabVideo, stats: () => ({ mean: 0, std: 0 }), copy, encode })).toBeNull();
        expect(v.emptied).toBe(true);
    });

    it('a seek that errors is skipped; the others still count', async () => {
        const v = fakeVideo({ duration: 24.15, failSeekAt: [1] });
        const g = await grabFrame('clmedia://media/abc', { makeVideo: () => v as unknown as GrabVideo, stats: statsAt({ 2.415: { mean: 92, std: 41 } }), copy, encode });
        expect(g?.atS).toBe(2.415);
    });

    it('no metadata in time / no size / an unreadable (tainted) frame / aborted: null, and the element is emptied', async () => {
        const v1 = fakeVideo({ noMeta: true });
        expect(await grabFrame('clmedia://media/abc', { makeVideo: () => v1 as unknown as GrabVideo, timeoutMs: 30, copy, encode })).toBeNull();
        expect(v1.emptied).toBe(true);
        const v2 = fakeVideo({ w: 0, h: 0 });
        expect(await grabFrame('clmedia://media/abc', { makeVideo: () => v2 as unknown as GrabVideo, copy, encode })).toBeNull();
        const v3 = fakeVideo();
        expect(await grabFrame('clmedia://media/abc', { makeVideo: () => v3 as unknown as GrabVideo, stats: () => null, copy, encode })).toBeNull();
        const v4 = fakeVideo();
        const ctl = new AbortController();
        const p = grabFrame('clmedia://media/abc', { makeVideo: () => v4 as unknown as GrabVideo, signal: ctl.signal, stats: statsAt({ 1: { mean: 90, std: 40 } }), copy, encode });
        ctl.abort();
        expect(await p).toBeNull();
        expect(v4.emptied).toBe(true);
    });

    it('the whole grab is bounded in time', async () => {
        const v = fakeVideo({ duration: 24.15 });
        // Seeks never complete: each waits at most its share of the overall budget.
        v.addEventListener = () => {};
        const t0 = Date.now();
        expect(await grabFrame('clmedia://media/abc', { makeVideo: () => v as unknown as GrabVideo, timeoutMs: 120, seekTimeoutMs: 50, copy, encode })).toBeNull();
        expect(Date.now() - t0).toBeLessThan(1000);
    });
});
