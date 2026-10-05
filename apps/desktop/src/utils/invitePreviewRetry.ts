/**
 * Pure classification/backoff logic for useInvitePreview.ts, split into its
 * own dependency-free module so it's testable without pulling in axios
 * (axios's browser-detection touches `window.location` at import time,
 * which the vitest node environment doesn't stub — same reason
 * inviteLimits.ts and unreadBadges.ts live outside any component/hook).
 *
 * See useInvitePreview.ts's header comment for the full bug this closes:
 * a valid, unexpired invite intermittently rendering as "Invite
 * unavailable" because a throttle response (429) was indistinguishable
 * from a genuinely dead invite (404/400) and never retried.
 */

/** Retry backoff for transient failures when the server gave no Retry-After
 * (network error, 5xx). Capped at 3 attempts — beyond that it's more likely
 * a real outage than a throttle blip, and the caller can still retry
 * manually. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 12_000];

/** True for failures that mean "the invite itself is genuinely gone" —
 * these should never retry, and should render as "expired", not
 * "unavailable". */
export function isPermanentInviteFailure(status: number | undefined): boolean {
    return status === 404 || status === 400;
}

/** Resolve a retry delay from a 429's Retry-After header (seconds) when
 * present and sane, else fall back to the backoff table. */
export function resolveRetryDelayMs(retryAfterHeader: string | undefined, attempt: number): number {
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
    return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}
