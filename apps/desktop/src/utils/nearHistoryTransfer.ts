/**
 * Local ("near") history transfer, page side.
 *
 * The chat history is one backup container file (v4, `backupContainer.ts`). The page never touches the
 * network: it spools the container into the staging dir through the existing `backup*` bridge members,
 * hands the file path to the Rust host (`nearTransferSend`), and on the other device reads the received
 * file back with ranged reads. Memory is bounded: every IPC call carries at most `NEAR_IPC_CHUNK` bytes
 * and each is awaited before the next (that await is the back-pressure).
 *
 * Dependency-light on purpose: no React, no services. The caller supplies the container writer / importer.
 */
import { MAX_RAW_FRAME_BYTES, type ByteSink, type ByteSource } from './backupContainer';
import type { NearPartialFile, NearReceivedHistory, NearSnapshot, NearTransferStatus } from '../types/near';

/** Largest payload of any single IPC call made by this module. */
export const NEAR_IPC_CHUNK = 1024 * 1024;
/** The largest single `read` the file source will allocate for (a transfer container frame: attachment part + framing). A
 *  length the container's own index declares is peer-controlled; nothing larger is ever allocated from it (security round M2). */
export const NEAR_MAX_READ = MAX_RAW_FRAME_BYTES;

/** The bridge members this module uses (a structural subset of `window.electronAPI`). */
export interface NearHistoryApi {
    backupStagingDir: () => Promise<string>;
    backupBeginWrite: (dir: string, filename: string, mode?: 'fresh' | 'update') => Promise<{ sessionId: string; size: number }>;
    backupAppend: (sessionId: string, data: Uint8Array) => Promise<void>;
    backupWriteAt: (sessionId: string, offset: number, data: Uint8Array) => Promise<void>;
    backupCommit: (sessionId: string) => Promise<{ path: string; size: number }>;
    backupAbort: (sessionId: string) => Promise<void>;
    backupStat: (filePath: string) => Promise<{ size: number; mtimeMs: number } | null>;
    backupReadRange: (filePath: string, offset: number, length: number) => Promise<ArrayBuffer>;
    deleteFile: (path: string) => Promise<unknown>;
    nearGetState?: () => Promise<NearSnapshot>;
    onNearState?: (cb: (s: NearSnapshot) => void) => (() => void);
    nearCancel?: () => Promise<void>;
    nearTransferSend?: (opts: { path: string }) => Promise<void>;
    nearTransferReceive?: () => Promise<void>;
    nearTransferResult?: () => Promise<NearReceivedHistory | null>;
    nearTransferDiscard?: () => Promise<void>;
    nearTransferPause?: () => Promise<void>;
    nearTransferResume?: () => Promise<void>;
    nearTransferKeepPartial?: () => Promise<NearPartialFile>;
}

/** A transfer that ended in a non-`done` state. `code` is the host's stable error code (or the state name). */
export class NearTransferError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'NearTransferError';
        this.code = code;
    }
}

function abortError(): Error {
    const e = new Error('Transfer aborted');
    e.name = 'AbortError';
    return e;
}

// ── Spool sink ─────────────────────────────────────────────────────────────

export interface NearSpoolSink {
    sink: ByteSink;
    commit(): Promise<{ path: string; size: number }>;
    abort(): Promise<void>;
}

/** A `ByteSink` over a fresh file in the backup staging dir; oversize writes are split into <= 1 MiB IPC calls. */
export async function createNearSpoolSink(api: NearHistoryApi, fileName: string): Promise<NearSpoolSink> {
    const dir = await api.backupStagingDir();
    const { sessionId } = await api.backupBeginWrite(dir, fileName, 'fresh');
    let closed = false;

    const sink: ByteSink = {
        async write(bytes: Uint8Array): Promise<void> {
            for (let i = 0; i < bytes.length; i += NEAR_IPC_CHUNK) {
                await api.backupAppend(sessionId, bytes.subarray(i, Math.min(bytes.length, i + NEAR_IPC_CHUNK)));
            }
        },
        async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
            for (let i = 0; i < bytes.length; i += NEAR_IPC_CHUNK) {
                await api.backupWriteAt(sessionId, offset + i, bytes.subarray(i, Math.min(bytes.length, i + NEAR_IPC_CHUNK)));
            }
        },
    };

    return {
        sink,
        async commit() {
            closed = true;
            return api.backupCommit(sessionId);
        },
        async abort() {
            if (closed) return;
            closed = true;
            try { await api.backupAbort(sessionId); } catch { /* already gone */ }
        },
    };
}

