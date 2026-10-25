import { describe, it, expect } from 'vitest';
import { planFrame } from './geometry';
import { muxAnimatedWebp, readWebpChunks } from './webpMux';
import { fitAnimated, fitStatic, decimateFrames, type TimedFrame } from './budget';
import { isAnimatedImage } from '../token';

describe('planFrame', () => {
    it('crop: centred square from a landscape source, fills the canvas', () => {
        expect(planFrame(400, 200, 128, 'crop')).toEqual({ sx: 100, sy: 0, sw: 200, sh: 200, dx: 0, dy: 0, dw: 128, dh: 128 });
    });
    it('crop: portrait source crops top/bottom', () => {
        expect(planFrame(200, 400, 128, 'crop')).toMatchObject({ sx: 0, sy: 100, sw: 200, sh: 200 });
    });
    it('fit: whole picture, letterboxed and centred', () => {
        expect(planFrame(400, 200, 128, 'fit')).toEqual({ sx: 0, sy: 0, sw: 400, sh: 200, dx: 0, dy: 32, dw: 128, dh: 64 });
        const p = planFrame(100, 300, 128, 'fit');
        expect(p.dh).toBe(128);
        expect(Math.abs(p.dx + p.dw / 2 - 64)).toBeLessThanOrEqual(1);
    });
    it('fit never leaves the canvas, whatever the aspect', () => {
        for (const [w, h] of [[1, 5000], [5000, 1], [128, 128], [3, 7]]) {
            const p = planFrame(w, h, 128, 'fit');
            expect(p.dx).toBeGreaterThanOrEqual(0); expect(p.dy).toBeGreaterThanOrEqual(0);
            expect(p.dx + p.dw).toBeLessThanOrEqual(128); expect(p.dy + p.dh).toBeLessThanOrEqual(128);
        }
    });
    it('rejects an empty image', () => { expect(() => planFrame(0, 10, 128, 'crop')).toThrow(); });
});

// ── WebP muxer ─────────────────────────────────────────────────────────────
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const ascii = (s: string) => [...s].map(c => c.charCodeAt(0));
/** A structurally valid still WebP wrapper around fake bitstream bytes. */
function fakeStill(kind: 'VP8 ' | 'VP8L' | 'alpha', n = 11): Uint8Array {
    const chunk = (cc: string, p: number[]) => [...ascii(cc), ...le32(p.length), ...p, ...(p.length & 1 ? [0] : [])];
    const bits = Array.from({ length: n }, (_, i) => (i * 7) & 255);
    let body: number[];
    if (kind === 'alpha') body = [...chunk('VP8X', [0x10, 0, 0, 0, 127, 0, 0, 127, 0, 0]), ...chunk('ALPH', [1, 2, 3]), ...chunk('VP8 ', bits)];
    else if (kind === 'VP8L') body = chunk('VP8L', [0x2f, 0, 0, 0, 0x10, ...bits]);
    else body = chunk('VP8 ', bits);
    return Uint8Array.from([...ascii('RIFF'), ...le32(4 + body.length), ...ascii('WEBP'), ...body]);
}

