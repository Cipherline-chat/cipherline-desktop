/**
 * fetchWithRetry — retry wrapper for the handful of loads the app cannot work
 * without.
 *
 * The bug this exists for: every core load was written as a one-shot with a
 * swallowed error. `axios.get('/friends').catch(() => {})` runs once on mount;
 * if it loses a race with the cold-start window — API not accepting connections
 * yet, access token mid-refresh, network stack not up after a wake — the state
 * it feeds stays empty for the whole session and the only cure is a manual
 * refresh. `globalFriends` staying null is the worst of them, because
 * FriendshipContext gates avatar rendering on it, so one missed request took
 * out avatars across the app.
 *
 * Deliberately NOT for user-initiated mutations. Silently re-sending a POST the
 * user triggered is a different risk (duplicate messages, double charges);
 * this is only for idempotent reads that the UI is useless without.
 */

export interface RetryOptions {
    /** Total attempts including the first. Default 3. */
    attempts?: number;
    /** Delay before attempt 2; doubles thereafter. Default 500ms. */
    baseDelayMs?: number;
    /** Ceiling for any single delay. Default 4000ms. */
    maxDelayMs?: number;
    /**
     * Abort early — return false to stop retrying a failure that will never
     * succeed (a 403 is not going to fix itself; a 503 might).
     */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    /** Injected for tests so they don't spend real seconds sleeping. */
    sleep?: (ms: number) => Promise<void>;
    /** Called before each retry — used for logging. */
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Delay before the given retry (1-indexed: `backoffDelay(1)` is the wait
 * between attempt 1 and attempt 2). Exported for tests, which assert on the
 * schedule rather than on wall-clock timing.
 */
export function backoffDelay(retryIndex: number, baseDelayMs = 500, maxDelayMs = 4000): number {
    const raw = baseDelayMs * 2 ** (retryIndex - 1);
    return Math.min(raw, maxDelayMs);
}

/**
 * Run `fn`, retrying on rejection. Resolves with its value, or rejects with the
 * LAST error once attempts are exhausted — callers decide whether an
 * exhausted load is fatal or merely leaves a gap.
 */
export async function fetchWithRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const {
        attempts = 3,
        baseDelayMs = 500,
        maxDelayMs = 4000,
        shouldRetry = defaultShouldRetry,
        sleep = defaultSleep,
        onRetry,
    } = opts;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt === attempts || !shouldRetry(err, attempt)) break;
            const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
            onRetry?.(err, attempt, delay);
            await sleep(delay);
        }
    }
    throw lastError;
}

/**
 * Retry network failures and server-side errors; don't retry a refusal.
 *
 * 401 is deliberately retryable: axios has a response interceptor
 * (Dashboard.tsx) that silently refreshes the access token and replays the
 * request, so a 401 surfacing here usually means we raced the refresh — which
 * is precisely the cold-start case this helper is for. 403/404 are the
 * server's settled answer and repeating them just wastes time.
 */
export function defaultShouldRetry(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    if (status === undefined) return true;      // network error / timeout — worth retrying
    if (status === 403 || status === 404) return false;
    if (status >= 400 && status < 500) return status === 401 || status === 408 || status === 429;
    return true;                                 // 5xx
}
