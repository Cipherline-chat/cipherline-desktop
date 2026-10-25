/**
 * resumeSequencing — the small, testable pieces behind how Dashboard behaves
 * on wake from sleep (see networkReady.ts for the evidence that motivated them).
 *
 *   createWakeResync   resume work waits for connectivity first
 *   createPullGate     the DM pull is skipped while offline and caught up on `online`
 *   runPaced           the rehydrate loads run one after another with a yield
 *                      between, instead of four responses landing in one frame
 *
 * Pure: every dependency is injected, so each can be exercised without a DOM.
 */

/**
 * Wrap the post-wake resync so it runs only once the network is usable.
 *
 * `ready()` resolves false when connectivity never came back inside its window;
 * the resync is then SKIPPED, not forced: the WebSocket reconnect that follows
 * the same wake runs the full resync itself (Dashboard's wsConnectCount effect),
 * and a confirmed socket is a stronger "network is up" signal than any probe.
 * Never rejects — the caller fires it with `void`.
 */
export function createWakeResync<A extends unknown[]>(deps: {
    ready: () => Promise<boolean>;
    run: (...args: A) => Promise<void>;
    onError?: (e: unknown) => void;
}): (...args: A) => Promise<void> {
    return async (...args: A) => {
        try {
            if (!(await deps.ready())) return;
            await deps.run(...args);
        } catch (e) {
            try { deps.onError?.(e); } catch { /* nothing left to do */ }
        }
    };
}

export interface PullGate {
    /** Ask for a pull. Runs it when online; otherwise remembers that one is owed. */
    request(): Promise<void>;
    /** The `online` event: run the pull that was skipped, if one is owed. */
    onOnline(): Promise<void>;
    /** A pull was skipped while offline and has not been caught up yet. */
    readonly owed: boolean;
}

/** While the OS claims we are offline, still try one pull this often (see createPullGate). */
export const OFFLINE_PULL_FALLBACK_MS = 30_000;

/**
 * Gate for the DM pull (poll-then-ACK). Skipping a pull while offline loses
 * nothing: GET /messages/pull deletes nothing - the server drops an envelope
 * only on ACK, after the client has stored it - so the envelopes simply wait.
 * What the gate adds is that the pull is not fired into a dead network (which
 * reported a `msg_fetch_gap` per 5 s poll tick), and that the first moment the
 * network is back the owed pull runs at once instead of at the next tick.
 *
 * `navigator.onLine` is a hint, not a fact (a VPN adapter or a Linux box
 * without NetworkManager can read false while the network works), and a gate
 * that trusted it absolutely could stop message delivery for good. So while
 * "offline" one pull is still attempted every OFFLINE_PULL_FALLBACK_MS: on a
 * truly dead network that is one cheap failing GET per 30 s (not one per 5 s
 * tick); on a wrong flag it keeps messages arriving.
 */
export function createPullGate(deps: {
    isOnline: () => boolean;
    pull: () => Promise<void>;
    now?: () => number;
    fallbackMs?: number;
}): PullGate {
    const now = deps.now ?? Date.now;
    const fallbackMs = deps.fallbackMs ?? OFFLINE_PULL_FALLBACK_MS;
    let owed = false;
    // When the current "offline" spell began / its last fallback attempt. The
    // clock starts at the FIRST skipped request, so the very pull a wake fires
    // into a dead network is skipped, not treated as the fallback.
    let offlineMark: number | null = null;
    return {
        async request() {
            if (!deps.isOnline()) {
                const t = now();
                if (offlineMark === null || t - offlineMark < fallbackMs) {
                    if (offlineMark === null) offlineMark = t;
                    owed = true;
                    return;
                }
                offlineMark = t;
            } else {
                offlineMark = null;
            }
            owed = false;
            await deps.pull();
        },
        async onOnline() {
            if (!owed || !deps.isOnline()) return;
            offlineMark = null;
            owed = false;
            await deps.pull();
        },
        get owed() { return owed; },
    };
}

/**
 * Run `steps` one at a time, yielding to the event loop after each. A failing
 * step never stops the rest (allSettled semantics). Used for the rehydrate
 * loads: started together, their responses landed back to back and each one
 * re-rendered the whole dashboard inside a single long frame (the 1-2 s
 * `resume:rehydrate` freeze); one at a time with a yield, each render is its
 * own short task with input and paint able to run in between.
 */
export async function runPaced(
    steps: ReadonlyArray<() => Promise<unknown> | unknown>,
    yieldFn: () => Promise<void>,
): Promise<void> {
    for (const step of steps) {
        try { await step(); } catch { /* the step reports its own errors */ }
        await yieldFn();
    }
}
