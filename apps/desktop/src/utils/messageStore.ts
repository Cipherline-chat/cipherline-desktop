import { secureLocalStore } from './secureLocalStore';

/**
 * Per-conversation message persistence.
 *
 * HISTORY: all DM history lived in ONE record (`cipherline_msgs_<uid>`) and all
 * channel history in another. Every write was a full snapshot of everything,
 * so persisting one new message meant re-serializing the entire history. The
 * coalescing writer removed the per-message cost, but the *shape* still means
 * one 20MB re-encrypt to record a one-line message, and one all-or-nothing
 * record whose corruption loses every conversation at once.
 *
 * This module keeps the monolithic `Record<id, Msg[]>` INTERFACE — every
 * caller still hands over / receives the same map it always did — while
 * storing one record per conversation underneath:
 *
 *     cipherline_msgs_<uid>_<conversationId>
 *     cipherline_channel_msgs_<uid>_<channelId>
 *
 * Keeping the interface is deliberate: the call sites include the backup/restore
 * vault path, where a subtle behaviour change produces backups that look fine
 * and turn out to be incomplete only when someone tries to restore one.
 *
 * KEY SHAPE: the userId stays embedded because secureLocalStore derives the
 * per-account encryption subkey from a userId found in the key (see ownerFor).
 * `cipherline_msgs_<uid>_<cid>` contains `_<uid>_`, so it still resolves to the
 * per-account tier. The prefixes also still match DEFERRED_PREFIXES, so message
 * records stay out of the boot-blocking hydrate.
 *
 * READS ARE ASYNC on purpose — they await secureLocalStore.hydrateMessages()
 * internally so no caller can read history before phase 2 has landed and
 * conclude the device has none. That mistake is not hypothetical: it would make
 * HistorySyncBanner offer to pull history from another device onto a device
 * that already has it, overwriting it.
 *
 * `hydrateMessages()` ALONE IS NOT ENOUGH, and used to be all we awaited. It
 * guards exactly one thing: the deferred phase-2 decrypt on a COLD START. After
 * any in-session account switch it is a no-op — `onUserChanged` latches
 * `messagesHydrated = true` when it loads the new account eagerly, and that
 * latch survives the next sign-out, so on the way back in `hydrateMessages()`
 * returns instantly while the account's records are not in memory yet. So these
 * reads await `whenAccountReady()` too, and re-check `isAccountReady(userId)`
 * after it (the awaited account can change underneath us).
 */

export type ThreadMap = Record<string, any[]>;
export type MessageKind = 'dm' | 'channel';

const legacyKey = (kind: MessageKind, userId: string) =>
    kind === 'dm' ? `cipherline_msgs_${userId}` : `cipherline_channel_msgs_${userId}`;

/** Trailing underscore matters — it's what stops the legacy key (which has no
 *  suffix) from being picked up as if it were a per-thread record. */
const threadPrefix = (kind: MessageKind, userId: string) => `${legacyKey(kind, userId)}_`;

/**
 * What we last wrote per storage key, so saveAll can skip threads that haven't
 * changed and delete ones that disappeared. Reference equality is the right
 * test: React state updates replace the arrays that changed and keep the
 * identity of the ones that didn't.
 */
const lastWritten = new Map<string, any[]>();

/**
 * `lastWritten` is ALSO the in-memory copy of every thread record, so
 * secureLocalStore does not need to keep the record's JSON text once it is on
 * disk (it was a second, often two-byte, copy of the whole history — 23 MB for
 * a 30k-message account, measured). Every write and read below vouches for the
 * record with markDetachable(); the store then drops the text and, on the rare
 * read that needs it, asks for it back here.
 *
 * Holds because `lastWritten` is only ever replaced alongside a write
 * (saveAll / mergeThreads / replaceAll), a read that parsed the stored value
 * (loadAll's seed), or a removeItem — and because these arrays are never mutated
 * in place (saveAll's reference-equality change detection already depends on
 * that; a mutated array would never be persisted at all).
 */
