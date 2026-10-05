/**
 * Pure sizing math for a devicePixelRatio-aware <canvas> backing store.
 *
 * A canvas has two independent sizes: the CSS box (what layout gives it) and
 * the backing store / drawing buffer (the `width`/`height` attributes, in
 * device pixels). Code that only sets the CSS size and never touches
 * `canvas.width`/`canvas.height` leaves the backing store at the HTML
 * default of 300x150 forever — that is the root cause of the Settings
 * "motes" canvas only drawing in a ~300x150 corner (SeaBackdrop.tsx). Code
 * that sets the backing store to the CSS size 1:1 draws soft/blurry on any
 * display with devicePixelRatio > 1.
 *
 * This function is the shared fix for both: given the canvas's CSS box size
 * and the device pixel ratio, it returns the backing-store size to assign.
 * The caller is still responsible for `ctx.scale(dpr, dpr)` (or an
 * equivalent `setTransform`) so drawing calls can keep using CSS-pixel
 * coordinates.
 *
 * Kept pure (no DOM reads) so it can be unit tested without a real canvas or
 * jsdom's incomplete canvas/ResizeObserver support.
 */
export interface CanvasBackingSize {
    /** Backing-store width in device pixels — assign to `canvas.width`. */
    width: number;
    /** Backing-store height in device pixels — assign to `canvas.height`. */
    height: number;
    /** The devicePixelRatio actually used (sanitized — see below). */
    dpr: number;
}

/**
 * @param cssWidth  The canvas's CSS box width, e.g. from
 *                  `canvas.getBoundingClientRect().width`.
 * @param cssHeight The canvas's CSS box height.
 * @param dpr       `window.devicePixelRatio`. Sanitized: non-finite, zero,
 *                  or negative values fall back to 1 rather than producing a
 *                  zero-area or NaN backing store.
 */
export function computeCanvasBackingSize(cssWidth: number, cssHeight: number, dpr: number): CanvasBackingSize {
    const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const safeCssWidth = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 0;
    const safeCssHeight = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : 0;
    // Round rather than floor/ceil so a fractional CSS size (sub-pixel
    // layout, common at DPR > 1) doesn't systematically shrink or grow the
    // buffer either direction.
    //
    // Floor at 1 device pixel so a momentarily-zero-size container (mid
    // layout, a parent still at `display:none`, an initial measurement
    // before the first paint) never produces an unusable 0x0 backing store —
    // a later `ctx.scale(dpr, dpr)` against a 0-area canvas is a silent
    // no-op, not an error, so this is the difference between "draws nothing
    // until the next resize" and "throws away work forever".
    const width = Math.max(1, Math.round(safeCssWidth * safeDpr));
    const height = Math.max(1, Math.round(safeCssHeight * safeDpr));
    return { width, height, dpr: safeDpr };
}
