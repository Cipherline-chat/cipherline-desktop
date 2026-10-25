/**
 * Personal-emoji image processor. Runs off the UI thread: decoding a big GIF
 * and encoding 60 WebP frames is real work.
 *
 * picture (any size, still or animated) -> 128 px square (crop or fit) ->
 *   still:     WebP, <= 16 KB where quality/size can get it there
 *   animation: animated WebP, <= 256 KB, <= 6 s, <= 60 frames
 *
 * Re-encoding through a canvas is also what strips metadata (EXIF, GPS, ICC,
 * XMP, comments): only pixels survive the draw.
 *
 * Decoding is `ImageDecoder` (WebCodecs) for animated formats, falling back to
 * `createImageBitmap` for stills. Encoding is `OffscreenCanvas.convertToBlob`;
 * animated output is assembled by the pure muxer in process/webpMux.ts.
 *
 * Protocol: process/protocol.ts. No dynamic imports (they break the worker
 * build); everything here is static.
 */
import { planFrame, type FrameMode } from '../utils/personalEmoji/process/geometry';
import { fitAnimated, fitStatic, decimateFrames, type TimedFrame } from '../utils/personalEmoji/process/budget';
import { muxAnimatedWebp } from '../utils/personalEmoji/process/webpMux';
import {
    EMOJI_INPUT_MAX_BYTES, EMOJI_MAX_DURATION_MS, EMOJI_MAX_OUTPUT_FRAMES, EMOJI_MAX_SOURCE_FRAMES,
    EMOJI_MIN_FRAME_MS, EMOJI_SOURCE_MAX_SIDE,
    type EmojiProcessErrorCode, type EmojiProcessRequest, type EmojiProcessResponse,
} from '../utils/personalEmoji/process/protocol';
import { PERSONAL_EMOJI_MAX_BYTES, PERSONAL_EMOJI_PX, PERSONAL_EMOJI_STATIC_TARGET_BYTES, isAnimatedImage, sniffImageMime } from '../utils/personalEmoji/token';