const regenerateThread = (key: string): string | null => {
    const msgs = lastWritten.get(key);
    return msgs ? JSON.stringify(msgs) : null;
};
// Optional calls: detaching is purely a memory optimisation, and a store that
// does not offer it (a partial test double) simply keeps the text, as before.
type DetachingStore = {
    registerDetachableSource?: (prefix: string, regenerate: (key: string) => string | null) => void;
    markDetachable?: (key: string) => void;
    isDetached?: (key: string) => boolean;
};
const detaching = secureLocalStore as unknown as DetachingStore;
const markDetachable = (key: string): void => { detaching.markDetachable?.(key); };
const isDetached = (key: string): boolean => detaching.isDetached?.(key) ?? false;
detaching.registerDetachableSource?.('cipherline_msgs_', regenerateThread);
detaching.registerDetachableSource?.('cipherline_channel_msgs_', regenerateThread);

/**
 * Monotonic write counter + the sequence number of the last write to each
 * thread key. This exists ONLY because loadAll() now yields (see YIELD_BATCH):
 * the read loop used to be one synchronous pass, so nothing could be persisted
 * part-way through it. Now a message can arrive and be written during a yield,
 * and for a thread the loop has ALREADY parsed the returned snapshot would be
 * stale. Dashboard hands that snapshot straight to setMessagesState, and the
 * next saveAll would then write the stale array back over the newer record —
 * losing a message whose only copy is local, because the server deletes the
 * envelope once it is ACKed.
 *
 * Same never-clobber discipline secureLocalStore.hydrateMessages() applies for
 * the identical reason; see the comment at its per-key guard.
 */
let writeSeq = 0;
const lastWriteSeq = new Map<string, number>();

function noteWrite(key: string): void {
    lastWriteSeq.set(key, ++writeSeq);
}

/**
 * How many threads are parsed / re-serialised before the loop hands the main
 * thread back. Mirrors secureLocalStore's HYDRATE_BATCH, and for the same
 * reason: these loops run in the Dashboard's mount effect, just after first
 * paint and while the Screen Lock overlay (when configured) is the focused UI
 * and taking keystrokes. A single unyielded pass over every conversation is
 * one long task, and Windows marks a window "Not Responding" when input is
 * delivered to a thread that doesn't service it — so the freeze is most
 * visible to exactly the users who are typing a PIN at that moment.
 *
 * Batching does not reduce the total work; it splits it into tasks short
 * enough that input keeps being processed throughout.
 */
const YIELD_BATCH = 8;

/**
 * Thrown when history was asked for while the account's namespace is not in
 * memory. Distinct from "there is no history" ON PURPOSE — callers that gate a
 * destructive offer on emptiness must be able to tell the two apart, and the
 * type system is the only thing that makes the difference impossible to ignore.
 */
export class HistoryNotReadableError extends Error {
    constructor(userId: string) {
        super(`local history for ${userId} is not readable yet`);
        this.name = 'HistoryNotReadableError';
    }
}

/**
 * Wait for `userId`'s records to be in memory, and say whether they are.
 * See the module docstring for why `hydrateMessages()` alone does not do this.
 */
async function awaitReadable(userId: string): Promise<boolean> {
    await secureLocalStore.hydrateMessages();
    await secureLocalStore.whenAccountReady();
    // Phase 2 is latched per account-generation, so re-await it after the
    // rebind: an in-session sign-in loads history inside whenAccountReady(),
    // but a cold start still needs the deferred decrypt.
    await secureLocalStore.hydrateMessages();
    // Belt and braces: the account can change while we are awaiting.
    return secureLocalStore.isAccountReady(userId);
}

/** Hand the main thread back so queued input/paint work can run. Prefers the
 *  scheduler API (yields without a full timer round-trip) where present. */
function yieldToEventLoop(): Promise<void> {
    const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof s?.yield === 'function') return s.yield();
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** Remember a full map as the current on-disk truth (post-load / post-replace). */
function seed(kind: MessageKind, userId: string, map: ThreadMap): void {
    const prefix = threadPrefix(kind, userId);
    for (const k of [...lastWritten.keys()]) if (k.startsWith(prefix)) lastWritten.delete(k);
    for (const [id, msgs] of Object.entries(map)) lastWritten.set(prefix + id, msgs);
}

