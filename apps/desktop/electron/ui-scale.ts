/**
 * Interface size ("UI scale") — Settings → Accessibility → Size.
 *
 * The whole renderer of the MAIN window is zoomed with Chromium's page zoom
 * (`webContents.setZoomFactor`), fed through the single seam in
 * page-zoom-lock.ts (`setIntendedZoomFactor` / `intendedZoomFactor`), so the
 * lock's own resets apply the chosen size instead of fighting it.
 *
 * ── The clamping rule ─────────────────────────────────────────────────────
 * Zoom shrinks the CSS viewport: a 1000x720 window at 200 % is a 500x360 CSS
 * px page, which the four-pane layout cannot hold. So:
 *
 *   1. The layout needs at least LAYOUT_MIN_CSS (1000 x 600 CSS px). At 100 %
 *      the window minimum stays the historical 1000 x 720 (BASE_WINDOW_MIN),
 *      so nothing changes for anyone who never touches the setting. The CSS
 *      height floor is lower than 720 because at 720 a 1080p screen could not
 *      go past 125 %; the auth screen scrolls and the main layout was checked
 *      at 1000 x 600 CSS (docs/worklog entry for claude/a11y-scale-text-size).
 *   2. The window's minimum size follows the scale:
 *        min = max(BASE_WINDOW_MIN, ceil(LAYOUT_MIN_CSS * scale))
 *      (`minWindowSizeFor`), so the window can never be dragged smaller than
 *      what the layout needs at that scale.
 *   3. The largest usable scale is the largest step whose LAYOUT_MIN_CSS x
 *      scale fits the work area of the display the window is on
 *      (`maxScaleForWorkArea`), so the app never asks for a window bigger than
 *      the display (growing is capped at the work area too).
 *   4. The STORED preference is never rewritten by the clamp. The EFFECTIVE
 *      scale is `min(stored, maxFit)` — move to a smaller display and the app
 *      drops to what fits; move back and the chosen size returns. The UI says
 *      "Limited by your display" whenever effective < stored.
 *   5. Applying a bigger scale first raises the minimum and grows the window
 *      (inside the work area) if it is smaller than that, THEN zooms, so the
 *      layout never paints into a too-small viewport.
 *
 * Renderer layout state needs no change: the sidebars persist their widths as
 * RATIOS of `window.innerWidth`, which is in CSS px and already divided by the
 * zoom factor, and `sidebarMaxPx(innerWidth)` reads the same CSS width.
 *
 * Chromium keys page zoom by HOST and shares it across every webContents
 * showing that host in the session. That is safe here: the main window is the
 * only one on the app's origin (http://127.0.0.1:<port> / the dev server);
 * the splash and the annotation overlay are file:// pages and the update
 * popup / wallet notice are data: URLs, so the main window's factor never
 * leaks into them and their reset to 1 never fights it.
 *
 * Which windows scale: ONLY the main window. The installer splash, the
 * "Applying update" popup and the Linux wallet notice are fixed-size windows
 * whose content is sized to the window (a zoom would clip them); the
 * annotation overlay maps 1:1 onto screen pixels and must never scale. Those
 * keep `lockPageZoom(wc)` with its fixed factor of 1.
 *
 * Host contract (also implemented by the Tauri/WebView2 host): two invokes and
 * one event, all carrying UiScaleState —
 *   invoke 'ui-scale:get'          -> UiScaleState
 *   invoke 'ui-scale:set' percent  -> UiScaleState (percent must be a step)
 *   event  'ui-scale:changed'      -> UiScaleState (source 'shortcut' | 'set' | 'display')
 *
 * Structural types only (no runtime `electron` import), so it runs under
 * vitest like page-zoom-lock.ts.
 */

/** The selectable sizes, in percent. Mirrored by src/utils/a11y/uiScale.ts (a parity test pins it). */
export const UI_SCALE_STEPS = [80, 90, 100, 110, 125, 150, 175, 200] as const;
export const UI_SCALE_DEFAULT = 100;
/** SecureStore key (device-level, not account-scoped: the sign-in screen scales too). */
export const UI_SCALE_STORE_KEY = 'uiScale';

/** The smallest CSS-px viewport the main layout is usable at. */
export const LAYOUT_MIN_CSS = { width: 1000, height: 600 } as const;
/** The main window's minimum at 100 % (the long-standing createWindow minWidth/minHeight). */
export const BASE_WINDOW_MIN = { width: 1000, height: 720 } as const;

