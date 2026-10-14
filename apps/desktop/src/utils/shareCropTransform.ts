/**
 * The frame-by-frame half of the ultra-wide crop (shareCrop.ts): one decoded
 * `VideoFrame` of the whole display in, one `VideoFrame` of a single screen
 * out - or the frame passed through untouched for the "whole display" layout.
 *
 * Runs in a dedicated worker (workers/shareCropWorker.ts) so a busy main
 * thread cannot stall a 90 fps stream, and on the main thread when workers
 * cannot take the streams. Nothing here touches the DOM, `window` or LiveKit,
 * so the same code is unit tested with fake frames (shareCrop.test.ts).
 *
 * The crop is ZERO-COPY: `new VideoFrame(frame, { visibleRect })` re-views the
 * same pixel buffer through a different rectangle; no pixel is read or moved.
 *
 * FRAME LIFETIME - the thing that goes wrong at 90 fps. A VideoFrame holds a
 * (possibly GPU) buffer from a small fixed pool until it is closed, and an
 * unclosed frame is not merely a leak: the capturer runs out of buffers and
 * stops delivering. So every code path here ends with the INPUT frame closed
 * (the cropped output is a new object that owns its own reference), a crop that
 * throws drops that one frame and keeps going, and a passed-through frame is
 * handed on UNclosed (its new owner closes it).
 *
 * Privacy: only integers about frame sizes are ever reported; no pixels, no
 * names.
 */
import { sliceRect, type CropRect, type ShareLayout } from './shareLayout';

/** The slice of a WebCodecs VideoFrame this needs. */
export interface CropFrame {
    codedWidth: number;
    codedHeight: number;
    visibleRect?: { x: number; y: number; width: number; height: number } | null;
    close(): void;
}

export interface CropStats {
    /** Frames received. */
    framesIn: number;
    /** Frames handed on (cropped or passed through). */
    framesOut: number;
    /** Frames dropped because the crop threw. */
    errors: number;
}

export interface CropSize {
    /** Whole-display size as the frames arrive. */
    sourceWidth: number;
    sourceHeight: number;
    /** What leaves this stage. */
    outWidth: number;
    outHeight: number;
}

export interface CropDeps<F extends CropFrame> {
    /** The CURRENT layout; read for every frame, so a switch takes effect on the next one. */
    getLayout(): ShareLayout;
    /** Make the cropped frame: `new VideoFrame(frame, { visibleRect: rect, ... })`. The input is NOT closed here. */
    cropFrame(frame: F, rect: CropRect): F;
    /** Called when the source or output size changes (and for the first frame). */
    onSize?(size: CropSize): void;
}

export interface CropTransformer<F extends CropFrame> extends Transformer<F, F> {
    readonly stats: CropStats;
}

/** Build the Transformer for `new TransformStream(...)`. */
export function createCropTransformer<F extends CropFrame>(deps: CropDeps<F>): CropTransformer<F> {
    const stats: CropStats = { framesIn: 0, framesOut: 0, errors: 0 };
    let lastSize: CropSize | null = null;

    const report = (size: CropSize) => {
        if (lastSize
            && lastSize.sourceWidth === size.sourceWidth && lastSize.sourceHeight === size.sourceHeight
            && lastSize.outWidth === size.outWidth && lastSize.outHeight === size.outHeight) return;
        lastSize = size;
        try { deps.onSize?.(size); } catch { /* a size listener must never cost a frame */ }
    };

    return {
        stats,
        transform(frame, controller) {
            stats.framesIn++;
            let passedOn = false;
            let out: F | null = null;
            try {
                const vr = frame.visibleRect;
                const srcW = vr?.width ?? frame.codedWidth;
                const srcH = vr?.height ?? frame.codedHeight;
                const layout = deps.getLayout();
                if (layout.kind !== 'slice') {
                    report({ sourceWidth: srcW, sourceHeight: srcH, outWidth: srcW, outHeight: srcH });
                    controller.enqueue(frame);
                    passedOn = true;
                    stats.framesOut++;
                    return;
                }
                const r = sliceRect(srcW, srcH, layout.count, layout.index);
                // The rect is relative to the frame's own visible area; VideoFrame
                // wants it in coded coordinates.
                const rect: CropRect = { x: r.x + (vr?.x ?? 0), y: r.y + (vr?.y ?? 0), width: r.width, height: r.height };
                out = deps.cropFrame(frame, rect);
                report({ sourceWidth: srcW, sourceHeight: srcH, outWidth: rect.width, outHeight: rect.height });
                controller.enqueue(out);
                out = null; // ownership moved downstream
                stats.framesOut++;
            } catch {
                stats.errors++;
                // enqueue can throw after the crop succeeded (a cancelled
                // stream): the cropped frame is ours to close then.
                if (out) { try { out.close(); } catch { /* already closed */ } }
            } finally {
                if (!passedOn) { try { frame.close(); } catch { /* already closed */ } }
            }
        },
    };
}

/** The default `cropFrame`: a zero-copy re-view of the frame through `rect`. */
export function cropVideoFrame(frame: VideoFrame, rect: CropRect): VideoFrame {
    return new VideoFrame(frame, {
        visibleRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        // The new frame's display size is its visible size (the default for a
        // visibleRect init is derived from the SOURCE's display aspect, which
        // would be wrong for a slice of a very wide display).
        displayWidth: rect.width,
        displayHeight: rect.height,
    });
}

/**
 * Wire readable -> crop -> writable and return a stop() that cancels the pipe.
 * Shared by the worker and the main-thread fallback. Resolves when the pipe
 * ends (source track ended, stop() called, or the sink errored).
 */
export function runCropPipe<F extends CropFrame>(
    readable: ReadableStream<F>,
    writable: WritableStream<F>,
    deps: CropDeps<F>,
): { done: Promise<void>; stop(): void; stats: CropStats } {
    const transformer = createCropTransformer(deps);
    const ac = new AbortController();
    // Small queues: a frame waiting in a queue is a frame the capturer's pool
    // is short of. Better to drop the oldest than to lag by seconds.
    const ts = new TransformStream<F, F>(transformer, { highWaterMark: 1 }, { highWaterMark: 1 });
    const done = readable.pipeThrough(ts, { signal: ac.signal }).pipeTo(writable, { signal: ac.signal })
        .catch(() => { /* aborted / sink closed: the normal way a pipe ends */ });
    return { done, stop: () => ac.abort(), stats: transformer.stats };
}