interface WorkerScope {
    onmessage: ((e: MessageEvent<EmojiProcessRequest>) => void) | null;
    postMessage(message: EmojiProcessResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

class ProcessError extends Error {
    readonly code: EmojiProcessErrorCode;
    constructor(code: EmojiProcessErrorCode, message: string) { super(message); this.code = code; }
}

/** Types ImageDecoder is asked to read as (animation-capable containers). */
const ANIMATED_CAPABLE = new Set(['image/gif', 'image/webp', 'image/png']);

function detectType(bytes: Uint8Array, declared: string): string | null {
    const s = sniffImageMime(bytes);
    if (s) return s;
    // AVIF/BMP/etc: let createImageBitmap decide, but only for image/* claims.
    return declared.startsWith('image/') && declared !== 'image/svg+xml' ? declared : null;
}

function newCanvas(side: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
    const canvas = new OffscreenCanvas(side, side);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new ProcessError('UNSUPPORTED', 'Canvas is not available.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { canvas, ctx };
}

/** Draw one decoded source (VideoFrame / ImageBitmap) into a fresh side x side canvas. */
function drawSquare(src: CanvasImageSource, srcW: number, srcH: number, side: number, mode: FrameMode): OffscreenCanvas {
    const { canvas, ctx } = newCanvas(side);
    const p = planFrame(srcW, srcH, side, mode);
    ctx.clearRect(0, 0, side, side);
    ctx.drawImage(src, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
    return canvas;
}

async function encodeWebp(canvas: OffscreenCanvas, quality: number): Promise<Uint8Array> {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (blob.type !== 'image/webp') throw new ProcessError('UNSUPPORTED', 'This system cannot encode WebP.');
    return new Uint8Array(await blob.arrayBuffer());
}

function checkSize(w: number, h: number): void {
    if (!(w > 0) || !(h > 0)) throw new ProcessError('NOT_AN_IMAGE', 'That picture is empty.');
    if (w > EMOJI_SOURCE_MAX_SIDE || h > EMOJI_SOURCE_MAX_SIDE) {
        throw new ProcessError('IMAGE_TOO_LARGE', `That picture is bigger than ${EMOJI_SOURCE_MAX_SIDE} px on a side.`);
    }
}

async function processStill(bitmap: ImageBitmap, mode: FrameMode) {
    checkSize(bitmap.width, bitmap.height);
    const base = drawSquare(bitmap, bitmap.width, bitmap.height, PERSONAL_EMOJI_PX, mode);
    const fit = await fitStatic(async (q, side) => {
        const c = side === PERSONAL_EMOJI_PX ? base : drawSquare(base, PERSONAL_EMOJI_PX, PERSONAL_EMOJI_PX, side, 'fit');
        return encodeWebp(c, q);
    }, PERSONAL_EMOJI_STATIC_TARGET_BYTES, PERSONAL_EMOJI_PX);
    return { bytes: fit.bytes, animated: false, frames: 1, width: fit.side, durationMs: 0, animationLost: false };
}

async function processAnimated(decoder: ImageDecoder, frameCount: number, mode: FrameMode, progress: (f: number) => void) {
    const frames: TimedFrame<ImageBitmap>[] = [];
    let total = 0;
    const limit = Math.min(frameCount, EMOJI_MAX_SOURCE_FRAMES);
    for (let i = 0; i < limit && total < EMOJI_MAX_DURATION_MS; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        try {
            checkSize(image.displayWidth, image.displayHeight);
            const canvas = drawSquare(image, image.displayWidth, image.displayHeight, PERSONAL_EMOJI_PX, mode);
            const ms = Math.max(EMOJI_MIN_FRAME_MS, Math.round((image.duration ?? 100_000) / 1000));
            const kept = Math.min(ms, EMOJI_MAX_DURATION_MS - total);
            frames.push({ frame: await createImageBitmap(canvas), durationMs: kept });
            total += kept;
        } finally {
            image.close();
        }
        progress(0.4 * ((i + 1) / limit));
    }
    if (frames.length === 0) throw new ProcessError('NOT_AN_IMAGE', 'Could not read any frames.');

    const capped = decimateFrames(frames, Math.ceil(frames.length / EMOJI_MAX_OUTPUT_FRAMES));
    let attempt = 0;
    try {
        const fit = await fitAnimated(capped, async (fs, q, side) => {
            progress(0.4 + Math.min(0.55, 0.06 * ++attempt));
            const stills: { webp: Uint8Array; durationMs: number }[] = [];
            for (const f of fs) {
                const c = newCanvas(side);
                c.ctx.drawImage(f.frame, 0, 0, PERSONAL_EMOJI_PX, PERSONAL_EMOJI_PX, 0, 0, side, side);
                stills.push({ webp: await encodeWebp(c.canvas, q), durationMs: f.durationMs });
            }
            return muxAnimatedWebp(stills, side, side);
        }, PERSONAL_EMOJI_MAX_BYTES, PERSONAL_EMOJI_PX);
        if (!fit) throw new ProcessError('TOO_COMPLEX', 'That animation is too detailed to fit in an emoji. Try a shorter or simpler one.');
        return {
            bytes: fit.bytes, animated: fit.keptFrames > 1, frames: fit.keptFrames, width: fit.side,
            durationMs: fit.frames.reduce((n, f) => n + f.durationMs, 0), animationLost: false,
        };
    } finally {
        for (const f of frames) f.frame.close();
    }
}

async function run(req: EmojiProcessRequest): Promise<EmojiProcessResponse> {
    const progress = (fraction: number) => scope.postMessage({ type: 'progress', fraction: Math.min(1, fraction) });
    if (req.file.size > EMOJI_INPUT_MAX_BYTES) throw new ProcessError('INPUT_TOO_LARGE', 'That file is bigger than 25 MB.');
    const bytes = new Uint8Array(await req.file.arrayBuffer());
    const type = detectType(bytes, req.file.type);
    if (!type) throw new ProcessError('NOT_AN_IMAGE', 'That file is not a picture this app can read.');

    if (typeof ImageDecoder !== 'undefined' && ANIMATED_CAPABLE.has(type) && await ImageDecoder.isTypeSupported(type)) {
        const decoder = new ImageDecoder({ data: bytes, type });
        try {
            await decoder.completed;
            await decoder.tracks.ready;
            const track = decoder.tracks.selectedTrack;
            if (track && track.frameCount > 1) {
                const r = await processAnimated(decoder, track.frameCount, req.mode, progress);
                return { type: 'done', mime: 'image/webp', ...r };
            }
        } finally {
            decoder.close();
        }
    }

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
    } catch {
        throw new ProcessError('NOT_AN_IMAGE', 'That file could not be read as a picture.');
    }
    try {
        progress(0.3);
        const r = await processStill(bitmap, req.mode);
        // The file WAS animated but this system could not decode the frames
        // (ImageDecoder missing): say so rather than silently saving frame 1.
        return { type: 'done', mime: 'image/webp', ...r, animationLost: isAnimatedImage(bytes, type) };
    } finally {
        bitmap.close();
    }
}

scope.onmessage = (e) => {
    if (e.data?.type !== 'process') return;
    run(e.data).then(
        (res) => scope.postMessage(res, res.type === 'done' ? [res.bytes.buffer] : []),
        (err) => {
            const code = err instanceof ProcessError ? err.code : 'FAILED';
            const message = err instanceof ProcessError ? err.message : 'Something went wrong processing that picture.';
            scope.postMessage({ type: 'error', code, message });
        },
    );
};
