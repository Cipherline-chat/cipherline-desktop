/**
 * videoZoomPan — pure maths for cursor-anchored zoom + clamped pan on a
 * focused video tile.
 *
 * Nothing here touches the DOM. The React/DOM glue lives in
 * hooks/useVideoZoomPan.ts; this module owns every number, because that is
 * where the bugs live (anchoring drift, off-by-one clamps, letterbox gutters).
 *
 * ── Coordinate spaces ────────────────────────────────────────────────────
 * `viewport`  the transform wrapper's own layout box, CSS px, origin at its
 *             top-left. Pointer positions are given in this space.
 * `content`   where the frame is actually painted inside that box, CSS px,
 *             also relative to its top-left. For an `object-contain`
 *             screenshare in a wider box this is inset by the letterbox bars;
 *             callers get it from annotationGeometry.contentRect() so the
 *             zoom layer and the annotation layer agree on where the picture
 *             is, to the pixel.
 * `local`     content-space before the transform. Screen = t + scale * local,
 *             which is exactly what `transform-origin: 0 0` gives us — the
 *             reason we pin the origin to the top-left rather than centre.
 *
 * The transform this produces is `translate(tx px, ty px) scale(scale)` with
 * `transform-origin: 0 0`. Applied to ONE wrapper element, so it stays on the
 * compositor: no width/height/left/top anywhere in this feature.
 */

export interface ZoomState {
    scale: number;
    /** CSS px, applied before the scale (transform-origin: 0 0). */
    tx: number;
    ty: number;
}

export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** Fit — never zoom out past the natural frame, so 1x is the floor. */
export const MIN_SCALE = 1;

/**
 * 5x.
 *
 * The useful ceiling is set by pixel parity, not by taste. The focused banner
 * is at most ~75% of window height, so a 4K (3840px) screenshare lands in a
 * ~1400px-wide pane — about 0.36x native. 5x takes that to ~1.8x native,
 * comfortably past 1:1, which is the point where you have genuinely recovered
 * every pixel the sender transmitted (small terminal text in a shared window
 * becomes readable). Past ~5x there is no more detail to reveal: you are
 * magnifying VP8/H.264 blocking artifacts, and it reads as broken rather than
 * zoomed. It also keeps the annotation canvas backing store bounded — see the
 * effective-DPR clamp in AnnotationOverlay.
 */
export const MAX_SCALE = 5;

export const IDENTITY: ZoomState = Object.freeze({ scale: 1, tx: 0, ty: 0 });

/** A single wheel/pinch event may at most double or halve the scale, so a
 *  flung wheel or a coarse deltaMode can never teleport the view. */
const MAX_STEP = 2;

/** deltaY per notch differs wildly by device; normalise to CSS px first. */
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 400;

/**
 * Zoom sensitivity, as an exponent per normalised px of wheel delta.
 *
 * Two very different input streams arrive as `wheel`:
 *  - A mouse wheel notch is chunky (|deltaY| ~= 100 in deltaMode 0, or 3
 *    lines in deltaMode 1). At 0.0015 one notch is exp(0.15) ~= 1.16x, so
 *    1x -> 5x is ~11 notches: brisk without being twitchy.
 *  - A macOS trackpad pinch arrives as `wheel` with ctrlKey: true and much
 *    finer, higher-frequency deltas (|deltaY| ~= 1..10). It needs a larger
 *    per-px rate or a pinch would barely move the scale.
 */
const WHEEL_RATE = 0.0015;
const PINCH_RATE = 0.01;

