import { describe, it, expect } from 'vitest';
import { AnimatedCropError, CROP_RUNGS, keepStride, runAnimatedCrop, type PipelineDeps, type SourceFrame } from './pipeline';
import {
    ANIM_CROP_MAX_DURATION_MS, ANIM_CROP_MAX_OUTPUT_BYTES, ANIM_CROP_MAX_OUTPUT_FRAMES,
    ANIM_CROP_MAX_SOURCE_FRAMES, ANIM_CROP_SOURCE_MAX_SIDE, animatedOutputSize,
} from './protocol';
import { readWebpChunks } from '../personalEmoji/process/webpMux';
import { cropSourceRect, IDENTITY_CROP } from '../imageCrop';

/**
 * The pipeline with a fake decoder / encoder: every guarantee the owner asked
 * of the animated crop that does not need a real browser - frame count and
 * timing survive, the crop rectangle is what gets drawn, the caps hold.
 */

const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const ascii = (s: string) => [...s].map(c => c.charCodeAt(0));
/** A structurally valid still WebP (VP8) of `n` bitstream bytes (typed arrays: n goes up to MBs). */
function fakeStill(n: number): Uint8Array {
    const pad = n & 1;
    const body = new Uint8Array(8 + n + pad);
    body.set(ascii('VP8 '), 0);
    body.set(le32(n), 4);
    const out = new Uint8Array(12 + body.length);
    out.set(ascii('RIFF'), 0);
    out.set(le32(4 + body.length), 4);
    out.set(ascii('WEBP'), 8);
    out.set(body, 12);
    return out;
}

interface Rig {
    deps: PipelineDeps<{ i: number }>;
    drawn: number[];
    released: number;
    encoded: { quality: number; width: number; height: number }[];
}

function rig(opts: {
    count: number;
    ms?: number | ((i: number) => number | null);
    size?: { width: number; height: number };
    bytesPerFrame?: (q: number, w: number, h: number) => number;
}): Rig {
    const r: Rig = { deps: undefined as never, drawn: [], released: 0, encoded: [] };
    const size = opts.size ?? { width: 480, height: 270 };
    const dur = (i: number) => (typeof opts.ms === 'function' ? opts.ms(i) : opts.ms ?? 100);
    r.deps = {
        frameCount: opts.count,
        async readFrame(i, keep): Promise<{ frame: SourceFrame; bitmap: { i: number } | null }> {
            const d = dur(i);
            const frame = { ...size, durationUs: d === null ? null : d * 1000 };
            if (!keep) return { frame, bitmap: null };
            r.drawn.push(i);
            return { frame, bitmap: { i } };
        },
        async encodeFrame(_b, quality, width, height) {
            r.encoded.push({ quality, width, height });
            return fakeStill((opts.bytesPerFrame ?? (() => 400))(quality, width, height));
        },
        release() { r.released++; },
    };
    return r;
}

/** Durations of an animated WebP's frames, in order (ANMF bytes 12..14). */
function frameDurations(webp: Uint8Array): number[] {
    return readWebpChunks(webp).filter(c => c.fourcc === 'ANMF').map(c => c.payload[12] | (c.payload[13] << 8) | (c.payload[14] << 16));
}

