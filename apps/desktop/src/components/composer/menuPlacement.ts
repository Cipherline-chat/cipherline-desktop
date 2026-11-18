/**
 * Where a composer drop-up menu (font / text size) sits so it stays inside the
 * chat pane. Owner, 2026-11-17: in a narrow window the formatting bar wraps, the
 * font button lands on the left of its row, and the right-aligned 210px menu ran
 * off the pane's left edge and under the channel list.
 *
 * Pure: rects in, placement out (tested without a DOM).
 */
export interface Box { left: number; right: number; top: number; bottom: number }

export interface MenuPlacement {
    /** 'right' = menu's right edge on the button's right edge (the default). */
    align: 'right' | 'left';
    /** Extra horizontal shift in px after alignment (left-aligned only). */
    shiftX: number;
    /** Cap on width when even the whole pane is narrower than the menu, else null. */
    maxWidth: number | null;
    /** Cap on height when there isn't room above the button, else null (then it scrolls). */
    maxHeight: number | null;
}

export const MENU_GAP = 6;
export const MENU_PAD = 8;
export const MENU_MIN_HEIGHT = 140;

export function placeMenu(menu: { width: number; height: number }, anchor: Box, bounds: Box, pad = MENU_PAD): MenuPlacement {
    const minL = bounds.left + pad;
    const maxR = bounds.right - pad;
    const room = Math.max(0, maxR - minL);

    // Height: it opens upward from the button.
    const above = anchor.top - MENU_GAP - (bounds.top + pad);
    const maxHeight = menu.height > above ? Math.max(Math.min(above, menu.height), Math.min(MENU_MIN_HEIGHT, menu.height)) : null;

    // Width: wider than the whole pane -> pin to its left padding and cap.
    if (menu.width > room) {
        return { align: 'left', shiftX: minL - anchor.left, maxWidth: room, maxHeight };
    }
    // Default: right edges aligned, growing left.
    if (anchor.right - menu.width >= minL && anchor.right <= maxR) {
        return { align: 'right', shiftX: 0, maxWidth: null, maxHeight };
    }
    // Otherwise left-aligned at the button, slid back inside if it would run off the right.
    const left = Math.min(Math.max(anchor.left, minL), maxR - menu.width);
    return { align: 'left', shiftX: left - anchor.left, maxWidth: null, maxHeight };
}

/** The pane a menu must stay inside: the chat pane (it clips horizontally), within the window. */
export function menuBounds(el: Element): Box {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pane = el.closest('.chat-pane-root')?.getBoundingClientRect();
    return {
        left: Math.max(0, pane?.left ?? 0),
        right: Math.min(vw, pane?.right ?? vw),
        top: 0, // menus may rise over the feed; only the window top limits them
        bottom: Math.min(vh, pane?.bottom ?? vh),
    };
}
