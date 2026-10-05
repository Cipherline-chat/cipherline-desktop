/**
 * Runs attachment / saved-GIF AES-GCM off the UI thread.
 *
 * WebCrypto's cipher itself already runs on a Chromium worker thread, but the
 * work around it does not: `Blob.arrayBuffer()`'s result, the copy WebCrypto
 * takes of its input, the result ArrayBuffer and the copy `new Blob([...])`
 * makes into blob storage are all full-size copies on the calling thread.
 * Measured in the real Electron renderer (perf/files-idle/encbench.cjs,
 * medians of 3): encrypting a 5 MB file blocked the UI for 119 ms, a 40 MB GIF
 * for 577 ms, a 200 MB video for 2.6 s; the same calls through this worker
 * blocked it for 22 / 28 / 17 ms, with the same wall time and peak memory.
 * Decrypt has the identical shape (every received image, GIF and video).
 *
 * Same algorithm, same bytes: both paths run utils/attachmentCryptoCore.ts.
 * Any worker failure to START (no Worker, CSP, load error) falls back to the
 * in-thread path, so this can never be the reason a file fails to send or
 * show; a genuine crypto error (bad key, tampered ciphertext) is reported as
 * the same DOMException name the in-thread call would raise.
 *
 * The worker is created on first use and terminated after IDLE_MS without
 * work, so an idle app holds no extra thread.
 */
import { encryptBlobCore, decryptBlobCore } from './attachmentCryptoCore';

const IDLE_MS = 30_000;

type Pending = { resolve: (v: { blob: Blob; ivB64?: string }) => void; reject: (e: unknown) => void };

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function failAll(err: unknown): void {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
}

function stop(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    try { worker?.terminate(); } catch { /* gone */ }
    worker = null;
}

function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (pending.size === 0) stop(); else armIdle(); }, IDLE_MS);
}

class WorkerUnavailable extends Error {}

async function getWorker(): Promise<Worker> {
    if (worker) return worker;
    if (broken || typeof Worker === 'undefined') throw new WorkerUnavailable('no worker');
    try {
        const { default: Ctor } = await import('../workers/attachmentCrypto.worker?worker');
        if (worker) return worker; // a concurrent caller won the race
        const w = new Ctor();
        w.onmessage = (e: MessageEvent) => {
            const m = e.data as { id: number; ok: boolean; blob?: Blob; ivB64?: string; name?: string; message?: string };
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            if (m.ok && m.blob) p.resolve({ blob: m.blob, ivB64: m.ivB64 });
            else p.reject(new DOMException(m.message ?? 'Attachment crypto failed', m.name ?? 'OperationError'));
        };
        w.onerror = (e) => {
            // The script itself died (failed to load / threw at top level):
            // stop using workers for this session and let callers fall back.
            e.preventDefault?.();
            broken = true;
            stop();
            failAll(new WorkerUnavailable('worker error'));
        };
        worker = w;
        return w;
    } catch {
        broken = true;
        throw new WorkerUnavailable('worker import failed');
    }
}

async function viaWorker(msg: Record<string, unknown>): Promise<{ blob: Blob; ivB64?: string }> {
    const w = await getWorker();
    const id = ++seq;
    const result = new Promise<{ blob: Blob; ivB64?: string }>((resolve, reject) => pending.set(id, { resolve, reject }));
    try {
        w.postMessage({ id, ...msg });
    } catch (err) {
        // e.g. a non-cloneable key — not a worker outage; fall back for this call.
        pending.delete(id);
        throw new WorkerUnavailable(String(err));
    }
    armIdle();
    return result;
}

export async function encryptBlobOffThread(file: Blob, key: CryptoKey, bundleIv: boolean): Promise<{ encryptedBlob: Blob; ivB64: string }> {
    try {
        const r = await viaWorker({ op: 'enc', blob: file, key, bundleIv });
        return { encryptedBlob: r.blob, ivB64: r.ivB64! };
    } catch (err) {
        if (!(err instanceof WorkerUnavailable)) throw err;
        return encryptBlobCore(file, key, bundleIv);
    }
}

export async function decryptBlobOffThread(encryptedBlob: Blob, key: CryptoKey, ivB64: string | null, type: string): Promise<Blob> {
    try {
        return (await viaWorker({ op: 'dec', blob: encryptedBlob, key, ivB64, type })).blob;
    } catch (err) {
        if (!(err instanceof WorkerUnavailable)) throw err;
        return decryptBlobCore(encryptedBlob, key, ivB64, type);
    }
}

/** Tests only. */
export function __resetAttachmentCryptoWorkerForTests(): void {
    stop();
    failAll(new WorkerUnavailable('reset'));
    broken = false;
}