/**
 * One-time split of the legacy single-record blob into per-thread records.
 *
 * Idempotent and crash-safe by construction. An existing per-thread record is
 * never overwritten (a half-finished earlier migration must not clobber writes
 * made since), and the legacy record is only tombstoned after every thread has
 * been written into the in-memory map. If the process dies before the flush,
 * the tombstone never reaches disk, the legacy record is still there, and the
 * next boot simply migrates again.
 *
 * Yields between batches (see YIELD_BATCH). That preserves both invariants:
 * the never-overwrite guard is re-checked immediately before each write, so a
 * value written during a yield still wins, and the legacy record is still only
 * removed after the whole loop. It DOES introduce a re-entrancy window, so
 * concurrent callers share one in-flight run via `migrationsInFlight` rather
 * than both walking the same blob.
 */
const migrationsInFlight = new Map<string, Promise<void>>();

function migrateLegacy(kind: MessageKind, userId: string): Promise<void> {
    const flightKey = `${kind}:${userId}`;
    const existing = migrationsInFlight.get(flightKey);
    if (existing) return existing;
    const run = doMigrateLegacy(kind, userId).finally(() => {
        migrationsInFlight.delete(flightKey);
    });
    migrationsInFlight.set(flightKey, run);
    return run;
}

async function doMigrateLegacy(kind: MessageKind, userId: string): Promise<void> {
    const legacy = secureLocalStore.getItem(legacyKey(kind, userId));
    if (!legacy) return;
    const prefix = threadPrefix(kind, userId);
    try {
        // The monolith is parsed in one call — JSON.parse cannot be chunked —
        // so this single statement stays a long task on a large blob. The
        // per-thread re-serialise loop below is the part that can yield, and
        // on a real vault it is the larger half of the cost.
        const parsed = JSON.parse(legacy) as ThreadMap;
        if (parsed && typeof parsed === 'object') {
            const threads = Object.entries(parsed);
            for (let i = 0; i < threads.length; i++) {
                const [id, msgs] = threads[i];
                if (Array.isArray(msgs) && secureLocalStore.getItem(prefix + id) === null) {
                    secureLocalStore.setItem(prefix + id, JSON.stringify(msgs));
                }
                if ((i + 1) % YIELD_BATCH === 0 && i + 1 < threads.length) await yieldToEventLoop();
            }
        }
        secureLocalStore.removeItem(legacyKey(kind, userId));
    } catch (e) {
        // Unparseable legacy blob: leave it exactly where it is rather than
        // deleting data we failed to understand. Per-thread records (if any)
        // still load below; a human can recover the record from disk.
        console.error('[messageStore] legacy history blob is unreadable — leaving it in place', e);
    }
}

/**
 * Every thread for this account, in the same shape the old single record held.
 * Awaits deferred hydration, migrates the legacy blob if present, then reads
 * the per-thread records.
 */
export async function loadAll(kind: MessageKind, userId: string): Promise<ThreadMap> {
    // Throws rather than returning `{}`: an empty map here is handed straight to
    // React state and to `exportLocalHistory`, where it reads as "this account
    // has no conversations" — and a backup written from that would be an empty
    // vault over a good one. "Not readable" is not "empty".
    if (!(await awaitReadable(userId))) throw new HistoryNotReadableError(userId);
    await migrateLegacy(kind, userId);

    const prefix = threadPrefix(kind, userId);
    const out: ThreadMap = {};
    // Captured BEFORE the first read: any thread written after this point was
    // written during one of our yields and must win over what we parse.
    const startSeq = writeSeq;
    const keys = secureLocalStore.keysWithPrefix(prefix);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        // A detached record IS lastWritten (see regenerateThread): hand that
        // back rather than serialising it only to parse it again.
        const held = isDetached(key) ? lastWritten.get(key) : undefined;
        if (held) {
            out[key.slice(prefix.length)] = held;
            continue;
        }
        const raw = secureLocalStore.getItem(key);
        if (raw) {
            try {
                const msgs = JSON.parse(raw);
                // A single unreadable thread must cost that thread only — the whole
                // point of splitting the record was to stop one bad byte taking
                // every conversation with it.
                if (Array.isArray(msgs)) out[key.slice(prefix.length)] = msgs;
            } catch (e) {
                console.error(`[messageStore] dropping unreadable thread ${key.slice(prefix.length)}`, e);
            }
        }
        // Yield between batches so a many-conversation account doesn't turn
        // this into one multi-second task on the renderer's main thread.
        if ((i + 1) % YIELD_BATCH === 0 && i + 1 < keys.length) await yieldToEventLoop();
    }

    // Never hand back a snapshot older than a write that landed mid-load.
    // `lastWritten` holds the exact array saveAll persisted, so preferring it
    // keeps reference identity too — which is what saveAll's change detection
    // uses, so the newer thread isn't needlessly rewritten either.
    for (const [key, seq] of lastWriteSeq) {
        if (seq <= startSeq || !key.startsWith(prefix)) continue;
        const newer = lastWritten.get(key);
        if (newer) out[key.slice(prefix.length)] = newer;
        else delete out[key.slice(prefix.length)]; // removed mid-load
    }

    seed(kind, userId, out);
    // Every thread in `out` now has its parsed copy in lastWritten, matching
    // what the store holds for it — the JSON text can leave memory.
    for (const id of Object.keys(out)) markDetachable(prefix + id);
    return out;
}