describe('muxAnimatedWebp', () => {
    it('produces a RIFF/WEBP with VP8X(animation) + ANIM + one ANMF per frame, correct sizes', () => {
        const out = muxAnimatedWebp([
            { webp: fakeStill('VP8 '), durationMs: 80 },
            { webp: fakeStill('VP8 ', 12), durationMs: 120 },
            { webp: fakeStill('VP8 '), durationMs: 60 },
        ], 128, 128);
        expect(String.fromCharCode(...out.slice(0, 4))).toBe('RIFF');
        const riffSize = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
        expect(riffSize).toBe(out.length - 8);
        const chunks = readWebpChunks(out);
        expect(chunks.map(c => c.fourcc)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF', 'ANMF']);
        const vp8x = chunks[0].payload;
        expect(vp8x[0] & 0x02).toBe(0x02);          // animation flag
        expect(vp8x[0] & 0x10).toBe(0);              // no alpha
        expect(vp8x[4] | (vp8x[5] << 8)).toBe(127);  // canvas width - 1
        // ANMF: duration (bytes 12..14) and no-blend flag
        const f = chunks[3].payload;
        expect(f[12] | (f[13] << 8) | (f[14] << 16)).toBe(120);
        expect(f[15]).toBe(0x02);
        expect(isAnimatedImage(out, 'image/webp')).toBe(true);
    });

    it('sets the alpha flag when any frame has ALPH or an alpha VP8L', () => {
        expect(readWebpChunks(muxAnimatedWebp([{ webp: fakeStill('alpha'), durationMs: 50 }], 128, 128))[0].payload[0] & 0x10).toBe(0x10);
        expect(readWebpChunks(muxAnimatedWebp([{ webp: fakeStill('VP8L'), durationMs: 50 }], 128, 128))[0].payload[0] & 0x10).toBe(0x10);
    });

    it('strips non-image chunks (VP8X, EXIF, ICCP) from frames', () => {
        const chunk = (cc: string, p: number[]) => [...ascii(cc), ...le32(p.length), ...p, ...(p.length & 1 ? [0] : [])];
        const body = [...chunk('VP8X', [0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0]), ...chunk('EXIF', [9, 9, 9, 9]), ...chunk('VP8 ', [1, 2, 3, 4])];
        const still = Uint8Array.from([...ascii('RIFF'), ...le32(4 + body.length), ...ascii('WEBP'), ...body]);
        const out = muxAnimatedWebp([{ webp: still, durationMs: 50 }], 128, 128);
        const anmf = readWebpChunks(out)[2].payload;
        expect(new TextDecoder().decode(anmf)).not.toContain('EXIF');
    });

    it('rejects non-WebP input, frames without image data, and an empty list', () => {
        expect(() => muxAnimatedWebp([{ webp: new Uint8Array(40), durationMs: 50 }], 128, 128)).toThrow();
        const empty = Uint8Array.from([...ascii('RIFF'), ...le32(4), ...ascii('WEBP')]);
        expect(() => muxAnimatedWebp([{ webp: empty, durationMs: 50 }], 128, 128)).toThrow();
        expect(() => muxAnimatedWebp([], 128, 128)).toThrow();
    });

    it('handles a quarter-megabyte frame without blowing the stack', () => {
        const big = fakeStill('VP8 ', 250_000);
        expect(muxAnimatedWebp([{ webp: big, durationMs: 50 }], 128, 128).length).toBeGreaterThan(250_000);
    });
});

// ── Budget planner ─────────────────────────────────────────────────────────
const frames = (n: number, ms = 50): TimedFrame<number>[] => Array.from({ length: n }, (_, i) => ({ frame: i, durationMs: ms }));

describe('decimateFrames', () => {
    it('keeps every k-th frame and folds the dropped time into the kept one', () => {
        const out = decimateFrames(frames(7, 40), 2);
        expect(out.map(f => f.frame)).toEqual([0, 2, 4, 6]);
        expect(out.map(f => f.durationMs)).toEqual([80, 80, 80, 40]);
        expect(out.reduce((n, f) => n + f.durationMs, 0)).toBe(7 * 40);
    });
    it('k=1 is identity', () => { const f = frames(3); expect(decimateFrames(f, 1)).toEqual(f); });
});

describe('fitStatic', () => {
    it('takes the first attempt under the target', async () => {
        const tried: string[] = [];
        const r = await fitStatic(async (q, side) => { tried.push(`${q}@${side}`); return new Uint8Array(q > 0.7 ? 30_000 : 9_000); }, 16 * 1024, 128);
        expect(r.bytes.length).toBe(9_000);
        expect(r.side).toBe(128);
        expect(tried.length).toBeGreaterThan(1);
    });
    it('shrinks the side when quality alone cannot reach the target', async () => {
        const r = await fitStatic(async (_q, side) => new Uint8Array(side === 128 ? 40_000 : 8_000), 16 * 1024, 128);
        expect(r.side).toBeLessThan(128);
        expect(r.bytes.length).toBeLessThanOrEqual(16 * 1024);
    });
    it('gives the smallest it found when nothing fits (still stored: the hard cap is 256 KB)', async () => {
        const r = await fitStatic(async () => new Uint8Array(50_000), 16 * 1024, 128);
        expect(r.bytes.length).toBe(50_000);
    });
});

describe('fitAnimated', () => {
    it('lowers quality first, then drops frames, then size, until under the cap', async () => {
        const calls: string[] = [];
        // size ~ frames * (q * side) bytes
        const encode = async (fs: TimedFrame<number>[], q: number, side: number) => {
            calls.push(`${fs.length}/${q}/${side}`);
            return new Uint8Array(Math.round(fs.length * q * side * 12));
        };
        const r = await fitAnimated(frames(60), encode, 256 * 1024, 128);
        expect(r!.bytes.length).toBeLessThanOrEqual(256 * 1024);
        expect(calls[0].startsWith('60/')).toBe(true);
        expect(r!.keptFrames).toBeLessThanOrEqual(60);
    });
    it('keeps total duration when it drops frames', async () => {
        const r = await fitAnimated(frames(60, 50), async fs => new Uint8Array(fs.length * 12_000), 256 * 1024, 128);
        expect(r!.frames.reduce((n, f) => n + f.durationMs, 0)).toBe(3000);
    });
    it('returns null when no attempt can fit', async () => {
        expect(await fitAnimated(frames(10), async () => new Uint8Array(900_000), 256 * 1024, 128)).toBeNull();
    });
});