export interface Size { width: number; height: number }
export interface Rect extends Size { x: number; y: number }

export type UiScaleSource = 'shortcut' | 'set' | 'display' | 'init';

export interface UiScaleState {
    /** The stored preference (a step). */
    percent: number;
    /** What is applied right now (<= percent; lower when the display can't hold it). */
    effective: number;
    /** The largest step the window's current display can hold. */
    max: number;
    source: UiScaleSource;
}

export function isUiScaleStep(v: unknown): v is number {
    return typeof v === 'number' && (UI_SCALE_STEPS as readonly number[]).includes(v);
}

/** The stored string -> a step; anything else (missing, tampered, old) is the default. */
export function parseStoredUiScale(raw: string | null | undefined): number {
    if (typeof raw !== 'string' || !/^\d{2,3}$/.test(raw)) return UI_SCALE_DEFAULT;
    const n = Number(raw);
    return isUiScaleStep(n) ? n : UI_SCALE_DEFAULT;
}

export function encodeUiScale(percent: number): string {
    if (!isUiScaleStep(percent)) throw new Error(`not a UI scale step: ${String(percent)}`);
    return String(percent);
}

/** CSS px -> window px at a percent, in integer math (1000 * 1.1 is 1100.0000000000002 in floats). */
function layoutPx(css: number, percent: number): number {
    return Math.ceil((css * percent) / 100);
}

/** The window's minimum size at a scale (rule 2). */
export function minWindowSizeFor(percent: number): Size {
    return {
        width: Math.max(BASE_WINDOW_MIN.width, layoutPx(LAYOUT_MIN_CSS.width, percent)),
        height: Math.max(BASE_WINDOW_MIN.height, layoutPx(LAYOUT_MIN_CSS.height, percent)),
    };
}

/**
 * The largest step whose minimum window fits `workArea` (rule 3). Never below
 * the default: a display smaller than the 100 % minimum is the pre-existing
 * situation (the OS clamps the window), not something a smaller scale is
 * forced for.
 */
export function maxScaleForWorkArea(workArea: Size): number {
    let best = UI_SCALE_DEFAULT;
    for (const step of UI_SCALE_STEPS) {
        if (step <= UI_SCALE_DEFAULT) continue;
        // The LAYOUT's need, not BASE_WINDOW_MIN: on a display already smaller
        // than 1000x720 (1920x1080 at 150 % OS scaling is ~1280x680 DIP) the
        // 100 % minimum is clamped by the OS today, and 110 % still holds
        // 1000x600 CSS there.
        if (layoutPx(LAYOUT_MIN_CSS.width, step) <= workArea.width && layoutPx(LAYOUT_MIN_CSS.height, step) <= workArea.height) best = step;
    }
    return best;
}

/** Rule 4: what is applied for a stored preference on a display that holds at most `max`. */
export function effectiveUiScale(stored: number, max: number): number {
    const s = isUiScaleStep(stored) ? stored : UI_SCALE_DEFAULT;
    return Math.min(s, max);
}

/**
 * Ctrl/Cmd + `=` / `-` / `0`: the next stored preference. Stepping in stops at
 * the display's limit (`max`) — pressing Ctrl+= past what fits would only
 * store a size the user cannot see. Stepping out from a preference above the
 * limit lands on the step below what is SHOWN, so every press visibly changes
 * something.
 */
export function stepUiScale(stored: number, action: 'in' | 'out' | 'reset', max: number): number {
    if (action === 'reset') return UI_SCALE_DEFAULT;
    const shown = effectiveUiScale(stored, max);
    const i = (UI_SCALE_STEPS as readonly number[]).indexOf(shown);
    if (action === 'in') {
        const next = UI_SCALE_STEPS[Math.min(i + 1, UI_SCALE_STEPS.length - 1)];
        return next <= max ? next : shown;
    }
    return UI_SCALE_STEPS[Math.max(i - 1, 0)];
}

/**
 * Rule 5: the window's bounds grown to at least `min`, kept inside `workArea`
 * (shifted left/up if growing would push it off the display). Returns null
 * when the bounds already satisfy `min`.
 */