/**
 * Persist a full map, writing ONLY the threads whose contents changed and
 * removing ones that disappeared (a retention sweep prunes threads by handing
 * back a smaller map — that has to delete, not just stop mentioning them).
 */
export function saveAll(kind: MessageKind, userId: string, map: ThreadMap): void {
    const prefix = threadPrefix(kind, userId);

    for (const [id, msgs] of Object.entries(map)) {
        const key = prefix + id;
        if (lastWritten.get(key) === msgs) continue;   // referentially unchanged
        try {
            secureLocalStore.setItem(key, JSON.stringify(msgs));
            lastWritten.set(key, msgs);
            noteWrite(key);
            markDetachable(key);
        } catch (e) {
            console.error(`[messageStore] failed to persist thread ${id}`, e);
        }
    }

    for (const key of [...lastWritten.keys()]) {
        if (!key.startsWith(prefix)) continue;
        if (Object.prototype.hasOwnProperty.call(map, key.slice(prefix.length))) continue;
        secureLocalStore.removeItem(key);
        lastWritten.delete(key);
        noteWrite(key);
    }
}

/**
 * Merge `incoming` messages into this account's ON-DISK threads, one thread
 * record per conversation it touches, and return the storage keys written.
 *
 * For the DM pull loop, which must have a message on disk before it ACKs the
 * envelope (the ACK deletes the server's copy — see utils/dmInbound.ts). It
 * cannot use saveAll: that takes a FULL map and deletes every thread missing
 * from it, and the pull only has the conversations in its batch.
 *
 * The base is the thread as currently stored, never React state: state can be
 * empty or partial (e.g. before the boot restore has loaded history), and
 * merging onto it would write a thread holding only the new messages over the
 * real one. Reads therefore wait for the namespace exactly like loadAll, and
 * THROW `HistoryNotReadableError` rather than merge onto a cold, empty view.
 *
 * `merge` must be idempotent (dmInbound.applyIncomingDmMessages is): the same
 * batch can be merged again after a failed flush.
 */
export async function mergeThreads(
    kind: MessageKind,
    userId: string,
    incoming: ThreadMap,
    merge: (threads: ThreadMap, incoming: ThreadMap) => ThreadMap,
): Promise<string[]> {
    if (!(await awaitReadable(userId))) throw new HistoryNotReadableError(userId);
    await migrateLegacy(kind, userId);
    const prefix = threadPrefix(kind, userId);
    const written: string[] = [];
    for (const [id, msgs] of Object.entries(incoming)) {
        if (!Array.isArray(msgs) || msgs.length === 0) continue;
        const key = prefix + id;
        let base: ThreadMap[string] = [];
        // A detached record's stored value IS lastWritten (see
        // regenerateThread) — merge onto it directly instead of serialising
        // and re-parsing the whole thread for every pulled batch.
        const held = isDetached(key) ? lastWritten.get(key) : undefined;
        const raw = held ? null : secureLocalStore.getItem(key);
        if (held) {
            base = held;
        } else if (raw) {
            // An unreadable record is treated exactly as loadAll treats it —
            // dropped, so the thread starts over — rather than thrown on: a
            // throw here would fail the whole batch's persist, so no envelope
            // in it (for ANY conversation) could ever be ACKed again.
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) base = parsed;
                else console.error(`[messageStore] thread ${id} is not an array — starting it over`);
            } catch (e) {
                console.error(`[messageStore] thread ${id} is unreadable — starting it over`, e);
            }
        }
        const next = merge({ [id]: base }, { [id]: msgs })[id] ?? base;
        secureLocalStore.setItem(key, JSON.stringify(next));
        lastWritten.set(key, next);
        noteWrite(key);
        markDetachable(key);
        written.push(key);
    }
    return written;
}