describe('runAnimatedCrop: frames and timing', () => {
    it('keeps every frame and every frame time of a short animation', async () => {
        const r = rig({ count: 24, ms: i => 40 + i });
        const out = await runAnimatedCrop(r.deps, 320, 320);
        expect(out.frames).toBe(24);
        expect(out.trimmed).toBe(false);
        const d = frameDurations(out.bytes);
        expect(d).toEqual(Array.from({ length: 24 }, (_, i) => 40 + i));
        expect(out.durationMs).toBe(d.reduce((a, b) => a + b, 0));
        expect(out.width).toBe(320);
        expect(out.height).toBe(320);
        expect(r.drawn).toHaveLength(24);
    });

    it('thins a long animation to the frame cap WITHOUT changing its playback length', async () => {
        const r = rig({ count: 300, ms: 30 });
        const out = await runAnimatedCrop(r.deps, 320, 320);
        expect(out.frames).toBeLessThanOrEqual(ANIM_CROP_MAX_OUTPUT_FRAMES);
        expect(out.frames).toBeGreaterThan(40);
        expect(out.durationMs).toBe(300 * 30);
        expect(frameDurations(out.bytes).reduce((a, b) => a + b, 0)).toBe(300 * 30);
        // only the kept frames are ever cropped / drawn
        expect(r.drawn.length).toBeLessThanOrEqual(ANIM_CROP_MAX_OUTPUT_FRAMES);
        expect(r.drawn.every(i => i % keepStride(300) === 0)).toBe(true);
    });

    it('trims an animation longer than the duration cap, and says so', async () => {
        const r = rig({ count: 400, ms: 100 }); // 40 s
        const out = await runAnimatedCrop(r.deps, 320, 320);
        expect(out.trimmed).toBe(true);
        expect(out.durationMs).toBeLessThanOrEqual(ANIM_CROP_MAX_DURATION_MS);
        expect(out.durationMs).toBeGreaterThan(ANIM_CROP_MAX_DURATION_MS - 1000);
    });

    it('trims one huge final frame to fit the duration cap exactly', async () => {
        const r = rig({ count: 3, ms: i => (i === 2 ? 60_000 : 5_000) });
        const out = await runAnimatedCrop(r.deps, 320, 320);
        expect(out.durationMs).toBe(ANIM_CROP_MAX_DURATION_MS);
        expect(out.trimmed).toBe(true);
    });

    it('never reads past the source-frame cap', async () => {
        const r = rig({ count: ANIM_CROP_MAX_SOURCE_FRAMES + 500, ms: 10 });
        const out = await runAnimatedCrop(r.deps, 200, 200);
        expect(out.trimmed).toBe(true);
        expect(r.drawn.every(i => i < ANIM_CROP_MAX_SOURCE_FRAMES)).toBe(true);
    });

    it('gives unknown and zero-ish frame times a sane display time', async () => {
        const r = rig({ count: 3, ms: i => (i === 0 ? null : 0) });
        const d = frameDurations((await runAnimatedCrop(r.deps, 100, 100)).bytes);
        expect(d[0]).toBe(100);     // unknown -> 100 ms
        expect(d[1]).toBe(20);      // below the minimum -> 20 ms
    });

    it('releases every bitmap it made, success or failure', async () => {
        const ok = rig({ count: 10 });
        await runAnimatedCrop(ok.deps, 100, 100);
        expect(ok.released).toBe(ok.drawn.length);

        const bad = rig({ count: 10, bytesPerFrame: () => 5_000_000 });
        await expect(runAnimatedCrop(bad.deps, 100, 100)).rejects.toMatchObject({ code: 'TOO_COMPLEX' });
        expect(bad.released).toBe(bad.drawn.length);
    });
});

