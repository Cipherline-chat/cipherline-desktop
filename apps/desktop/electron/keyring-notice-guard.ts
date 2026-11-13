/**
 * Closing the wallet-notice window must not quit the app.
 *
 * The notice window is created before the key store opens, so at that moment it
 * is the ONLY window: the main window is created after the store is ready. When
 * the keyring answers we close the notice, which makes Electron emit
 * `window-all-closed`, and main.ts quits the app on that event (on every
 * platform but macOS). Found by running the real binary: without this the app
 * exited a moment after the wallet was unlocked.
 *
 * The guard says "a notice is open, or one closed within the last few seconds":
 * enough to cover the `window-all-closed` that its own close causes, and nothing
 * more. A real close of the last (main) window is never within that span of a
 * notice, because the notice is gone before the main window exists.
 *
 * No `electron` import (unit-testable).
 */

/** `window-all-closed` follows the destroy within milliseconds; this is generous. */
export const NOTICE_CLOSE_GRACE_MS = 3_000;

export interface NoticeGuard {
    opened(): void;
    closed(): void;
    holdsApp(): boolean;
}

export function createNoticeGuard(now: () => number = Date.now): NoticeGuard {
    let open = 0;
    let lastClosedAt = Number.NEGATIVE_INFINITY;
    return {
        opened() { open++; },
        closed() { if (open > 0) open--; lastClosedAt = now(); },
        holdsApp() { return open > 0 || now() - lastClosedAt < NOTICE_CLOSE_GRACE_MS; },
    };
}

export const keyringNoticeGuard: NoticeGuard = createNoticeGuard();