/**
 * Replace everything for this account — the restore path. Existing threads are
 * cleared first so a restore is a true replace: a conversation that isn't in
 * the vault must not survive underneath it.
 */
export function replaceAll(kind: MessageKind, userId: string, map: ThreadMap): void {
    clearAll(kind, userId);
    const prefix = threadPrefix(kind, userId);
    for (const [id, msgs] of Object.entries(map)) {
        if (!Array.isArray(msgs)) continue;
        secureLocalStore.setItem(prefix + id, JSON.stringify(msgs));
        lastWritten.set(prefix + id, msgs);
        noteWrite(prefix + id);
        markDetachable(prefix + id);
    }
}

/**
 * Delete a single conversation's history. Under the old layout this meant
 * read-everything → delete one key → rewrite everything; now it's one record.
 * Also migrates first, so deleting on a device that hasn't split yet doesn't
 * leave the conversation alive inside the legacy blob.
 */
export async function removeThread(kind: MessageKind, userId: string, id: string): Promise<void> {
    // A removeItem() against a namespace that is not loaded writes a TOMBSTONE,
    // and a tombstone blocks the record from ever being decrypted back into
    // memory for this account. Refuse rather than delete blind.
    if (!(await awaitReadable(userId))) throw new HistoryNotReadableError(userId);
    await migrateLegacy(kind, userId);
    const key = threadPrefix(kind, userId) + id;
    secureLocalStore.removeItem(key);
    lastWritten.delete(key);
    noteWrite(key);
}

/** Delete every thread for this account, plus any legacy record. */
export function clearAll(kind: MessageKind, userId: string): void {
    const prefix = threadPrefix(kind, userId);
    for (const key of secureLocalStore.keysWithPrefix(prefix)) {
        secureLocalStore.removeItem(key);
        noteWrite(key);
    }
    for (const key of [...lastWritten.keys()]) {
        if (key.startsWith(prefix)) { lastWritten.delete(key); noteWrite(key); }
    }
    secureLocalStore.removeItem(legacyKey(kind, userId));
}

/**
 * Does this account have ANY stored history? Used to decide whether to offer a
 * history sync from another device, so a false negative overwrites real data —
 * hence the readiness gate and the legacy check.
 *
 * THROWS `HistoryNotReadableError` when the account's namespace is not in
 * memory. It must never answer `false` from a cold namespace: `false` is the
 * answer that unlocks a destructive offer, and "we can't see it" is not
 * evidence that it isn't there.
 */
export async function hasAny(kind: MessageKind, userId: string): Promise<boolean> {
    if (!(await awaitReadable(userId))) throw new HistoryNotReadableError(userId);
    if (secureLocalStore.getItem(legacyKey(kind, userId)) !== null) return true;
    return secureLocalStore.keysWithPrefix(threadPrefix(kind, userId)).length > 0;
}

/** How much history is resident (threads / messages), for the Performance log. */
export function historyStats(): { threads: number; messages: number } {
    let messages = 0;
    for (const msgs of lastWritten.values()) messages += msgs.length;
    return { threads: lastWritten.size, messages };
}

/** Test seam — drops the in-memory "what we last wrote" tracking. */
export function _resetForTest(): void {
    lastWritten.clear();
    lastWriteSeq.clear();
    writeSeq = 0;
    migrationsInFlight.clear();
}