describe('runAnimatedCrop: size caps', () => {
    it('takes the mildest rung that fits', async () => {
        const r = rig({ count: 20, bytesPerFrame: () => 1000 });
        const out = await runAnimatedCrop(r.deps, 320, 320);
        expect(r.encoded.every(e => e.quality === CROP_RUNGS[0][1] && e.width === 320)).toBe(true);
        expect(out.bytes.length).toBeLessThanOrEqual(ANIM_CROP_MAX_OUTPUT_BYTES);
    });

    it('walks down quality, then frames, then size until the result fits the cap', async () => {
        // bytes grow with quality and area: only the lossier / smaller rungs fit 4 MiB at 100 frames
        const r = rig({ count: 100, bytesPerFrame: (q, w, h) => Math.round(q * w * h * 0.5) });
        const out = await runAnimatedCrop(r.deps, 320, 320);
        expect(out.bytes.length).toBeLessThanOrEqual(ANIM_CROP_MAX_OUTPUT_BYTES);
        const tried = new Set(r.encoded.map(e => `${e.quality}@${e.width}`));
        expect(tried.size).toBeGreaterThan(1);
        expect(out.durationMs).toBe(100 * 100); // playback length survives every rung
    });

    it('bails out of a rung as soon as it is over the cap (no wasted encodes)', async () => {
        const r = rig({ count: 100, bytesPerFrame: () => 1_000_000 });
        await expect(runAnimatedCrop(r.deps, 320, 320)).rejects.toBeInstanceOf(AnimatedCropError);
        // 8 rungs; each stops after the 5th 1 MB frame, nowhere near 8 x 100 encodes
        expect(r.encoded.length).toBeLessThan(8 * 6);
    });

    it('refuses (TOO_COMPLEX) rather than storing something over the cap', async () => {
        const r = rig({ count: 50, bytesPerFrame: () => 900_000 });
        await expect(runAnimatedCrop(r.deps, 320, 320)).rejects.toMatchObject({ code: 'TOO_COMPLEX' });
    });

    it('rejects a frame bigger than the decode ceiling before encoding anything', async () => {
        const r = rig({ count: 5, size: { width: ANIM_CROP_SOURCE_MAX_SIDE + 1, height: 100 } });
        await expect(runAnimatedCrop(r.deps, 320, 320)).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
        expect(r.encoded).toHaveLength(0);
    });

    it('rejects an empty frame', async () => {
        const r = rig({ count: 5, size: { width: 0, height: 100 } });
        await expect(runAnimatedCrop(r.deps, 320, 320)).rejects.toMatchObject({ code: 'NOT_AN_IMAGE' });
    });

    it('reports monotonically increasing progress that ends at 1', async () => {
        const r = rig({ count: 12 });
        const seen: number[] = [];
        r.deps.progress = f => seen.push(f);
        await runAnimatedCrop(r.deps, 320, 320);
        expect(seen.length).toBeGreaterThan(3);
        expect(seen[seen.length - 1]).toBe(1);
        for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    });
});

describe('animatedOutputSize', () => {
    it('caps squares at 320 and wide banners at 800, keeping the aspect ratio', () => {
        expect(animatedOutputSize(512, 512)).toEqual({ width: 320, height: 320 });
        expect(animatedOutputSize(1200, 480)).toEqual({ width: 800, height: 320 });
    });
    it('never upscales a smaller preset', () => {
        expect(animatedOutputSize(128, 128)).toEqual({ width: 128, height: 128 });
    });
});

describe('the crop rectangle every frame is drawn with', () => {
    // The worker draws each frame with cropSourceRect(...) - the cropper's own
    // maths - so the animated result is framed exactly like the preview.
    it('is the whole image at the default framing and a tighter, panned window when zoomed', () => {
        const whole = cropSourceRect(480, 270, IDENTITY_CROP, 300, 300)!;
        expect(whole.sh).toBeCloseTo(270);          // height fills; width is cropped
        expect(whole.sw).toBeCloseTo(270);
        expect(whole.sx).toBeCloseTo((480 - 270) / 2);
        const zoomed = cropSourceRect(480, 270, { scale: 2, x: 0, y: 0 }, 300, 300)!;
        expect(zoomed.sw).toBeCloseTo(135);
        expect(zoomed.sx).toBeCloseTo((480 - 135) / 2);
        // panning the image right shows more of its LEFT side
        const panned = cropSourceRect(480, 270, { scale: 2, x: 40, y: 0 }, 300, 300)!;
        expect(panned.sx).toBeLessThan(zoomed.sx);
    });
    it('matches the aspect ratio of the output for a banner', () => {
        const r = cropSourceRect(480, 270, IDENTITY_CROP, 420, 168)!;
        expect(r.sw / r.sh).toBeCloseTo(420 / 168);
    });
});