export function growBoundsToFit(bounds: Rect, min: Size, workArea: Rect): Rect | null {
    if (bounds.width >= min.width && bounds.height >= min.height) return null;
    const width = Math.min(Math.max(bounds.width, min.width), workArea.width);
    const height = Math.min(Math.max(bounds.height, min.height), workArea.height);
    const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width));
    const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height));
    return { x, y, width, height };
}

// ── Controller (main window) ───────────────────────────────────────────────

/** The slice of BrowserWindow the controller touches. */
export interface ScalableWindow {
    isDestroyed(): boolean;
    isMaximized(): boolean;
    isFullScreen(): boolean;
    getBounds(): Rect;
    setBounds(r: Rect): void;
    setMinimumSize(w: number, h: number): void;
}

export interface UiScaleDeps {
    /** Reads the stored string (null when unset or the store is unavailable). */
    readStored(): string | null;
    /** Persists the encoded step. May throw (store locked): the change still applies for this session. */
    writeStored(v: string): void;
    /** The work area of the display holding `bounds`. */
    workAreaFor(bounds: Rect): Rect;
    /** Feeds page-zoom-lock's seam and snaps the window's contents to it. */
    applyZoomFactor(factor: number): void;
    /** Tells the renderer (ui-scale:changed). */
    notify(state: UiScaleState): void;
}

export interface UiScaleController {
    state(source?: UiScaleSource): UiScaleState;
    /** The factor a window opening at `bounds` will get (for webPreferences.zoomFactor, so the first paint is already scaled). */
    factorFor(bounds: Rect): number;
    /** Re-applies to the window (creation, display change, after set). */
    apply(win: ScalableWindow | null, source: UiScaleSource): UiScaleState;
    set(win: ScalableWindow | null, percent: number): UiScaleState;
    step(win: ScalableWindow | null, action: 'in' | 'out' | 'reset'): UiScaleState;
}

export function createUiScaleController(deps: UiScaleDeps): UiScaleController {
    let stored = (() => { try { return parseStoredUiScale(deps.readStored()); } catch { return UI_SCALE_DEFAULT; } })();
    let lastMax = UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1] as number;
    let lastSent = { effective: -1, max: -1 };

    const live = (win: ScalableWindow | null): win is ScalableWindow => !!win && !win.isDestroyed();

    const state = (source: UiScaleSource = 'init'): UiScaleState =>
        ({ percent: stored, effective: effectiveUiScale(stored, lastMax), max: lastMax, source });

    const apply = (win: ScalableWindow | null, source: UiScaleSource): UiScaleState => {
        if (live(win)) {
            try {
                const work = deps.workAreaFor(win.getBounds());
                lastMax = maxScaleForWorkArea(work);
                const eff = effectiveUiScale(stored, lastMax);
                const min = minWindowSizeFor(eff);
                win.setMinimumSize(min.width, min.height);
                if (!win.isMaximized() && !win.isFullScreen()) {
                    const grown = growBoundsToFit(win.getBounds(), min, work);
                    if (grown) win.setBounds(grown);
                }
                deps.applyZoomFactor(eff / 100);
            } catch { /* window tearing down */ }
        }
        const s = state(source);
        // A window move fires often; only a real change (new display limit) is news.
        const changed = s.effective !== lastSent.effective || s.max !== lastSent.max;
        if (source !== 'init' && (source !== 'display' || changed)) { try { deps.notify(s); } catch { /* renderer gone */ } }
        lastSent = { effective: s.effective, max: s.max };
        return s;
    };

    const set = (win: ScalableWindow | null, percent: number): UiScaleState => {
        if (!isUiScaleStep(percent)) throw new Error('ui-scale:set expects a UI scale step');
        stored = percent;
        try { deps.writeStored(encodeUiScale(percent)); } catch { /* store locked: session-only */ }
        return apply(win, 'set');
    };

    const step = (win: ScalableWindow | null, action: 'in' | 'out' | 'reset'): UiScaleState => {
        stored = stepUiScale(stored, action, lastMax);
        try { deps.writeStored(encodeUiScale(stored)); } catch { /* store locked: session-only */ }
        return apply(win, 'shortcut');
    };

    const factorFor = (bounds: Rect): number => {
        try { return effectiveUiScale(stored, maxScaleForWorkArea(deps.workAreaFor(bounds))) / 100; } catch { return UI_SCALE_DEFAULT / 100; }
    };

    return { state, factorFor, apply, set, step };
}
