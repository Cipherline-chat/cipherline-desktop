/**
 * One shared invite-preview lookup for every invite card on screen.
 *
 * `GET /invites/:code/preview` has a per-account limit (60 a minute signed in,
 * apps/api/src/servers/invites.controller.ts). A channel can hold far more
 * invite cards than that, and before this module each card asked on its own:
 * a remount (switching channels and back, scrolling a long history in) asked
 * again, a 429 was retried by every card at the same moment the window
 * reopened, and after three 429s a card gave up looking exactly like a dead
 * invite. Scrolling a long list of invites turned them all "unavailable".
 *
 * Now:
 *  - one answer per code, shared: a valid invite is kept 5 minutes and a
 *    definitely-dead one (404 / 410 / the server's 400 "expired"/"exhausted")
 *    2 minutes, so a remount costs nothing; at most 500 codes are kept;
 *  - two cards asking for the same code share one request;
 *  - at most 4 requests run at once, the rest wait their turn;
 *  - a 429 pauses EVERY lookup until its Retry-After has passed, then the same
 *    lookup tries again (up to 5 times). It is never remembered and never
 *    reported as "gone": after the retries it is `throttled`, which a card
 *    shows as "couldn't load, retry";
 *  - a network error / 5xx is `failed` and is never remembered either.
 *
 * In memory only, and only what the preview endpoint already answers to anyone
 * holding the code. Pure (no axios), so it is unit-tested with a fake clock.
 */

export type InviteLookupResult<T> =
    | { kind: 'valid'; data: T }
    /** The server said this invite does not exist / expired / is used up. */
    | { kind: 'gone'; status: number }
    /** Rate limited, still after the retries: try again later. NOT dead. */
    | { kind: 'throttled'; retryAfterMs: number }
    /** Network error, timeout, 5xx, anything else: try again. NOT dead. */
    | { kind: 'failed'; status?: number };

/** Statuses that mean "this invite is really gone". The API answers 404 for an
 *  unknown code or a deleted server and 400 for expired / used up
 *  (InvitesService.previewInvite); 410 is the conventional "gone". */
export function isGoneStatus(status: number | undefined): boolean {
    return status === 404 || status === 410 || status === 400;
}

/** A Retry-After header (seconds, or an HTTP date) in ms, clamped to 1 s..2 min;
 *  absent or unreadable → 5 s. */
export function retryAfterMs(header: unknown, now: number = Date.now()): number {
    const DEFAULT = 5_000;
    const clamp = (ms: number) => Math.min(120_000, Math.max(1_000, ms));
    if (typeof header !== 'string' && typeof header !== 'number') return DEFAULT;
    const s = String(header).trim();
    if (s === '') return DEFAULT;
    const secs = Number(s);
    if (Number.isFinite(secs)) return clamp(secs * 1000);
    const at = Date.parse(s);
    return Number.isFinite(at) ? clamp(at - now) : DEFAULT;
}

export const INVITE_VALID_TTL_MS = 5 * 60_000;
export const INVITE_GONE_TTL_MS = 2 * 60_000;
export const INVITE_MAX_CONCURRENT = 4;
export const INVITE_MAX_THROTTLE_RETRIES = 5;
const MAX_KEPT = 500;

interface LookupOptions {
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => unknown;
    maxConcurrent?: number;
    maxThrottleRetries?: number;
}

type Kept = { result: InviteLookupResult<unknown>; at: number; ttl: number };

export function createInviteLookup(opts: LookupOptions = {}) {
    const now = opts.now ?? (() => Date.now());
    const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const maxConcurrent = opts.maxConcurrent ?? INVITE_MAX_CONCURRENT;
    const maxThrottleRetries = opts.maxThrottleRetries ?? INVITE_MAX_THROTTLE_RETRIES;

    const kept = new Map<string, Kept>();
    const asking = new Map<string, Promise<InviteLookupResult<unknown>>>();
    const queue: Array<() => void> = [];
    let active = 0;
    let pausedUntil = 0;
    let wakeArmed = false;

    function pump(): void {
        while (active < maxConcurrent && queue.length > 0) {
            const wait = pausedUntil - now();
            if (wait > 0) {
                if (!wakeArmed) {
                    wakeArmed = true;
                    schedule(() => { wakeArmed = false; pump(); }, wait);
                }
                return;
            }
            active++;
            queue.shift()!();
        }
    }

    /** Run `task` when a slot is free and no 429 pause is in force. */
    function inSlot<R>(task: () => Promise<R>, front: boolean): Promise<R> {
        return new Promise<R>((resolve) => {
            const start = () => {
                void task().then(resolve).finally(() => { active = Math.max(0, active - 1); pump(); });
            };
            if (front) queue.unshift(start); else queue.push(start);
            pump();
        });
    }

    function remember(code: string, result: InviteLookupResult<unknown>, ttl: number): void {
        kept.delete(code);
        kept.set(code, { result, at: now(), ttl });
        while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
    }

    function peek<T>(code: string): InviteLookupResult<T> | undefined {
        const hit = kept.get(code);
        if (!hit) return undefined;
        if (now() - hit.at >= hit.ttl) { kept.delete(code); return undefined; }
        return hit.result as InviteLookupResult<T>;
    }

    async function run<T>(code: string, fetchIt: () => Promise<T>): Promise<InviteLookupResult<T>> {
        for (let attempt = 0; ; attempt++) {
            // A retry after a 429 goes to the front: it has waited longest.
            const out = await inSlot(async () => {
                try { return { ok: true as const, data: await fetchIt() }; }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios error / Error); fields are read defensively
                catch (e: any) { return { ok: false as const, status: e?.response?.status as number | undefined, retryAfter: e?.response?.headers?.['retry-after'] }; }
            }, attempt > 0);
            if (out.ok) {
                const result: InviteLookupResult<T> = { kind: 'valid', data: out.data };
                remember(code, result, INVITE_VALID_TTL_MS);
                return result;
            }
            if (isGoneStatus(out.status)) {
                const result: InviteLookupResult<T> = { kind: 'gone', status: out.status! };
                remember(code, result, INVITE_GONE_TTL_MS);
                return result;
            }
            if (out.status === 429) {
                const wait = retryAfterMs(out.retryAfter, now());
                pausedUntil = Math.max(pausedUntil, now() + wait);
                if (attempt >= maxThrottleRetries) return { kind: 'throttled', retryAfterMs: wait };
                continue;
            }
            return { kind: 'failed', status: out.status };
        }
    }

    return {
        /** Never rejects. `fresh` skips the kept answer and any request in flight. */
        lookup<T>(code: string, fetchIt: () => Promise<T>, fresh = false): Promise<InviteLookupResult<T>> {
            if (!fresh) {
                const hit = peek<T>(code);
                if (hit) return Promise.resolve(hit);
                const running = asking.get(code);
                if (running) return running as Promise<InviteLookupResult<T>>;
            }
            const p = run(code, fetchIt).finally(() => { if (asking.get(code) === p) asking.delete(code); });
            asking.set(code, p as Promise<InviteLookupResult<unknown>>);
            return p;
        },
        /** The kept answer for `code`, if still fresh (no request). */
        peek,
        clear(): void {
            kept.clear();
            asking.clear();
            queue.length = 0;
            active = 0;
            pausedUntil = 0;
        },
        /** For tests / diagnostics. */
        stats: () => ({ kept: kept.size, asking: asking.size, queued: queue.length, active, pausedUntil }),
    };
}

/** The app-wide instance every invite card shares. */
export const inviteLookup = createInviteLookup();

export function clearInvitePreviews(): void {
    inviteLookup.clear();
}
