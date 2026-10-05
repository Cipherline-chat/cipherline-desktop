/**
 * Boot-time access-token refresh, bounded.
 *
 * AuthContext refreshes a token that expires within 24 h BEFORE the app is
 * allowed past the loading screen. Right after the PC wakes from sleep the
 * network is often still reassociating, so that one request could hold the
 * whole app on the loading screen for its full 15 s timeout. While the token
 * is still valid there is nothing to wait for — see settleBootRefresh.
 */

/** How long boot waits for the near-expiry token refresh before restoring the
 *  session with the still-valid existing token (the refresh keeps going in the
 *  background). */
export const BOOT_REFRESH_WAIT_MS = 3000;

/**
 * Calls `onSettle` exactly once: with the refresh's result if it lands within
 * `waitMs`, otherwise — ONLY while the current token is still unexpired — with
 * `null` (meaning "keep using the existing token") when `waitMs` elapses. An
 * already-expired token always waits for the refresh itself. The refresh is
 * never cancelled; it completes (and swaps the token in) in the background.
 */
export function settleBootRefresh(
    refresh: Promise<string | null>,
    opts: { tokenExpired: boolean; expSec: number; waitMs: number; nowSec?: () => number },
    onSettle: (newToken: string | null) => void,
): void {
    let settled = false;
    const settle = (t: string | null) => {
        if (settled) return;
        settled = true;
        onSettle(t);
    };
    refresh.then(settle, () => settle(null));
    if (opts.tokenExpired) return;
    const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
    setTimeout(() => {
        // Still in flight and the token is still unexpired: stop holding the
        // app hostage to a slow network.
        if (nowSec() < opts.expSec) settle(null);
    }, opts.waitMs);
}
