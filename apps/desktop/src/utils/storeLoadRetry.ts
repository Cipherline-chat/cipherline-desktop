/**
 * Which failures of the boot-time store load are worth trying again, and how.
 *
 * WHY: a user's laptop booted into StorageReadFailedScreen ("Couldn't read your
 * data on this device") although the key unlocked fine — IndexedDB refused the
 * open or the read. On Windows the usual causes are something holding the
 * LevelDB files for a moment at login (antivirus scanning them, OneDrive or the
 * indexer, a Cipherline process from the previous session still exiting), and
 * those clear on their own within seconds. Declaring the store unread on the
 * first refusal turned a hiccup into a whole session without history.
 *
 * WHAT IS RETRIED: only failures that say "not right now" rather than "this is
 * wrong" — Chromium's generic UnknownError (which is what a held or briefly
 * unavailable backing store surfaces as: "Internal error opening backing
 * store"), AbortError, InvalidStateError (a connection closing under us),
 * TimeoutError, and the `securekv:open` IPC rejecting (main not ready yet).
 * A VersionError, DataError, NotFoundError, SecurityError or "IndexedDB
 * unavailable" will say the same thing in ten seconds, so they fail at once.
 *
 * Retrying is safe because the load is read-only: nothing is written until
 * hydrate() resolves, and a retry starts from an empty in-memory map.
 */

/** Where the load failed: opening the database, reading its records, or main decrypting them. */
export type StoreLoadStage = 'open' | 'read' | 'ipc';

/** Delays before attempts 2, 3 and 4 — four attempts over about seven seconds. */
export const STORE_LOAD_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

const TRANSIENT_NAMES = new Set(['UnknownError', 'AbortError', 'InvalidStateError', 'TimeoutError']);
const IPC_TRANSIENT_RE = /Error invoking remote method|reply was never sent|No handler registered|object has been destroyed/i;

/** An error from one stage of the load, carrying that stage. The cause keeps its own name. */
export class StoreLoadStageError extends Error {
    readonly stage: StoreLoadStage;
    readonly cause: unknown;
    constructor(stage: StoreLoadStage, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'StoreLoadStageError';
        this.stage = stage;
        this.cause = cause;
    }
}

export interface StoreLoadFailureInfo {
    stage: StoreLoadStage;
    /** The DOMException / Error name, label-safe (letters only, ≤ 40), or 'Error'. */
    name: string;
    transient: boolean;
}

const NAME_RE = /^[A-Za-z]{1,40}$/;

/** A label-safe name for an error: never a message, a path or an id. */
export function storeErrorName(e: unknown): string {
    const n = (e as { name?: unknown } | null)?.name;
    return typeof n === 'string' && NAME_RE.test(n) ? n : 'Error';
}

function messageOf(e: unknown): string {
    if (e && typeof e === 'object' && 'message' in e) {
        const m = (e as { message?: unknown }).message;
        return typeof m === 'string' ? m : '';
    }
    return typeof e === 'string' ? e : '';
}

/**
 * Classify a load failure. An untagged error is treated as a read failure
 * (the stage that covers the cursor), which is never retried for a
 * non-transient name, so an unexpected programming error still fails fast.
 */
export function classifyStoreLoadError(e: unknown): StoreLoadFailureInfo {
    const stage: StoreLoadStage = e instanceof StoreLoadStageError ? e.stage : 'read';
    const cause = e instanceof StoreLoadStageError ? e.cause : e;
    const name = storeErrorName(cause);
    const msg = messageOf(cause);
    let transient: boolean;
    if (stage === 'ipc') {
        transient = IPC_TRANSIENT_RE.test(msg) || TRANSIENT_NAMES.has(name);
    } else if (/IndexedDB unavailable/i.test(msg)) {
        transient = false;
    } else {
        transient = TRANSIENT_NAMES.has(name) || /backing store/i.test(msg);
    }
    return { stage, name, transient };
}
