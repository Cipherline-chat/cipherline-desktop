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
 * The reset target is `intendedZoomFactor()`. The in-app "Interface size"
 * setting (Settings → Accessibility; electron/ui-scale.ts) feeds it through
 * `setIntendedZoomFactor`, and ONLY windows locked with `{ scalable: true }`
 * (the main window) follow it; every other window stays at APP_ZOOM_FACTOR.
 * This module stays the only place in electron/ that calls `setZoomFactor`
 * (page-zoom-lock.wiring.test.ts), so the lock and the setting can't fight.
 *
 * The keyboard accelerators are still swallowed before Chromium sees them,
 * but on a scalable window Ctrl/Cmd + `=` / `-` / `0` are handed to
 * `onShortcut` so they step the setting (the standard accessibility
 * expectation) through the same seam. Ctrl+wheel and pinch stay blocked: they
 * are the accidental inputs that started all this.
 *
 * Structural types only (no runtime `electron` import) so this module is
 * unit-testable under vitest, like the other electron/ policy modules.
 */

/** The zoom factor the app is designed for. */
export const APP_ZOOM_FACTOR = 1;

/** Bounds for the seam (Chromium's own page-zoom range is wider; ui-scale.ts uses 0.8-2). */
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 3;

let intended = APP_ZOOM_FACTOR;

/** What SCALABLE windows are reset to: the single seam for the in-app UI scale. */
export function intendedZoomFactor(): number {
    return intended;
}

/** Set by electron/ui-scale.ts only. Out-of-range / non-finite values are refused (returns false). */
export function setIntendedZoomFactor(factor: number): boolean {
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < MIN_FACTOR || factor > MAX_FACTOR) return false;
    intended = factor;
    return true;
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
    return zoomShortcutAction(input) !== null;
}

export type ZoomShortcutAction = 'in' | 'out' | 'reset';

/** Which way a zoom accelerator points (same matching as isZoomShortcut), or null. */
export function zoomShortcutAction(input: ZoomKeyInput): ZoomShortcutAction | null {
    if (input.type !== 'keyDown') return null;
    if (!(input.control || input.meta)) return null;
    if (input.alt) return null;
    const key = input.key;
    if (MINUS_KEYS.has(key) || input.code === 'NumpadSubtract') return 'out';
    if (PLUS_KEYS.has(key) || input.code === 'NumpadAdd') return 'in';
    if (key === '0' && !input.shift) return 'reset';
    return null;
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

export interface LockPageZoomOptions {
    /** Follow `intendedZoomFactor()` (the UI scale) instead of the fixed APP_ZOOM_FACTOR. Main window only. */
    scalable?: boolean;
    /** Scalable windows: a zoom accelerator was pressed (not on key auto-repeat). */
    onShortcut?: (action: ZoomShortcutAction) => void;
}

/** Install every layer on one window's webContents. Call once per window. */
export function lockPageZoom(wc: ZoomLockableContents, opts: LockPageZoomOptions = {}): void {
    const target = opts.scalable ? intendedZoomFactor : () => APP_ZOOM_FACTOR;
    const reset = () => resetZoomToIntended(wc, target());

    wc.on('before-input-event', (event: { preventDefault(): void }, input: ZoomKeyInput & { isAutoRepeat?: boolean }) => {
        const action = zoomShortcutAction(input);
        if (!action) return;
        event.preventDefault();
        // Held keys repeat ~30/s: one press = one step, never a fly-through to 200 %.
        if (opts.scalable && opts.onShortcut && !input.isAutoRepeat) {
            try { opts.onShortcut(action); } catch { /* never break input */ }
        }
    });

    try {
        const p = wc.setVisualZoomLevelLimits(1, 1);
        if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => { /* closing */ });
    } catch { /* closing */ }

    // Ctrl+wheel. The reset runs now and again on the next tick, because the
    // level can be applied after this event is delivered.
    wc.on('zoom-changed', () => {
        reset();
        setImmediate(reset);
    });

    // Persisted per-host zoom from earlier versions. Zoom is applied to the
    // host as the page commits, so reset at both document milestones.
    wc.on('dom-ready', reset);
    wc.on('did-finish-load', reset);

    reset();
}
