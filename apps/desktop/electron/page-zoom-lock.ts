/**
 * Page-zoom lock — Cipherline does not support Chromium page zoom.
 *
 * Ctrl/Cmd + `-` / `=` / `+` / `0`, Ctrl+mouse-wheel and trackpad pinch all
 * rescale the whole UI, which is a layout the app was never designed to run
 * at (the owner hit this by pressing Ctrl+-: the window "gets small"). The
 * layout is fixed-density by design, so the zoom is locked rather than
 * bounded.
 *
 * Four independent layers, because each input path is handled by a different
 * part of Chromium/Electron:
 *   1. `before-input-event` swallows the keyboard accelerators BEFORE the page
 *      or any menu accelerator sees them (Electron: preventDefault on that
 *      event blocks "the page keydown/keyup events and the menu shortcuts").
 *      This also covers the default application menu's View -> Zoom roles,
 *      which the app never replaced.
 *   2. `setVisualZoomLevelLimits(1, 1)` disables pinch zoom (and the
 *      visual-viewport scale that ctrl+wheel uses on some platforms).
 *   3. `zoom-changed` (Electron's report of a ctrl+wheel request) snaps the
 *      zoom straight back.
 *   4. A defensive reset on `dom-ready` / `did-finish-load`: Chromium persists
 *      zoom per HOST in the session, so a user who zoomed out in an earlier
 *      version would otherwise come back stuck small/large forever, with no
 *      way left to undo it.
 *
 * The reset target is `intendedZoomFactor()`. There is currently NO in-app UI
 * scale / zoom / text-size setting that drives `setZoomFactor` (verified:
 * nothing in src/ or electron/ calls it), so the intended factor is 1.0. If
 * such a setting is ever added, this is the single place it must feed, or the
 * reset here will fight it.
 *
 * Structural types only (no runtime `electron` import) so this module is
 * unit-testable under vitest, like the other electron/ policy modules.
 */

/** The zoom factor the app is designed for. */
export const APP_ZOOM_FACTOR = 1;

/** What every window is reset to. Single seam for a future in-app UI scale. */
export function intendedZoomFactor(): number {
    return APP_ZOOM_FACTOR;
}

/** The subset of Electron's `Input` this filter reads. */
export interface ZoomKeyInput {
    type: string;
    key: string;
    code?: string;
    control: boolean;
    meta: boolean;
    alt: boolean;
    shift: boolean;
}

const MINUS_KEYS = new Set(['-', '_', 'Subtract']);
const PLUS_KEYS = new Set(['=', '+', 'Add']);
const NUMPAD_CODES = new Set(['NumpadAdd', 'NumpadSubtract']);

/**
 * True for the Chromium page-zoom accelerators:
 *   Ctrl/Cmd + `-` (zoom out; Shift allowed, `_` is Shift+`-`)
 *   Ctrl/Cmd + `=` / `+` (zoom in; Shift allowed, `+` is Shift+`=` on US)
 *   Ctrl/Cmd + `0` (reset; NOT with Shift, which is not a zoom shortcut)
 *   the numpad Add / Subtract / 0 equivalents.
 *
 * Deliberately NOT matched:
 *   - any of those keys without Ctrl/Cmd (typing `-` or `+` in a text box);
 *   - anything with Alt held (AltGr arrives as Ctrl+Alt on Windows and is how
 *     many layouts type characters - never eat a typed character);
 *   - other Ctrl+Shift combos (Ctrl+Shift+I DevTools and the app's own
 *     keybinds use different keys, so they fall through untouched);
 *   - keyUp events.
 */
export function isZoomShortcut(input: ZoomKeyInput): boolean {
    if (input.type !== 'keyDown') return false;
    if (!(input.control || input.meta)) return false;
    if (input.alt) return false;
    const key = input.key;
    if (MINUS_KEYS.has(key) || PLUS_KEYS.has(key)) return true;
    if (input.code && NUMPAD_CODES.has(input.code)) return true;
    if (key === '0' && !input.shift) return true;
    return false;
}

const EPSILON = 0.001;

/** The slice of `webContents` this module touches. */
export interface ZoomLockableContents {
    isDestroyed(): boolean;
    getZoomFactor(): number;
    setZoomFactor(factor: number): void;
    setVisualZoomLevelLimits(min: number, max: number): Promise<void> | void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must stay assignable from Electron's overloaded on()
    on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Snap the page back to the intended factor if it drifted. Returns true when
 * it had to change something. Never throws (the contents may be tearing down).
 */
export function resetZoomToIntended(wc: ZoomLockableContents, factor: number = intendedZoomFactor()): boolean {
    try {
        if (wc.isDestroyed()) return false;
        if (Math.abs(wc.getZoomFactor() - factor) <= EPSILON) return false;
        wc.setZoomFactor(factor);
        return true;
    } catch {
        return false;
    }
}

/** Install every layer on one window's webContents. Call once per window. */
export function lockPageZoom(wc: ZoomLockableContents): void {
    wc.on('before-input-event', (event: { preventDefault(): void }, input: ZoomKeyInput) => {
        if (isZoomShortcut(input)) event.preventDefault();
    });

    try {
        const p = wc.setVisualZoomLevelLimits(1, 1);
        if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => { /* closing */ });
    } catch { /* closing */ }

    // Ctrl+wheel. The reset runs now and again on the next tick, because the
    // level can be applied after this event is delivered.
    wc.on('zoom-changed', () => {
        resetZoomToIntended(wc);
        setImmediate(() => resetZoomToIntended(wc));
    });

    // Persisted per-host zoom from earlier versions. Zoom is applied to the
    // host as the page commits, so reset at both document milestones.
    wc.on('dom-ready', () => { resetZoomToIntended(wc); });
    wc.on('did-finish-load', () => { resetZoomToIntended(wc); });

    resetZoomToIntended(wc);
}
