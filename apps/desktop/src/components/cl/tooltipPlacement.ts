/**
 * Viewport-aware placement math for the `.cl-tip2` hover tooltip.
 *
 * Kept pure (no DOM, no React) so the flip/clamp behaviour is unit-testable —
 * the caller measures with `getBoundingClientRect()` and feeds plain numbers in.
 *
 * All coordinates are viewport-relative, matching `position: fixed` and
 * `getBoundingClientRect()`, so the result can be applied as `left`/`top`
 * without any scroll-offset arithmetic.
 */

export interface TooltipRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface TooltipSize {
    width: number;
    height: number;
}

export interface TooltipViewport {
    width: number;
    height: number;
}

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipPlacementOptions {
    /** Space between the anchor edge and the tooltip. */
    gap?: number;
    /** Minimum distance the tooltip keeps from every viewport edge. */
    margin?: number;
    /** Side to try first; the other side (on the same axis) is used when the
     *  preferred one clips. `'top'`/`'bottom'` flip vertically and centre
     *  horizontally on the anchor; `'left'`/`'right'` flip horizontally and
     *  centre vertically on the anchor. */
    preferred?: TooltipSide;
}

export interface TooltipPlacement {
    left: number;
    top: number;
    side: TooltipSide;
    /** True when the tooltip had to be shifted off the anchor's centre line. */
    clamped: boolean;
}

/** Matches the 9px offset the original `.tip2` rule used. */
export const TOOLTIP_GAP = 9;
/** Keep this much clear of every viewport edge. */
export const TOOLTIP_MARGIN = 8;

/**
 * Place `tip` next to `anchor` inside `viewport`.
 *
 * - Prefers `options.preferred` (default `'top'`, the historical behaviour).
 *   `'top'`/`'bottom'` flip vertically when the preferred side would clip and
 *   centre the tooltip horizontally on the anchor, clamping back inside the
 *   margins. `'left'`/`'right'` do the mirror image: flip horizontally and
 *   centre vertically.
 * - When neither side on the chosen axis fits, picks whichever has more room
 *   and clamps the tooltip inside the viewport rather than letting it run
 *   off-screen.
 */
export function computeTooltipPlacement(
    anchor: TooltipRect,
    tip: TooltipSize,
    viewport: TooltipViewport,
    options: TooltipPlacementOptions = {},
): TooltipPlacement {
    const gap = options.gap ?? TOOLTIP_GAP;
    const margin = options.margin ?? TOOLTIP_MARGIN;
    const preferred: TooltipSide = options.preferred ?? 'top';

    if (preferred === 'left' || preferred === 'right') {
        return computeHorizontalPlacement(anchor, tip, viewport, gap, margin, preferred);
    }
    return computeVerticalPlacement(anchor, tip, viewport, gap, margin, preferred);
}

/** `'top'`/`'bottom'`: flips vertically, centres + clamps horizontally. */
function computeVerticalPlacement(
    anchor: TooltipRect,
    tip: TooltipSize,
    viewport: TooltipViewport,
    gap: number,
    margin: number,
    preferred: 'top' | 'bottom',
): TooltipPlacement {
    const topSideTop = anchor.top - gap - tip.height;
    const bottomSideTop = anchor.top + anchor.height + gap;

    const fitsTop = topSideTop >= margin;
    const fitsBottom = bottomSideTop + tip.height <= viewport.height - margin;

    let side: TooltipSide;
    if (fitsTop && fitsBottom) {
        side = preferred;
    } else if (fitsTop) {
        side = 'top';
    } else if (fitsBottom) {
        side = 'bottom';
    } else {
        // Neither side fits — use whichever has more room, then clamp below.
        const roomAbove = anchor.top;
        const roomBelow = viewport.height - (anchor.top + anchor.height);
        side = roomAbove >= roomBelow ? 'top' : 'bottom';
    }

    // Clamp vertically so an oversized tooltip still lands on screen.
    const maxTop = Math.max(margin, viewport.height - margin - tip.height);
    const rawTop = side === 'top' ? topSideTop : bottomSideTop;
    const top = Math.min(Math.max(rawTop, margin), maxTop);

    // Centre on the anchor, then shift back inside the horizontal margins.
    const centred = anchor.left + anchor.width / 2 - tip.width / 2;
    const maxLeft = viewport.width - margin - tip.width;
    let left = centred;
    let clamped = false;
    if (maxLeft <= margin) {
        // Tooltip is wider than the usable viewport — pin to the left margin.
        left = margin;
        clamped = true;
    } else if (left < margin) {
        left = margin;
        clamped = true;
    } else if (left > maxLeft) {
        left = maxLeft;
        clamped = true;
    }

    return { left: Math.round(left), top: Math.round(top), side, clamped };
}

/** `'left'`/`'right'`: flips horizontally, centres + clamps vertically. Exact
 *  mirror of `computeVerticalPlacement` with the axes swapped. */
function computeHorizontalPlacement(
    anchor: TooltipRect,
    tip: TooltipSize,
    viewport: TooltipViewport,
    gap: number,
    margin: number,
    preferred: 'left' | 'right',
): TooltipPlacement {
    const leftSideLeft = anchor.left - gap - tip.width;
    const rightSideLeft = anchor.left + anchor.width + gap;

    const fitsLeft = leftSideLeft >= margin;
    const fitsRight = rightSideLeft + tip.width <= viewport.width - margin;

    let side: TooltipSide;
    if (fitsLeft && fitsRight) {
        side = preferred;
    } else if (fitsRight) {
        side = 'right';
    } else if (fitsLeft) {
        side = 'left';
    } else {
        // Neither side fits — use whichever has more room, then clamp below.
        const roomLeft = anchor.left;
        const roomRight = viewport.width - (anchor.left + anchor.width);
        side = roomRight >= roomLeft ? 'right' : 'left';
    }

    // Clamp horizontally so an oversized tooltip still lands on screen.
    const maxLeft = Math.max(margin, viewport.width - margin - tip.width);
    const rawLeft = side === 'right' ? rightSideLeft : leftSideLeft;
    const left = Math.min(Math.max(rawLeft, margin), maxLeft);

    // Centre on the anchor, then shift back inside the vertical margins.
    const centred = anchor.top + anchor.height / 2 - tip.height / 2;
    const maxTop = viewport.height - margin - tip.height;
    let top = centred;
    let clamped = false;
    if (maxTop <= margin) {
        // Tooltip is taller than the usable viewport — pin to the top margin.
        top = margin;
        clamped = true;
    } else if (top < margin) {
        top = margin;
        clamped = true;
    } else if (top > maxTop) {
        top = maxTop;
        clamped = true;
    }

    return { left: Math.round(left), top: Math.round(top), side, clamped };
}
