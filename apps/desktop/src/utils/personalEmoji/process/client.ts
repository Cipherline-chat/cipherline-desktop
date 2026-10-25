/**
 * Page-side handle on the emoji processing worker: one short-lived worker per
 * job, so cancelling is `terminate()` and a stuck decode can never wedge the
 * next one. Never blocks the UI thread.
 */
import type { FrameMode } from './geometry';
import type { EmojiProcessErrorCode, EmojiProcessResponse } from './protocol';

export interface ProcessedEmoji {
    bytes: Uint8Array;
    mime: 'image/webp';
    animated: boolean;
    frames: number;
    width: number;
    durationMs: number;
    animationLost: boolean;
}

export class EmojiProcessError extends Error {
    readonly code: EmojiProcessErrorCode | 'CANCELLED';
    constructor(code: EmojiProcessErrorCode | 'CANCELLED', message: string) { super(message); this.code = code; }
}

export interface ProcessHandle {
    result: Promise<ProcessedEmoji>;
    cancel(): void;
}

/** Test seam: how a worker is made. */
type WorkerFactory = () => Pick<Worker, 'postMessage' | 'terminate'> & {
    onmessage: ((e: MessageEvent<EmojiProcessResponse>) => void) | null;
    onerror: ((e: ErrorEvent) => void) | null;
};

const defaultFactory: WorkerFactory = () => new Worker(
    new URL('../../../workers/personalEmoji.worker.ts', import.meta.url),
    { type: 'module', name: 'personal-emoji' },
) as unknown as ReturnType<WorkerFactory>;

export function processEmojiImage(
    file: Blob,
    mode: FrameMode,
    onProgress?: (fraction: number) => void,
    makeWorker: WorkerFactory = defaultFactory,
): ProcessHandle {
    let worker: ReturnType<WorkerFactory> | null = null;
    let rejectFn: (e: EmojiProcessError) => void = () => {};
    const result = new Promise<ProcessedEmoji>((resolve, reject) => {
        rejectFn = reject;
        try {
            worker = makeWorker();
        } catch {
            reject(new EmojiProcessError('UNSUPPORTED', 'Image processing is not available here.'));
            return;
        }
        worker.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'progress') { onProgress?.(m.fraction); return; }
            worker?.terminate(); worker = null;
            if (m.type === 'done') {
                resolve({ bytes: m.bytes, mime: m.mime, animated: m.animated, frames: m.frames, width: m.width, durationMs: m.durationMs, animationLost: m.animationLost });
            } else {
                reject(new EmojiProcessError(m.code, m.message));
            }
        };
        worker.onerror = () => {
            worker?.terminate(); worker = null;
            reject(new EmojiProcessError('FAILED', 'Something went wrong processing that picture.'));
        };
        worker.postMessage({ type: 'process', file, mode });
    });
    return {
        result,
        cancel() {
            if (!worker) return;
            worker.terminate(); worker = null;
            rejectFn(new EmojiProcessError('CANCELLED', 'Cancelled'));
        },
    };
}
