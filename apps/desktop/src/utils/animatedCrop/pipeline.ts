/**
 * The animated-crop pipeline, with every browser API injected.
 *
 *   decode each frame -> crop it to the framed rectangle at the output size
 *   -> (thin to the frame cap) -> encode every kept frame as a still WebP at a
 *   quality / size rung -> mux into one animated WebP -> first rung under the
 *   byte cap wins.
 *
 * The worker (src/workers/animatedCrop.worker.ts) supplies ImageDecoder /
 * OffscreenCanvas; the tests supply fakes, which is how frame count, timing,
 * the crop rectangle and the caps are proven without a browser.
 */
import { decimateFrames, type TimedFrame } from '../personalEmoji/process/budget';
import { muxAnimatedWebp } from '../personalEmoji/process/webpMux';
import {
    ANIM_CROP_MAX_DURATION_MS, ANIM_CROP_MAX_OUTPUT_BYTES, ANIM_CROP_MAX_OUTPUT_FRAMES,
    ANIM_CROP_MAX_SOURCE_FRAMES, ANIM_CROP_MIN_FRAME_MS, ANIM_CROP_SOURCE_MAX_SIDE,
    type AnimatedCropErrorCode,
} from './protocol';

export class AnimatedCropError extends Error {
    readonly code: AnimatedCropErrorCode;
    constructor(code: AnimatedCropErrorCode, message: string) { super(message); this.code = code; }
}

/** One decoded source frame, as the pipeline sees it. */
export interface SourceFrame {
    width: number;
    height: number;
    /** Display time in microseconds (WebCodecs' unit); null = unknown. */
    durationUs: number | null;
}

export interface PipelineDeps<B> {
    /** Frames in the source (> 1). */
    frameCount: number;
    /**
     * Decode frame `i` and, when `keep`, crop it to the output size and return
     * the bitmap (null otherwise). The decoded frame is always released here.
     */
    readFrame(i: number, keep: boolean): Promise<{ frame: SourceFrame; bitmap: B | null }>;
    /** Draw `bitmap` at width x height and return it as a still WebP file. */
    encodeFrame(bitmap: B, quality: number, width: number, height: number): Promise<Uint8Array>;
    release(bitmap: B): void;
    progress?(fraction: number): void;
}

export interface PipelineResult {
    bytes: Uint8Array;
    frames: number;
    width: number;
    height: number;
    durationMs: number;
    trimmed: boolean;
}

/** [frame decimation, WebP quality, size scale]: the rungs tried, mildest first. */
export const CROP_RUNGS: readonly (readonly [number, number, number])[] = [
    [1, 0.82, 1], [1, 0.66, 1], [1, 0.5, 1],
    [2, 0.66, 0.85], [2, 0.5, 0.85],
    [3, 0.5, 0.7], [3, 0.4, 0.7],
    [4, 0.4, 0.55],
];

/** How many source frames to step between kept ones so at most `maxOut` are kept. */
export function keepStride(frameCount: number, maxOut = ANIM_CROP_MAX_OUTPUT_FRAMES): number {
    return Math.max(1, Math.ceil(frameCount / maxOut));
}

export async function runAnimatedCrop<B>(
    deps: PipelineDeps<B>,
    outW: number,
    outH: number,
    cap = ANIM_CROP_MAX_OUTPUT_BYTES,
): Promise<PipelineResult> {
    const report = (f: number) => deps.progress?.(Math.min(1, f));
    const limit = Math.min(deps.frameCount, ANIM_CROP_MAX_SOURCE_FRAMES);
    const stride = keepStride(limit);
    let trimmed = deps.frameCount > ANIM_CROP_MAX_SOURCE_FRAMES;

    const kept: TimedFrame<B>[] = [];
    let total = 0;
    try {
        for (let i = 0; i < limit; i++) {
            if (total >= ANIM_CROP_MAX_DURATION_MS) { trimmed = true; break; }
            const keep = i % stride === 0;
            const { frame, bitmap } = await deps.readFrame(i, keep);
            if (!(frame.width > 0) || !(frame.height > 0)) {
                if (bitmap) deps.release(bitmap);
                throw new AnimatedCropError('NOT_AN_IMAGE', 'That picture is empty.');
            }
            if (frame.width > ANIM_CROP_SOURCE_MAX_SIDE || frame.height > ANIM_CROP_SOURCE_MAX_SIDE) {
                if (bitmap) deps.release(bitmap);
                throw new AnimatedCropError('IMAGE_TOO_LARGE', `That animation is bigger than ${ANIM_CROP_SOURCE_MAX_SIDE} px on a side.`);
            }
            const ms = Math.max(ANIM_CROP_MIN_FRAME_MS, Math.round((frame.durationUs ?? 100_000) / 1000));
            const used = Math.min(ms, ANIM_CROP_MAX_DURATION_MS - total);
            if (used < ms) trimmed = true;
            total += used;
            if (bitmap) kept.push({ frame: bitmap, durationMs: used });
            // A frame we skip lends its time to the one kept before it, so playback length is preserved.
            else if (kept.length) kept[kept.length - 1].durationMs += used;
            report(0.4 * ((i + 1) / limit));
        }
        if (kept.length === 0) throw new AnimatedCropError('NOT_AN_IMAGE', 'Could not read any frames.');

        let attempt = 0;
        for (const [k, quality, scale] of CROP_RUNGS) {
            const frames = decimateFrames(kept, k);
            const width = Math.max(16, Math.round(outW * scale));
            const height = Math.max(16, Math.round(outH * scale));
            report(0.4 + Math.min(0.55, 0.07 * ++attempt));
            const stills: { webp: Uint8Array; durationMs: number }[] = [];
            let bytesSoFar = 0;
            let over = false;
            for (const f of frames) {
                const webp = await deps.encodeFrame(f.frame, quality, width, height);
                bytesSoFar += webp.length;
                // The rung cannot fit once its frames alone pass the cap: stop encoding it.
                if (bytesSoFar > cap) { over = true; break; }
                stills.push({ webp, durationMs: f.durationMs });
            }
            if (over) continue;
            const bytes = muxAnimatedWebp(stills, width, height);
            if (bytes.length > cap) continue;
            report(1);
            return {
                bytes, frames: frames.length, width, height,
                durationMs: frames.reduce((n, f) => n + f.durationMs, 0), trimmed,
            };
        }
        throw new AnimatedCropError('TOO_COMPLEX', 'That animation is too detailed to fit. Try a shorter or simpler one.');
    } finally {
        for (const f of kept) deps.release(f.frame);
    }
}
