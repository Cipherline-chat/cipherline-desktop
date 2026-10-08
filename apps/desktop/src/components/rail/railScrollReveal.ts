/**
 * Pure maths for "scroll the rail so this tile is visible".
 *
 * The server list lives in a scrolling region (`.cl-rail-scroll`). When the
 * active server changes (clicked, jumped to from a deep link, switched via
 * keyboard) it may be scrolled out of view; this returns the scrollTop that
 * brings it back with the minimum movement — the same contract as
 * `scrollIntoView({ block: 'nearest' })`, but confined to ONE container so it
 * can never scroll an ancestor (the app shell is `overflow: hidden`, but a
 * future layout change shouldn't be able to turn this into a page jump).
 *
 * All coordinates are viewport-relative (getBoundingClientRect values).
 * `margin` keeps a little breathing room so the tile's badge and the pill
 * glow aren't flush against the clipped edge.
 */
export function scrollTopToReveal(
    current: number,
    containerTop: number,
    containerHeight: number,
    itemTop: number,
    itemHeight: number,
    margin = 12,
): number {
    const itemRelTop = itemTop - containerTop; // item top within the visible box
    const itemRelBottom = itemRelTop + itemHeight;
    if (itemRelTop < margin) return Math.max(0, current + itemRelTop - margin);
    if (itemRelBottom > containerHeight - margin) {
        return Math.max(0, current + itemRelBottom - (containerHeight - margin));
    }
    return current;
}