export function clampScale(scale: number): number {
    // NaN has no magnitude to clamp toward, so it falls back to the safe,
    // un-zoomed floor. +/-Infinity does have one, and Math.min/max resolve it
    // to the right end of the range on their own.
    if (Number.isNaN(scale)) return MIN_SCALE;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function isZoomed(state: ZoomState): boolean {
    return state.scale > MIN_SCALE + 1e-6;
}

/** The whole viewport, used as the content rect when the frame's intrinsic
 *  size is not known yet (video metadata not loaded). */
export function fullRect(viewport: Size): Rect {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
}

/**
 * Clamp one axis of the translation.
 *
 * Two regimes, and the split is what keeps letterbox gutters from appearing:
 *  - The scaled content is LARGER than the viewport on this axis: the user may
 *    pan, but only within the content — its leading edge may not come past the
 *    viewport's leading edge, nor its trailing edge past the trailing edge. So
 *    the viewport is always entirely filled with picture.
 *  - The scaled content is SMALLER (or equal): there is no pannable range at
 *    all, so it is pinned centred. This is the case that reproduces the
 *    browser's own `object-fit` centring exactly at scale 1 — which is why
 *    scale 1 always resolves to tx = ty = 0 and the tile looks untouched.
 */
function clampAxis(
    t: number,
    scale: number,
    viewportLen: number,
    contentStart: number,
    contentLen: number,
): number {
    const start = scale * contentStart;
    const len = scale * contentLen;
    if (!(len > viewportLen)) {
        // Not pannable on this axis — centre the content in the viewport.
        return (viewportLen - len) / 2 - start;
    }
    const min = viewportLen - (start + len); // content's trailing edge at the viewport's
    const max = -start;                      // content's leading edge at the viewport's
    return Math.min(max, Math.max(min, t));
}

/** Clamp a whole state: scale into range, then translation into the content. */
export function clampState(state: ZoomState, viewport: Size, content: Rect): ZoomState {
    const scale = clampScale(state.scale);
    return {
        scale,
        tx: clampAxis(state.tx, scale, viewport.width, content.x, content.width),
        ty: clampAxis(state.ty, scale, viewport.height, content.y, content.height),
    };
}

/**
 * Zoom by `factor` about `anchor` (viewport-space CSS px).
 *
 * The invariant: the content point under the cursor stays under the cursor.
 * With screen = t + s * local, the local point under the anchor is
 * (anchor - t) / s; holding it fixed at the new scale gives
 * t' = anchor - s' * local. Clamping afterwards can pull the view off the
 * anchor, but only at an edge, where the alternative would be showing gutter.
 */
export function zoomAt(
    state: ZoomState,
    anchor: Point,
    factor: number,
    viewport: Size,
    content: Rect,
): ZoomState {
    const scale = clampScale(state.scale * factor);
    const localX = (anchor.x - state.tx) / state.scale;
    const localY = (anchor.y - state.ty) / state.scale;
    return clampState(
        { scale, tx: anchor.x - scale * localX, ty: anchor.y - scale * localY },
        viewport,
        content,
    );
}

/** Pan by a screen-space delta (CSS px), clamped to the content. */
export function panBy(
    state: ZoomState,
    dx: number,
    dy: number,
    viewport: Size,
    content: Rect,
): ZoomState {
    return clampState({ scale: state.scale, tx: state.tx + dx, ty: state.ty + dy }, viewport, content);
}

/**
 * Turn one wheel event into a scale multiplier.
 *
 * Disambiguating pan-scroll from zoom: `ctrlKey` is the standard signal, and
 * Chromium synthesises it for a macOS trackpad pinch (there is no separate
 * pinch event on the desktop web). So ctrlKey means "definitely zoom, and the
 * deltas are fine-grained".
 *
 * A plain wheel is ALSO treated as zoom here, deliberately. On a focused video
 * surface there is nothing to scroll — no document flow, no overflow — so
 * there is no scroll gesture to preserve and no ambiguity to resolve: the
 * feature request is literally "mouse wheel in". Two-finger trackpad scroll
 * therefore zooms too, which is the same behaviour every map and image viewer
 * gives an unmodified wheel over a zoomable canvas. The distinction that
 * matters is only the sensitivity, not the meaning.
 */
export function wheelZoomFactor(ev: { deltaY: number; deltaMode?: number; ctrlKey?: boolean }): number {
    const mode = ev.deltaMode ?? 0;
    const scaleForMode = mode === 1 ? LINE_HEIGHT_PX : mode === 2 ? PAGE_HEIGHT_PX : 1;
    const px = ev.deltaY * scaleForMode;
    if (!Number.isFinite(px) || px === 0) return 1;
    const rate = ev.ctrlKey ? PINCH_RATE : WHEEL_RATE;
    // Wheel-up (negative deltaY) zooms in.
    const factor = Math.exp(-px * rate);
    return Math.min(MAX_STEP, Math.max(1 / MAX_STEP, factor));
}
