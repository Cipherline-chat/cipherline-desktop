/**
 * One source of truth for the friends list.
 *
 * Before this module the Friends view kept TWO copies of `GET /v1/friends`:
 * Dashboard's `globalFriends` (feeds the right-hand "Active Now" panel, Home,
 * avatar gating, ...) and a private `useState` inside FriendsPane (the main
 * list). They were fetched by two independent, differently-hardened loaders:
 *
 *   - Dashboard's: 3 retries + a perpetual slow retry, so it always converged.
 *   - FriendsPane's: one bare GET, the error swallowed into a console.error,
 *     and a state that STARTS EMPTY on every mount (the pane unmounts whenever
 *     you leave the Friends tab).
 *
 * So one failed (or hung, or reordered) GET left the main list on its initial
 * `accepted: []` — rendered as "Your circle is quiet for now" — while the other
 * copy converged and the panel happily listed the friend as online. With a
 * flapping socket (every reconnect fires a refetch burst) it is easy to hit.
 *
 * The rules that fix it, all enforced here so they can be unit-tested:
 *
 *   1. A response that does not parse as a friends payload is a FAILURE, never
 *      "the list is empty".
 *   2. A failure never replaces data: the last good list stays on screen.
 *   3. Responses are applied in REQUEST order — a slow older response cannot
 *      overwrite a newer one (e.g. a pre-accept snapshot landing after the
 *      post-accept one).
 *   4. A failure schedules a backoff retry until something succeeds.
 *   5. "Never loaded" is a distinct state from "loaded and empty", so the UI
 *      can show a loading/error state instead of a false empty one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- untyped REST payload rows; modelling them is tracked typing debt */
export interface FriendsPayload {
    pending_incoming: any[];
    pending_outgoing: any[];
    accepted: any[];
    blocked: any[];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 'loading' = no successful load yet; 'ready' = last refresh succeeded;
 *  'error' = the last refresh failed (data, if any, is the last good copy). */
export type FriendsLoadStatus = 'loading' | 'ready' | 'error';

export const EMPTY_FRIENDS: FriendsPayload = Object.freeze({
    pending_incoming: [],
    pending_outgoing: [],
    accepted: [],
    blocked: [],
}) as FriendsPayload;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a `GET /v1/friends` body. Returns null when it is not one — the
 * caller must treat that as a failed fetch, not as an empty list.
 *
 * The server always sends all four arrays; `accepted` is the one whose absence
 * would silently empty the list, so it is required. A missing `blocked` /
 * pending list is tolerated (older servers) as empty; a PRESENT-but-wrong-typed
 * one is rejected rather than coerced.
 */
export function parseFriendsPayload(data: unknown): FriendsPayload | null {
    if (!isRecord(data)) return null;
    if (!Array.isArray(data.accepted)) return null;
    const optional = (key: string): unknown[] | null => {
        const v = data[key];
        if (v === undefined || v === null) return [];
        return Array.isArray(v) ? v : null;
    };
    const pending_incoming = optional('pending_incoming');
    const pending_outgoing = optional('pending_outgoing');
    const blocked = optional('blocked');
    if (!pending_incoming || !pending_outgoing || !blocked) return null;

    // Rows the UI dereferences (`f.username.toLowerCase()`, `f.user_id`) must be
    // objects. A row for an account that no longer resolves arrives without a
    // username; give it a placeholder instead of letting one row crash the pane.
    const rows = (list: unknown[]) => list.filter(isRecord);
    const named = (list: unknown[]) => rows(list).map(r => (
        typeof r.username === 'string' ? r : { ...r, username: 'Unknown user' }
    ));
    return {
        ...data,
        accepted: named(data.accepted),
        pending_incoming: named(pending_incoming),
        pending_outgoing: named(pending_outgoing),
        blocked: named(blocked),
    } as FriendsPayload;
}

/** Backoff for retry attempt n (1-based): 3s, 6s, 12s, 24s, then 30s forever. */
export function friendsRetryDelayMs(attempt: number): number {
    const n = Math.max(1, Math.floor(attempt));
    return Math.min(3_000 * 2 ** (n - 1), 30_000);
}

export interface FriendsSyncOptions {
    /** Performs the GET and resolves with the raw response BODY. Called fresh on
     *  every attempt (so a retry picks up a rotated token). */
    load: () => Promise<unknown>;
    /** A newer, valid payload is ready. Never called with stale or invalid data. */
    onData: (payload: FriendsPayload) => void;
    onStatus: (status: FriendsLoadStatus) => void;
    onError?: (err: unknown) => void;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export interface FriendsSync {
    /** Fetch now. Resolves true when a valid payload was received. Never throws. */
    refresh: () => Promise<boolean>;
    /** Stop retrying and ignore anything still in flight (unmount). */
    dispose: () => void;
    /** Undo dispose() — React StrictMode runs mount → cleanup → mount on the
     *  same instance, so a disposed sync must be revivable. */
    resume: () => void;
}

export function createFriendsSync(opts: FriendsSyncOptions): FriendsSync {
    const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

    let started = 0;          // highest ticket handed out
    let lastApplied = 0;      // ticket of the newest response applied so far
    let hasLoaded = false;
    let failures = 0;
    let retryHandle: unknown = null;
    let disposed = false;

    const cancelRetry = () => {
        if (retryHandle !== null) { clearTimer(retryHandle); retryHandle = null; }
    };

    async function refresh(): Promise<boolean> {
        if (disposed) return false;
        const ticket = ++started;
        if (!hasLoaded) opts.onStatus('loading');
        try {
            const parsed = parseFriendsPayload(await opts.load());
            if (!parsed) throw new Error('GET /friends returned a body that is not a friends payload');
            if (disposed) return false;
            // Rule 3: only a response newer than everything applied so far wins.
            if (ticket > lastApplied) {
                lastApplied = ticket;
                opts.onData(parsed);
            }
            hasLoaded = true;
            failures = 0;
            cancelRetry();
            opts.onStatus('ready');
            return true;
        } catch (err) {
            if (disposed) return false;
            // A failure from a request OLDER than the data already on screen says
            // nothing about the current state — ignore it.
            if (ticket < lastApplied) return false;
            opts.onError?.(err);
            failures += 1;
            opts.onStatus('error');
            cancelRetry();
            retryHandle = setTimer(() => { retryHandle = null; void refresh(); }, friendsRetryDelayMs(failures));
            return false;
        }
    }

    return {
        refresh,
        dispose() { disposed = true; cancelRetry(); },
        resume() { disposed = false; },
    };
}
