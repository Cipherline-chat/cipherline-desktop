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

import { closestCenter, pointerWithin, type CollisionDetection } from '@dnd-kit/core';

export interface DroppableChannel {
    channel_id: string;
    parent_category_id: string | null;
}

/** Sentinel droppable id for "the end of the uncategorized channel list" —
 *  deliberately not prefixed `ch:`/`cat:` so it can't collide with a real id. */
export const UNCATEGORIZED_END_ID = 'uncat-end';

/**
 * Collision detection for the channel list: `closestCenter` (no dead zones),
 * except that a pointer INSIDE the end-of-uncategorized sentinel always wins.
 * Without the override the sentinel (a thin strip) only won in the few pixels
 * where its centre happened to be the nearest centre, and the tall `cat:`
 * wrappers below it often won instead - so releasing in the gap before the
 * first category header dropped the channel INTO that category.
 */
export const channelCollisionDetection: CollisionDetection = (args) => {
    const inSentinel = pointerWithin(args).find(c => c.id === UNCATEGORIZED_END_ID);
    return inSentinel ? [inSentinel] : closestCenter(args);
};

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

// ── Drop planning ───────────────────────────────────────────────────────────
//
// SECOND regression (the first, above, added the end-of-list sentinel): a
// channel dragged OUT of a category into the uncategorized list still did not
// stick when it was dropped at the end, at the top, or into an empty list. The
// sentinel fixed what the pointer could *hit*; it did not fix what happened on
// release. `onDragOver` relocates the channel into the target container the
// moment the pointer enters it, which reflows the list so the dragged row now
// sits right under the pointer — so on release `over` is the dragged item
// ITSELF. `onDragEnd` began with `if (dragId === overId) return;`, which was
// meant for "dropped back where it started" but also swallowed every
// cross-container move that had already been applied optimistically: the row
// appeared to land, nothing was PATCHed, and the next refetch put it back.
// Dropping on ANOTHER channel worked because overId !== dragId — which is why
// only "into the middle" ever worked.
//
// `planChannelDrop` decides what a drop means from the data alone and reports
// whether anything changed relative to where the drag STARTED, which is the
// question the early return was really asking.

export interface PlannableChannel {
    channel_id: string;
    parent_category_id: string | null;
    position: number;
}

export interface ReorderItem { channel_id: string; parent_category_id: string | null }

export interface ChannelDropPlan<T> {
    /** Local list to show (target container renumbered). */
    channels: T[];
    /** Full ordered body for PATCH .../channels/reorder (uncategorized first,
     *  then each category in `categoryOrder`). */
    items: ReorderItem[];
}

const inContainer = (c: PlannableChannel, cat: string | null) => (c.parent_category_id ?? null) === cat;

/** The reorder body for `channels`: uncategorized, then each category in order. */
export function buildReorderItems(
    channels: PlannableChannel[],
    categoryOrder: string[],
): ReorderItem[] {
    const byPos = (a: PlannableChannel, b: PlannableChannel) => a.position - b.position;
    const uncat = channels.filter(c => !c.parent_category_id).sort(byPos);
    const cats = categoryOrder.flatMap(id => channels.filter(c => c.parent_category_id === id).sort(byPos));
    return [...uncat, ...cats].map(c => ({ channel_id: c.channel_id, parent_category_id: c.parent_category_id ?? null }));
}

/**
 * What dropping `channelId` on `overId` does.
 *
 * @param channels      the CURRENT local list (already reflowed by onDragOver)
 * @param startChannels the list as it was when the drag began
 * @param categoryOrder category ids in display order
 * @param overId        `ch:<id>`, `cat:<id>`, UNCATEGORIZED_END_ID, or the
 *                      dragged item's own id (it is under the pointer after a
 *                      reflow) - anything else means "leave it where it is"
 * @returns null when the result is identical to the start (nothing to save)
 */
export function planChannelDrop<T extends PlannableChannel>(
    channels: T[],
    startChannels: T[],
    categoryOrder: string[],
    channelId: string,
    overId: string,
): ChannelDropPlan<T> | null {
    const active = channels.find(c => c.channel_id === channelId);
    if (!active) return null;
    const sorted = (cat: string | null) =>
        channels.filter(c => inContainer(c, cat)).sort((a, b) => a.position - b.position);
    const activeCat = active.parent_category_id ?? null;

    let target: string | null = activeCat;
    let ordered: T[] | null = null; // the target container's new order, if it changes

    if (overId === UNCATEGORIZED_END_ID) {
        target = null;
        ordered = [...sorted(null).filter(c => c.channel_id !== channelId), active];
    } else if (overId.startsWith('ch:') && overId.slice(3) !== channelId) {
        const over = channels.find(c => c.channel_id === overId.slice(3));
        if (over) {
            target = over.parent_category_id ?? null;
            if (target === activeCat) {
                // Same container: ordinary sortable semantics (the dragged row
                // takes the over row's index, whichever direction it came from).
                const list = sorted(target);
                const from = list.findIndex(c => c.channel_id === channelId);
                const to = list.findIndex(c => c.channel_id === over.channel_id);
                const moved = list.slice();
                moved.splice(to, 0, moved.splice(from, 1)[0]);
                ordered = moved;
            } else {
                // Foreign container (onDragOver did not get to relocate it):
                // land just above the row it was dropped on.
                const rest = sorted(target).filter(c => c.channel_id !== channelId);
                rest.splice(rest.findIndex(c => c.channel_id === over.channel_id), 0, active);
                ordered = rest;
            }
        }
    } else if (overId.startsWith('cat:')) {
        const catId = overId.slice(4);
        if (catId !== activeCat) {
            target = catId;
            ordered = [...sorted(catId).filter(c => c.channel_id !== channelId), active];
        }
    }

    let next = channels;
    if (ordered) {
        const orderedIds = new Set(ordered.map(c => c.channel_id));
        const renumbered = ordered.map((c, i) => ({
            ...c,
            parent_category_id: target,
            position: (i + 1) * 1000,
        }));
        next = [...channels.filter(c => !orderedIds.has(c.channel_id)), ...renumbered];
    }

    const items = buildReorderItems(next, categoryOrder);
    const before = buildReorderItems(startChannels, categoryOrder);
    const same = items.length === before.length
        && items.every((it, i) => it.channel_id === before[i].channel_id && it.parent_category_id === before[i].parent_category_id);
    if (same) return null;
    return { channels: next, items };
}
