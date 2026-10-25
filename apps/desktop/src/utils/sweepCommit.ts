/**
 * Helpers for the TIME-SLICED retention sweep (Dashboard's sweep effect).
 *
 * The sweep runs on every window focus — the moment a user clicks back into
 * the app — and used to scan every cached thread in one task. Slicing it means
 * state can change while it yields, so the commit must never write a pruned
 * copy over a thread that moved on in the meantime. These keep that rule in one
 * testable place.
 */

/** Ids whose CURRENT array is still the exact array that was swept. */
export function unchangedSince(ids: Iterable<string>, live: Record<string, unknown>, swept: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const id of ids) if (live[id] === swept[id]) out.push(id);
    return out;
}

/**
 * State updater body: replace each of `ids` with its pruned array, but only
 * where `prev` still holds the swept array. Returns `prev` itself when nothing
 * applies, so React bails out of the render.
 */
export function applyPruned<T>(
    prev: Record<string, T>,
    swept: Record<string, T>,
    pruned: ReadonlyMap<string, { msgs: T }>,
    ids: readonly string[],
): Record<string, T> {
    let out = prev;
    for (const id of ids) {
        const r = pruned.get(id);
        if (!r || prev[id] !== swept[id]) continue;
        if (out === prev) out = { ...prev };
        out[id] = r.msgs;
    }
    return out;
}

/** Yield to queued input/paint: scheduler.yield() where present, else a 0 ms timer. */
export function yieldMainThread(): Promise<void> {
    const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof s?.yield === 'function') return s.yield();
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/**
 * Returns an `await`-able checkpoint that yields once `sliceMs` of work has
 * run since the last yield, and is free otherwise.
 */
export function makeSliceYield(sliceMs: number, now: () => number = () => performance.now(), yieldFn: () => Promise<void> = yieldMainThread): () => Promise<void> {
    let start = now();
    return async () => {
        if (now() - start < sliceMs) return;
        await yieldFn();
        start = now();
    };
}

/**
 * Run `remove` over `ids` in chunks, yielding to the event loop between chunks.
 *
 * The retention sweep deletes every expired attachment blob from the local
 * cache. Started all at once (`Promise.allSettled(ids.map(remove))`) a few
 * hundred IndexedDB deletes queue in one task and their completions land as a
 * burst; chunked, each burst is small and input/paint run in between. Failures
 * are swallowed per id (allSettled semantics) - a blob that will not delete is
 * retried by the next sweep. Resolves with the count attempted.
 */
export async function removeInChunks(
    ids: readonly string[],
    remove: (id: string) => Promise<unknown>,
    chunkSize = 25,
    yieldFn: () => Promise<void> = yieldMainThread,
): Promise<number> {
    const size = Math.max(1, chunkSize);
    for (let i = 0; i < ids.length; i += size) {
        await Promise.allSettled(ids.slice(i, i + size).map(async id => remove(id)));
        if (i + size < ids.length) await yieldFn();
    }
    return ids.length;
}
