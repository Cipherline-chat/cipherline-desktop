/**
 * Runs one document-preview parse in its own Worker
 * (workers/documentPreview.worker.ts) and gives up on it after a timeout.
 *
 * A fresh worker per job, terminated as soon as it answers or the time runs
 * out: terminating is the only way to stop a parser that is still inflating a
 * crafted file, and it releases everything that parser allocated. There is no
 * main-thread fallback on purpose; a file that cannot be parsed off-thread is
 * not previewed (it can still be downloaded).
 */
import { PARSE_TIMEOUT_MS, type InflateLimits } from './documentPreview';
import type { DocumentPreviewRequest, DocumentPreviewResponse } from '../workers/documentPreview.worker';

export type DocumentPreviewResult =
    | DocumentPreviewResponse
    | { ok: false; reason: 'timeout' | 'unavailable'; message: string };

/** The part of Worker used here — a test can supply a fake. */
export interface PreviewWorkerLike {
    postMessage(message: DocumentPreviewRequest, transfer?: Transferable[]): void;
    terminate(): void;
    onmessage: ((e: MessageEvent<DocumentPreviewResponse>) => void) | null;
    onerror: ((e: ErrorEvent) => void) | null;
}

type Factory = () => Promise<PreviewWorkerLike>;

const defaultFactory: Factory = async () => {
    const { default: Ctor } = await import('../workers/documentPreview.worker?worker');
    return new Ctor() as unknown as PreviewWorkerLike;
};

let factory: Factory = defaultFactory;

/** Tests only: swap the worker constructor (`null` restores the real one). */
export function __setDocumentPreviewWorkerFactory(f: Factory | null): void {
    factory = f ?? defaultFactory;
}

export async function parseDocumentPreview(
    kind: 'excel' | 'word',
    buf: ArrayBuffer,
    limits: InflateLimits,
    timeoutMs: number = PARSE_TIMEOUT_MS,
): Promise<DocumentPreviewResult> {
    let worker: PreviewWorkerLike;
    try {
        worker = await factory();
    } catch (err) {
        return { ok: false, reason: 'unavailable', message: String(err) };
    }
    return new Promise<DocumentPreviewResult>(resolve => {
        let done = false;
        const finish = (r: DocumentPreviewResult) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { worker.terminate(); } catch { /* already gone */ }
            resolve(r);
        };
        const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', message: `no answer in ${timeoutMs} ms` }), timeoutMs);
        worker.onmessage = e => finish(e.data);
        worker.onerror = e => {
            e?.preventDefault?.();
            finish({ ok: false, reason: 'unavailable', message: e?.message ?? 'worker error' });
        };
        try {
            // Transfer, not copy: the buffer is not used on this side again.
            worker.postMessage({ kind, buf, limits }, [buf]);
        } catch (err) {
            finish({ ok: false, reason: 'unavailable', message: String(err) });
        }
    });
}
