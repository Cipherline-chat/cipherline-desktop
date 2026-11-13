/**
 * Page-side handle on the animated-crop worker: one short-lived worker per
 * job, so cancelling is `terminate()` and a stuck decode can never wedge the
 * next one. Never blocks the UI thread.
 *
 * Deliberately free of DOM-only types (no WebCodecs here): the website
 * reaches this through ClImageCropper's `@app-cl` alias.
 */
import { cropSourceRect, type CropTransform } from '../imageCrop';
import {
    animatedOutputSize, type AnimatedCropErrorCode, type AnimatedCropResponse,
} from './protocol';

export interface AnimatedCropResult {
    blob: Blob;
    frames: number;
    width: number;
    height: number;
    durationMs: number;
    /** The source was longer than the kept limit and was cut. */
    trimmed: boolean;
}

export class AnimatedCropFailure extends Error {
    readonly code: AnimatedCropErrorCode | 'CANCELLED';
    constructor(code: AnimatedCropErrorCode | 'CANCELLED', message: string) { super(message); this.code = code; }
}

export interface AnimatedCropHandle {
    result: Promise<AnimatedCropResult>;
    cancel(): void;
}

/** Test seam: how a worker is made. */
type WorkerFactory = () => Pick<Worker, 'postMessage' | 'terminate'> & {
    onmessage: ((e: MessageEvent<AnimatedCropResponse>) => void) | null;
    onerror: ((e: ErrorEvent) => void) | null;
};

// Spelled EXACTLY `new Worker(new URL('...', import.meta.url), ...)`: the only
// form Vite bundles into a worker chunk (see utils/workerBundling.test.ts).
const defaultFactory: WorkerFactory = () => new Worker(
    new URL('../../workers/animatedCrop.worker.ts', import.meta.url),
    { type: 'module', name: 'animated-crop' },
) as unknown as ReturnType<WorkerFactory>;

/** Can this runtime crop an animation? (WebCodecs' ImageDecoder + OffscreenCanvas; always true in Electron.) */
export function supportsAnimatedCrop(): boolean {
    const g = globalThis as { ImageDecoder?: unknown; OffscreenCanvas?: unknown; Worker?: unknown };
    return typeof g.ImageDecoder === 'function' && typeof g.OffscreenCanvas === 'function' && typeof g.Worker === 'function';
}

/**
 * Crop EVERY frame of an animated GIF / WebP to the framed rectangle and
 * re-encode it as one animated WebP. `t`/`frameW`/`frameH` are the cropper's
 * own transform and frame (so the result is what the preview showed);
 * `naturalW/H` the decoded image's size; `outW/H` the still preset, from which
 * the (smaller) animated size is derived.
 */
export function cropAnimatedImage(
    file: Blob,
    t: CropTransform,
    frameW: number, frameH: number,
    naturalW: number, naturalH: number,
    outW: number, outH: number,
    onProgress?: (fraction: number) => void,
    makeWorker: WorkerFactory = defaultFactory,
): AnimatedCropHandle {
    let worker: ReturnType<WorkerFactory> | null = null;
    let rejectFn: (e: AnimatedCropFailure) => void = () => {};
    const result = new Promise<AnimatedCropResult>((resolve, reject) => {
        rejectFn = reject;
        const rect = naturalW > 0 && naturalH > 0 ? cropSourceRect(naturalW, naturalH, t, frameW, frameH) : null;
        if (!rect) { reject(new AnimatedCropFailure('NOT_AN_IMAGE', 'That image has no usable size.')); return; }
        try {
            worker = makeWorker();
        } catch {
            reject(new AnimatedCropFailure('UNSUPPORTED', 'Cropping an animation is not available here.'));
            return;
        }
        const out = animatedOutputSize(outW, outH);
        worker.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'progress') { onProgress?.(m.fraction); return; }
            worker?.terminate(); worker = null;
            if (m.type === 'done') {
                // Copy into a fresh buffer: a transferred view may be a subarray of a larger one.
                resolve({
                    blob: new Blob([m.bytes as BlobPart], { type: m.mime }),
                    frames: m.frames, width: m.width, height: m.height, durationMs: m.durationMs, trimmed: m.trimmed,
                });
            } else {
                reject(new AnimatedCropFailure(m.code, m.message));
            }
        };
        worker.onerror = () => {
            worker?.terminate(); worker = null;
            reject(new AnimatedCropFailure('FAILED', 'Something went wrong cropping that animation.'));
        };
        worker.postMessage({ type: 'crop', file, rect, naturalW, naturalH, outW: out.width, outH: out.height });
    });
    return {
        result,
        cancel() {
            if (!worker) return;
            worker.terminate(); worker = null;
            rejectFn(new AnimatedCropFailure('CANCELLED', 'Cancelled'));
        },
    };
}
