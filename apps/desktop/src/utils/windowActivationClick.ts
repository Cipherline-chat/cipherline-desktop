/**
 * "Was this click only bringing the window to the front?"
 *
 * Owner, 2026-11-11: clicking into an unfocused Cipherline and landing on a message must NOT save that message
 * (the row click toggles keep-from-expiry); the click should only focus the app. The next click, with the
 * window already focused, saves as usual.
 *
 * Platforms differ in event order for an activating click: Windows usually delivers `focus` and then the
 * `mousedown` a few ms later; macOS/Linux may deliver the `mousedown` while `document.hasFocus()` is still
 * false. So a mousedown counts as an activation click when the document is not focused at that moment, or
 * when the window regained focus less than ACTIVATION_WINDOW_MS before it.
 */
export const ACTIVATION_WINDOW_MS = 250;

let lastFocusAt = 0;
let installed = false;

/** Start tracking window focus (idempotent; safe in tests and outside a browser). */
export function installWindowActivationTracking(win: Pick<Window, 'addEventListener'> | undefined = typeof window !== 'undefined' ? window : undefined, now: () => number = () => performance.now()): void {
    if (installed || !win) return;
    installed = true;
    win.addEventListener('focus', () => { lastFocusAt = now(); });
}

/** Pure decision, for tests. */
export function isActivationClick(input: { docHasFocus: boolean; nowMs: number; lastFocusAtMs: number }): boolean {
    if (!input.docHasFocus) return true;
    return input.lastFocusAtMs > 0 && input.nowMs - input.lastFocusAtMs >= 0 && input.nowMs - input.lastFocusAtMs < ACTIVATION_WINDOW_MS;
}

/** Call from a mousedown handler. */
export function mousedownIsActivationClick(doc: Pick<Document, 'hasFocus'> | undefined = typeof document !== 'undefined' ? document : undefined, now: () => number = () => performance.now()): boolean {
    return isActivationClick({ docHasFocus: doc ? doc.hasFocus() : true, nowMs: now(), lastFocusAtMs: lastFocusAt });
}

/** Test hook. */
export function __setLastFocusAtForTests(ms: number): void { lastFocusAt = ms; }
export function __resetWindowActivationForTests(): void { lastFocusAt = 0; installed = false; }
