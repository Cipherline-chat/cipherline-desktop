/**
 * Geometry for the rail's overlay scrollbar (RailScrollbar.tsx). Pure, so the
 * thumb/scroll mapping is unit-tested without a DOM.
 */

/**
 * Whether the scroller overflows vertically — i.e. whether the overlay
 * scrollbar exists at all (the rail's layout no longer depends on it: the
 * tile column is centred in both cases and the bar is an overlay).
 */
/** How long the overlay bar stays visible after the last scroll event. */
export const SCROLL_SHOW_MS = 800;

export function railOverflows(scrollHeight: number, clientHeight: number): boolean {
    return scrollHeight - clientHeight > 1;
}

export interface ThumbGeometry {
    /** False when the content fits — the bar is not drawn at all. */
    visible: boolean;
    /** Thumb offset from the top of the track, px. */
    top: number;
    /** Thumb length, px. */
    height: number;
}

/**
 * @param scrollTop    scroller's scrollTop
 * @param scrollHeight scroller's scrollHeight (content + padding)
 * @param clientHeight scroller's clientHeight (the visible window)
 * @param trackLength  length of the strip the thumb travels in
 * @param minThumb     shortest thumb we allow (keeps it grabbable)
 */
export function thumbGeometry(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    trackLength: number,
    minThumb = 28,
): ThumbGeometry {
    const max = scrollHeight - clientHeight;
    if (!railOverflows(scrollHeight, clientHeight) || trackLength <= 0) return { visible: false, top: 0, height: 0 };
    const height = Math.min(trackLength, Math.max(minThumb, (clientHeight / scrollHeight) * trackLength));
    const travel = trackLength - height;
    const ratio = Math.min(1, Math.max(0, scrollTop / max));
    return { visible: true, top: ratio * travel, height };
}

/**
 * Dragging the thumb by `deltaY` px moves scrollTop by the matching fraction
 * of the scrollable range. Clamped to [0, scrollHeight - clientHeight].
 */
export function scrollTopForThumbDrag(
    startScrollTop: number,
    deltaY: number,
    scrollHeight: number,
    clientHeight: number,
    trackLength: number,
    thumbHeight: number,
): number {
    const max = Math.max(0, scrollHeight - clientHeight);
    const travel = trackLength - thumbHeight;
    if (travel <= 0 || max === 0) return startScrollTop;
    return Math.min(max, Math.max(0, startScrollTop + (deltaY / travel) * max));
}

/**
 * A click on the empty track centres the thumb on the click point.
 * `clickY` is relative to the top of the track strip.
 */
export function scrollTopForTrackClick(
    clickY: number,
    scrollHeight: number,
    clientHeight: number,
    trackLength: number,
    thumbHeight: number,
): number {
    const max = Math.max(0, scrollHeight - clientHeight);
    const travel = trackLength - thumbHeight;
    if (travel <= 0 || max === 0) return 0;
    const thumbTop = Math.min(travel, Math.max(0, clickY - thumbHeight / 2));
    return (thumbTop / travel) * max;
}