// ── File source ────────────────────────────────────────────────────────────

/** A `ByteSource` over a staged file; each `read` is assembled from <= 1 MiB ranged reads. */
export function createNearFileSource(api: NearHistoryApi, path: string): ByteSource {
    const sizeNow = async (): Promise<number> => {
        const st = await api.backupStat(path);
        if (!st) throw new Error('History file is missing');
        return st.size;
    };
    return {
        size: sizeNow,
        async read(offset: number, length: number): Promise<Uint8Array> {
            if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || length > NEAR_MAX_READ) {
                throw new Error('Read out of range');
            }
            const total = await sizeNow();
            if (offset + length > total) throw new Error('Read out of range');
            const out = new Uint8Array(length);
            let done = 0;
            while (done < length) {
                const want = Math.min(NEAR_IPC_CHUNK, length - done);
                const buf = new Uint8Array(await api.backupReadRange(path, offset + done, want));
                if (buf.length !== want) throw new Error('Short read from history file');
                out.set(buf, done);
                done += want;
            }
            return out;
        },
    };
}

// ── Waiting for the host ───────────────────────────────────────────────────

const FAILED_STATES: ReadonlySet<string> = new Set(['failed', 'refused', 'cancelled', 'expired']);

/**
 * Track host snapshots until `done` (resolve) or a failed state (reject). Subscribes first, then reads the
 * current state once, then runs `start`, so a fast completion cannot be missed.
 */
async function runToTerminal(
    api: NearHistoryApi,
    start: () => Promise<void>,
    onProgress: ((t: NearTransferStatus) => void) | undefined,
    signal: AbortSignal | undefined,
): Promise<void> {
    if (!api.onNearState) throw new NearTransferError('unavailable', 'Local transfer is not available in this build');
    if (signal?.aborted) throw abortError();

    let lastSeq = -Infinity;
    let settle!: { resolve: () => void; reject: (e: Error) => void };
    const terminal = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    terminal.catch(() => { /* observed below; avoids an unhandled rejection while `start` runs */ });

    const apply = (s: NearSnapshot): void => {
        if (s.seq < lastSeq) return;
        lastSeq = s.seq;
        if (s.transfer && onProgress) onProgress(s.transfer);
        if (s.state === 'done') settle.resolve();
        else if (FAILED_STATES.has(s.state)) {
            settle.reject(new NearTransferError(s.error?.code ?? s.state, s.error?.message ?? `Transfer ${s.state}`));
        }
    };

    const onAbort = (): void => {
        void api.nearCancel?.().catch(() => { /* best effort */ });
        settle.reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const unsubscribe = api.onNearState(apply);
    try {
        if (api.nearGetState) {
            try { apply(await api.nearGetState()); } catch { /* the subscription still delivers */ }
        }
        await Promise.race([start(), terminal]);
        await terminal;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        try { unsubscribe(); } catch { /* ignore */ }
    }
}

// ── Send ───────────────────────────────────────────────────────────────────

export interface SendHistoryOptions {
    api: NearHistoryApi;
    /** Drives a `ContainerWriter` into the sink (supplied by the caller). */
    writeContainer: (sink: ByteSink) => Promise<void>;
    onProgress?: (t: NearTransferStatus) => void;
    signal?: AbortSignal;
}

export async function sendHistoryOverNear(opts: SendHistoryOptions): Promise<void> {
    const { api, writeContainer, onProgress, signal } = opts;
    if (!api.nearTransferSend) throw new NearTransferError('unavailable', 'Local transfer is not available in this build');
    if (signal?.aborted) throw abortError();

    const spool = await createNearSpoolSink(api, `near-history-${Date.now()}.enc`);
    let spooledPath: string | null = null;
    try {
        await writeContainer(spool.sink);
        const { path } = await spool.commit();
        spooledPath = path;
        if (signal?.aborted) throw abortError();
        await runToTerminal(api, () => api.nearTransferSend!({ path }), onProgress, signal);
    } catch (e) {
        await spool.abort();
        throw e;
    } finally {
        if (spooledPath) {
            try { await api.deleteFile(spooledPath); } catch { /* ignore */ }
        }
        // L4: the host's copy of K_xfer lives until a discard (else the idle timeout): the sender is finished with it the moment its
        // transfer is done or stopped, however it ended.
        try { await api.nearTransferDiscard?.(); } catch { /* best effort */ }
    }
}

// ── Receive ────────────────────────────────────────────────────────────────

export interface ReceiveHistoryOptions {
    api: NearHistoryApi;
    /** Imports the received container (supplied by the caller). */
    importContainer: (source: ByteSource, size: number) => Promise<void>;
    /** "Keep what arrived" (contract 11.10): true when the user chose to keep a stopped transfer's verified parts. */
    keepOnStop?: () => boolean;
    /** Applies only the records inside `ranges` of a stopped transfer's partial container. */
    importPartial?: (source: ByteSource, size: number, ranges: readonly (readonly [number, number])[]) => Promise<void>;
    onProgress?: (t: NearTransferStatus) => void;
    signal?: AbortSignal;
}

const TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'refused', 'cancelled', 'expired']);

