/**
 * Whether closing a context menu should hand focus back to the row that
 * opened it.
 *
 * The return exists for keyboard users: the menu's focused item unmounts and
 * focus would otherwise drop to <body>. But a menu ACTION can move focus on
 * purpose (Reply / Edit focus the composer) a moment before the menu finishes
 * its exit animation and unmounts. Returning focus unconditionally then yanks
 * it off the composer, so the user types into nothing. Only return focus when
 * it has genuinely been left homeless.
 */
export function shouldReturnFocusToRow(active: Element | null, row: Element | null): boolean {
    if (!row) return false;
    if (!active || active === document.body || active === document.documentElement) return true;
    if (!active.isConnected) return true;
    // Still sitting inside a menu (portalled .ctxm / role=menu) that is going away.
    if (active.closest('.ctxm, [role="menu"]')) return true;
    return false;
}

/**
 * Focus a message row WITHOUT scrolling the feed: the only way ChatPane's
 * message menus may focus a row (on open, and on the return above).
 *
 * A plain `el.focus()` scrolls the nearest scroll container until the element
 * is in view. A message row is often taller than the part of it on screen,
 * formatted messages above all (headings, lists, code blocks, long messages),
 * so the return after picking Save to server (or Remove from server, Pin,
 * Unpin, Save for me) in the right-click menu dragged the feed until the row's
 * top edge reached the top of the pane: "the chat jumps when I save a message"
 * (owner, 0.1.2-staging.242; harness/save-no-jump-check.mjs). The row is where
 * the reader right-clicked it, already as visible as they wanted it.
 * Right-clicking a focusable piece of a row (a spoiler, a masked link, a code
 * block's Copy button) made the open-time focus jump the same way.
 */
export function focusRowInPlace(row: Element | null | undefined): void {
    (row as HTMLElement | null | undefined)?.focus?.({ preventScroll: true });
}
