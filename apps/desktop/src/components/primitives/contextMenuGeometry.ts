/**
 * Geometry + timing for ContextMenu's flyouts (kept out of ContextMenu.tsx so
 * that file only exports components — fast refresh — and so these stay pure
 * and unit-testable).
 */

export const MENU_WIDTH = 220;
export const VIEWPORT_MARGIN = 8;
/** Gap between the menu and its flyout. */
export const FLYOUT_GAP = 4;
/** Hovering a row with a flyout opens it after this long. */
export const SUBMENU_OPEN_DELAY = 100;
/** Hovering a different row closes an open flyout after this long. */
export const SUBMENU_CLOSE_DELAY = 200;
/** How long the pointer may rest inside the safe triangle before the row under it takes over. */
export const SAFE_AREA_GRACE = 300;

/**
 * Where a flyout goes: beside the parent menu on the right, flipped to the
 * left when it would cross the window's right edge (and pinned inside the
 * window when neither side fits), its top on the opening row's top, pulled up
 * so its bottom stays inside the window. Pure, for tests.
 */
export function placeFlyout(args: {
    parentLeft: number; parentWidth: number; rowTop: number;
    width: number; height: number; vw: number; vh: number;
}): { top: number; left: number; side: 'right' | 'left' } {
    const { parentLeft, parentWidth, rowTop, width, height, vw, vh } = args;
    let side: 'right' | 'left' = 'right';
    let left = parentLeft + parentWidth + FLYOUT_GAP;
    if (left + width > vw - VIEWPORT_MARGIN) {
        side = 'left';
        left = parentLeft - width - FLYOUT_GAP;
        if (left < VIEWPORT_MARGIN) left = Math.max(VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN);
    }
    let top = rowTop;
    if (top + height > vh - VIEWPORT_MARGIN) top = Math.max(VIEWPORT_MARGIN, vh - height - VIEWPORT_MARGIN);
    return { top, left, side };
}

/**
 * True when `p` lies inside the triangle between `apex` (where the pointer
 * left the open row) and the flyout's near vertical edge. The apex is pushed
 * a few px away from the flyout so a pointer leaving the row at a shallow
 * angle still counts as heading for it. Pure, for tests.
 */
export function inSafeTriangle(
    apex: { x: number; y: number },
    flyout: { left: number; right: number; top: number; bottom: number },
    p: { x: number; y: number },
): boolean {
    const toRight = flyout.left >= apex.x;
    const edgeX = toRight ? flyout.left : flyout.right;
    const a = { x: apex.x + (toRight ? -4 : 4), y: apex.y };
    const b = { x: edgeX, y: flyout.top };
    const c = { x: edgeX, y: flyout.bottom };
    const sign = (p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }) =>
        (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = sign(p, a, b);
    const d2 = sign(p, b, c);
    const d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}
