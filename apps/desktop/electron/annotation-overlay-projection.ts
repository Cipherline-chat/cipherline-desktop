/**
 * Pure rectangle arithmetic for the desktop annotation overlay
 * (electron/annotation-overlay.ts + annotation-overlay-preload.ts).
 *
 * ── Why this module exists ──────────────────────────────────────────────
 * Strokes arrive normalized to [0,1]² over the CAPTURED FRAME. For a
 * `screen:` share the captured frame IS the whole display — taskbar
 * included, because that is what `desktopCapturer` hands the encoder.
 *
 * The overlay used to project those strokes with `window.innerWidth` /
 * `window.innerHeight`, i.e. the overlay WINDOW's client box. That is a
 * different rectangle, and nothing tied the two together or noticed when
 * they diverged. Any divergence silently RESCALES every stroke:
 *
 *   display 1920x1080, window client area 1920x1032 (48px taskbar)
 *     normalized y = 0.5  ->  0.5 * 1032 =  516   (should be  540) — 24px high
 *     normalized y = 1.0  ->  1.0 * 1032 = 1032   (should be 1080) — 48px high
 *
 * — an error that is zero at the top of the screen and grows toward the
 * bottom, which is exactly "a little offset vertically ... it is a little
 * high". The viewers' in-app tiles were never affected: they map through
 * the <video> element's own content rect, which really is the captured
 * frame.
 *
 * So the projection must be driven by the CAPTURE rectangle, supplied by
 * the main process (which knows the Display), never inferred from the
 * window the compositor happened to give us.
 *
 * ── Coordinate spaces ───────────────────────────────────────────────────
 * All rectangles here are DIP (device-independent pixels) in Electron's
 * global screen space — the space `screen.getAllDisplays()[n].bounds` and
 * `BrowserWindow.getContentBounds()` both use. A non-primary display's
 * origin is NOT (0,0) and may be NEGATIVE (a monitor placed left of or
 * above the primary); nothing here assumes otherwise.
 *
 * `scaleFactor` deliberately does NOT appear. Windows display scaling is
 * already divided out of DIP bounds, and the canvas's backing store is
 * sized by the overlay's own `devicePixelRatio` (see `backingStoreSize`),
 * so the CSS box — the thing that decides where a stroke actually lands —
 * is scale-independent. That is what makes the same arithmetic correct at
 * 1.0, 1.5 and 2.0.
 */

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Where to put the overlay canvas, in the overlay window's own CSS pixels.
 *
 * `cssLeft`/`cssTop` are usually 0 — the window is asked for exactly the
 * display's bounds. They are non-zero only when the compositor refused
 * (a work-area clamp, a maximize-treatment, DPI rounding), and they exist
 * so a refusal shifts the canvas back onto the right display pixels
 * instead of quietly rescaling the drawing. A refusal that makes the
 * window SMALLER than the display still clips whatever now falls outside
 * it — no canvas can paint pixels the window does not own — but the part
 * that is visible is in the right place, which is the difference between
 * "the bottom of the screen is unreachable" and "everything is wrong".
 */
export interface OverlayCanvasLayout {
    cssLeft: number;
    cssTop: number;
    cssWidth: number;
    cssHeight: number;
}

/**
 * Ceiling on the canvas backing store, in device px per CSS px.
 *
 * MIRRORED in annotation-overlay-preload.ts, which cannot import this
 * module: that preload runs with `sandbox: true`, where `require` resolves
 * only `electron` and a few node builtins — never a relative path. Same
 * reason its wire types are restated inline. Keep the two in step.
 */
export const MAX_BACKING_SCALE = 2;

/** The preload's `backingScale()`, restated for tests. See the note above. */
export function effectiveBackingScale(devicePixelRatio: number): number {
    if (!(devicePixelRatio > 0) || !Number.isFinite(devicePixelRatio)) return 1;
    return Math.min(MAX_BACKING_SCALE, devicePixelRatio);
}

/** Backing-store pixel size for a CSS box at a given DPR. */
export function backingStoreSize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio: number,
): { width: number; height: number } {
    const dpr = effectiveBackingScale(devicePixelRatio);
    return {
        width: Math.max(1, Math.round(cssWidth * dpr)),
        height: Math.max(1, Math.round(cssHeight * dpr)),
    };
}

/**
 * Lay the canvas over `capture` given the client box the window actually got.
 *
 * The canvas is sized by the CAPTURE rect, not the window, and then shifted
 * by however far the window's client origin sits from the capture origin.
 */
export function overlayCanvasLayout(capture: Rect, windowContent: Rect): OverlayCanvasLayout {
    return {
        cssLeft: capture.x - windowContent.x,
        cssTop: capture.y - windowContent.y,
        cssWidth: capture.width,
        cssHeight: capture.height,
    };
}

/**
 * Ground truth: where a normalized point BELONGS, in absolute screen DIP.
 * A screen capture spans the display exactly, so this is just the lerp.
 */
export function projectToScreen(nx: number, ny: number, capture: Rect): { x: number; y: number } {
    return { x: capture.x + nx * capture.width, y: capture.y + ny * capture.height };
}

/**
 * Where a normalized point ACTUALLY lands, walked through the real render
 * path: normalized -> canvas backing px -> canvas CSS px -> window client
 * CSS px -> absolute screen DIP.
 *
 * The suite asserts this equals `projectToScreen` for every window/DPR
 * combination — that identity is the whole contract, and it is what the
 * old `window.innerHeight`-driven projection violated.
 */
export function renderedScreenPoint(
    nx: number,
    ny: number,
    layout: OverlayCanvasLayout,
    windowContent: Rect,
    devicePixelRatio: number,
): { x: number; y: number } {
    const backing = backingStoreSize(layout.cssWidth, layout.cssHeight, devicePixelRatio);
    // What the preload draws, in backing-store pixels.
    const bx = nx * backing.width;
    const by = ny * backing.height;
    // The canvas maps its backing store linearly onto its CSS box.
    const cssX = bx * (layout.cssWidth / backing.width);
    const cssY = by * (layout.cssHeight / backing.height);
    return {
        x: windowContent.x + layout.cssLeft + cssX,
        y: windowContent.y + layout.cssTop + cssY,
    };
}
