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