/** After a stop the host reaches its terminal state asynchronously: wait for it (bounded) before asking for the partial file. */
async function waitForTerminal(api: NearHistoryApi, ms = 4000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { if (api.nearGetState && TERMINAL.has((await api.nearGetState()).state)) return; } catch { return; }
        await new Promise(r => setTimeout(r, 50));
    }
}

/** Keep what arrived of a stopped transfer: the host assembles the verified parts, the page applies the records inside them. */
async function keepWhatArrived(api: NearHistoryApi, importPartial: NonNullable<ReceiveHistoryOptions['importPartial']>): Promise<void> {
    if (!api.nearTransferKeepPartial) return;
    await waitForTerminal(api);
    let file: NearPartialFile | null = null;
    try {
        file = await api.nearTransferKeepPartial();
        await importPartial(createNearFileSource(api, file.path), file.size, file.ranges);
    } catch { /* nothing usable arrived (no parts, no key, not a partial): the stop is still a stop */ } finally {
        if (file) { try { await api.deleteFile(file.path); } catch { /* ignore */ } }
    }
}

export async function receiveHistoryOverNear(opts: ReceiveHistoryOptions): Promise<void> {
    const { api, importContainer, onProgress, signal, keepOnStop, importPartial } = opts;
    if (!api.nearTransferReceive || !api.nearTransferResult || !api.nearTransferDiscard) {
        throw new NearTransferError('unavailable', 'Local transfer is not available in this build');
    }
    try {
        await runToTerminal(api, () => api.nearTransferReceive!(), onProgress, signal);
        const result = await api.nearTransferResult();
        if (!result) throw new NearTransferError('no_result', 'Transfer finished but no history file is available');
        await importContainer(createNearFileSource(api, result.path), result.size);
    } catch (e) {
        // Stopped before `done` (the user's Cancel, or it could not resume): keep what arrived when they asked to.
        if (keepOnStop?.() && importPartial) await keepWhatArrived(api, importPartial);
        throw e;
    } finally {
        try { await api.nearTransferDiscard(); } catch { /* ignore */ }
    }
}
