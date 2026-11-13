/**
 * Share ONE in-flight request between concurrent callers that ask for the same
 * thing. Not a cache: the entry is dropped the moment the request settles, so
 * the next caller gets a fresh fetch, and a rejection is shared too (each caller
 * handles its own failure exactly as if it had made the request itself).
 *
 * Use only where every caller treats the result as READ-ONLY.
 *
 * Opening a server used to GET /servers/:id/channels twice at the same moment
 * (the channel list, and the key sweep). The key is whatever identifies the
 * request AND the identity asking: callers include the token so an account
 * switch can never receive another account's response.
 */
const inflight = new Map<string, Promise<unknown>>();

export function shareInflight<T>(key: string, start: () => Promise<T>): Promise<T> {
    const running = inflight.get(key);
    if (running) return running as Promise<T>;
    const p = start().finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
}

/** Test seam. */
export function _inflightShareSize(): number { return inflight.size; }
