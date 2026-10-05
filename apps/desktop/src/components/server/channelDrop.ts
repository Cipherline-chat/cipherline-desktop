/**
 * channelDrop — pure drop-target resolution for ServerChannelList's
 * uncategorized-channel drag-and-drop, split out so it's unit-testable
 * without simulating real dnd-kit pointer gestures.
 *
 * Regression context: dragging a channel to the very BOTTOM of the
 * uncategorized list (the position after the last uncategorized channel and
 * before the first category) was not a valid drop target. `@dnd-kit/core`'s
 * default `collisionDetection` is `rectIntersection`, which requires the
 * dragged rect to literally overlap a droppable's rect — past the last
 * uncategorized item there is dead space (the gap before the next category's
 * `mt-4` header) that intersects nothing, so `over` came back `null` and
 * `onDragEnd`'s `!over` branch reverted the whole gesture. It also meant an
 * uncategorized section with zero channels had no droppable at all, so a
 * channel could never be dragged OUT of a category into "no category" once
 * the uncategorized list was empty.
 *
 * Fix has two parts (see ServerChannelList.tsx):
 *  1. `DndContext` now uses `closestCenter` collision detection (dnd-kit's
 *     own recommendation for sortable lists) instead of the default
 *     `rectIntersection`, so there is no dead zone near a list boundary.
 *  2. An explicit sentinel droppable (`UNCATEGORIZED_END_ID`) is always
 *     rendered after the uncategorized channels (even when that list is
 *     empty), giving both an unambiguous "the very end of uncategorized"
 *     target and a target for an otherwise-empty uncategorized container.
 */

export interface DroppableChannel {
    channel_id: string;
    parent_category_id: string | null;
}

/** Sentinel droppable id for "the end of the uncategorized channel list" —
 *  deliberately not prefixed `ch:`/`cat:` so it can't collide with a real id. */
export const UNCATEGORIZED_END_ID = 'uncat-end';

/**
 * Resolves which category (or "uncategorized" = null) a channel would land
 * in if dropped on `overId`. Returns `undefined` when `overId` doesn't
 * resolve to any known container (e.g. a stale id, or the dragged item
 * itself never found) — callers should treat that as "no change".
 */
export function resolveDropCategoryId(
    overId: string,
    channels: DroppableChannel[],
): string | null | undefined {
    if (overId === UNCATEGORIZED_END_ID) return null;
    if (overId.startsWith('ch:')) {
        const overCh = channels.find(c => c.channel_id === overId.slice(3));
        return overCh ? (overCh.parent_category_id ?? null) : undefined;
    }
    if (overId.startsWith('cat:')) return overId.slice(4);
    return undefined;
}

/**
 * Returns a new array with `channelId` moved to the last position of
 * `containerChans` (assumed already sorted in display order) and every
 * item's `position` renumbered to `(i + 1) * 1000` — the same spacing
 * convention as the rest of ServerChannelList's reorder logic. Channels
 * that aren't `channelId` keep their relative order.
 *
 * Returns `containerChans` unchanged (same reference) if `channelId` isn't
 * found in it.
 */
export function moveChannelToEndOfContainer<T extends { channel_id: string; position: number }>(
    containerChans: T[],
    channelId: string,
): T[] {
    const moved = containerChans.find(c => c.channel_id === channelId);
    if (!moved) return containerChans;
    const rest = containerChans.filter(c => c.channel_id !== channelId);
    return [...rest, moved].map((c, i) => ({ ...c, position: (i + 1) * 1000 }));
}
