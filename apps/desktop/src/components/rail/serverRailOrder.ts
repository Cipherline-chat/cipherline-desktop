/**
 * Pure ordering logic for the left server rail's drag-to-reorder feature.
 *
 * Kept free of React, dnd-kit, and secureLocalStore imports so it can be
 * unit-tested in isolation — see serverRailOrder.test.ts. The React-facing
 * half (persistence, per-account rebinding) lives in useServerRailOrder.ts.
 *
 * The rail persists an explicit order (a list of server ids) separately from
 * the server list itself, because the server list's own order (API/join
 * order) is not something the user chose. `mergeServerRailOrder` reconciles
 * the two on every render:
 *   - a server the user still belongs to keeps its saved position
 *   - a server the user left is silently dropped (never crashes on a
 *     missing/unknown id)
 *   - a server not yet in the saved order (freshly joined, or the very
 *     first run before any drag has happened) is appended at the end, in
 *     its `currentIds` order
 */

/**
 * Merge a persisted rail order with the current set of joined server ids.
 *
 * `savedOrder` may contain ids for servers the user has since left (dropped),
 * may be missing ids for servers joined since the last reorder (appended),
 * and — defensively, since this reads back whatever JSON was on disk — may
 * contain duplicates (collapsed to the first occurrence) or entries that
 * were never valid server ids at all (silently dropped, same as a left
 * server). None of that throws.
 */
export function mergeServerRailOrder(savedOrder: string[], currentIds: string[]): string[] {
    const currentSet = new Set(currentIds);
    const seen = new Set<string>();
    const merged: string[] = [];

    for (const id of savedOrder) {
        if (currentSet.has(id) && !seen.has(id)) {
            seen.add(id);
            merged.push(id);
        }
    }
    for (const id of currentIds) {
        if (!seen.has(id)) {
            seen.add(id);
            merged.push(id);
        }
    }
    return merged;
}

/**
 * Move `id` by `delta` slots (±1 for the Alt+ArrowUp/Down keyboard reorder),
 * clamped to the array bounds. Returns the SAME array reference — not a copy
 * — when `id` is absent or the move is a no-op (already at the boundary in
 * that direction), so callers can skip a redundant persist/re-render with a
 * reference-equality check.
 */
export function moveServerInRailOrder(order: string[], id: string, delta: number): string[] {
    const from = order.indexOf(id);
    if (from === -1) return order;
    const to = Math.max(0, Math.min(order.length - 1, from + delta));
    if (to === from) return order;
    const next = order.slice();
    next.splice(from, 1);
    next.splice(to, 0, id);
    return next;
}

/**
 * Move `activeId` to sit where `overId` currently is — the drag-and-drop
 * drop target. Same no-op contract as {@link moveServerInRailOrder}: returns
 * `order` unchanged (by reference) if either id is missing or they're
 * already equal.
 */
export function moveServerToRailPosition(order: string[], activeId: string, overId: string): string[] {
    const from = order.indexOf(activeId);
    const to = order.indexOf(overId);
    if (from === -1 || to === -1 || from === to) return order;
    const next = order.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
}
