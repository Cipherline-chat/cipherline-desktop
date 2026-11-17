/**
 * layoutDrop — pure drop planning for the channel list's channels, dividers
 * and sub-categories (category headers still reorder through
 * /categories/reorder). Split out of ServerChannelList so every rule is
 * unit-tested without simulating dnd-kit pointer gestures.
 *
 * The list is a set of CONTAINERS, each an ordered list of item keys:
 *   ''          the top of the list (uncategorized channels + dividers)
 *   <catId>     a top-level category (channels, dividers, sub-categories)
 *   <subId>     a sub-category (channels, dividers)
 *
 * Unlike the old channel-only drag, nothing is moved between containers while
 * the pointer travels (no onDragOver relocation): the drop is decided ONCE,
 * from the layout as it was when the drag began, the drop target, and which
 * half of the target the pointer is in. So "released over itself" simply
 * means "no change" - the failure mode channelDrop.ts documents cannot occur.
 */

import { closestCenter, pointerWithin, type CollisionDetection } from '@dnd-kit/core';
import { UNCATEGORIZED_END_ID } from './channelDrop';
import { itemKey, parseItemKey, type ChannelTree } from './channelTree';

export type LayoutOrder = Record<string, string[]>;
export type DropPlace = 'before' | 'after';

/** Container key of the top of the list. */
export const TOP = '';

/** The current layout, as ordered item keys per container. Placeholder rows
 *  (ids starting `pending:`) are not real yet and are left out. */
export function layoutOrderFromTree(tree: ChannelTree): LayoutOrder {
    const real = (id: string) => !id.startsWith('pending:');
    const order: LayoutOrder = { [TOP]: tree.top.filter(i => real(i.id)).map(i => i.key) };
    for (const c of tree.categories) {
        order[c.category.category_id] = c.items.filter(i => real(i.id)).map(i => i.key);
        for (const it of c.items) {
            if (it.kind === 'subcategory') order[it.id] = it.items.filter(i => real(i.id)).map(i => i.key);
        }
    }
    return order;
}

function containerOf(order: LayoutOrder, key: string): string | null {
    for (const [c, keys] of Object.entries(order)) if (keys.includes(key)) return c;
    return null;
}

export interface LayoutDropPlan {
    order: LayoutOrder;
    /** Containers whose order changed (source and/or target) - the PATCH body. */
    changed: string[];
}

/**
 * What dropping `activeKey` (`ch:` / `div:` / `sub:`) on `overId` does.
 *
 * Targets:
 *   - UNCATEGORIZED_END_ID          end of the top of the list
 *   - `cat:<id>` (category section) end of that category
 *   - `sub:<id>` for a channel/divider: INTO that sub-category - its start
 *     when the pointer is in the top half (`place` 'before'), else its end
 *   - any item in the same container: sortable semantics (takes its index)
 *   - any item in another container: just before / after it (`place`)
 *
 * A sub-category may only sit directly inside a top-level category (one level
 * of nesting): dropped over something inside a sub-category it lands next to
 * that sub-category instead; dropped at the top of the list it is refused.
 *
 * @returns null when nothing would change, or the drop is not allowed
 *          (`decideLayoutDrop` tells the two apart).
 */
export function planLayoutDrop(
    start: LayoutOrder,
    activeKey: string,
    overId: string,
    place: DropPlace,
    topLevelCategoryIds: ReadonlySet<string>,
): LayoutDropPlan | null {
    const v = decideLayoutDrop(start, activeKey, overId, place, topLevelCategoryIds);
    return v.kind === 'move' ? v.plan : null;
}

/** Why a drop is refused. Only one rule today; the server enforces the same. */
export type LayoutDropRefusal = 'orphan-subcategory';

export type LayoutDropVerdict =
    | { kind: 'move'; plan: LayoutDropPlan }
    /** Nothing would change (released over itself / where it already is / unknown target). */
    | { kind: 'noop' }
    /** The item cannot land there. The list shows the drop in red and, on release, says why. */
    | { kind: 'refused'; reason: LayoutDropRefusal };

/**
 * `planLayoutDrop`, but telling "nothing changes" apart from "not allowed",
 * so the list can draw an invalid target in red while dragging and explain a
 * refused drop instead of silently snapping back (owner, 2026-11-16).
 *
 * The only refusal: a sub-category whose drop would land at the TOP of the
 * list (over an uncategorized channel or divider, or the end-of-list zone).
 * Over another sub-category, or anything inside one, is NOT refused: it lands
 * beside that sub-category, inside the same top-level category. Channels and
 * dividers are never refused. Depends only on the target, not on `place`.
 */
export function decideLayoutDrop(
    start: LayoutOrder,
    activeKey: string,
    overId: string,
    place: DropPlace,
    topLevelCategoryIds: ReadonlySet<string>,
): LayoutDropVerdict {
    const NOOP: LayoutDropVerdict = { kind: 'noop' };
    const active = parseItemKey(activeKey);
    if (!active) return NOOP;
    const source = containerOf(start, activeKey);
    if (source === null) return NOOP;
    if (overId === activeKey) return NOOP;

    let target: string | null = null;
    let overKey: string | null = null; // the item to land next to, if any
    let atStart = false;

    if (overId === UNCATEGORIZED_END_ID) {
        target = TOP;
    } else if (overId.startsWith('cat:')) {
        target = overId.slice(4);
    } else {
        const over = parseItemKey(overId);
        if (!over) return NOOP;
        if (over.kind === 'subcategory' && active.kind !== 'subcategory') {
            target = over.id;
            atStart = place === 'before';
        } else {
            target = containerOf(start, overId);
            overKey = overId;
        }
    }
    if (target === null || !(target in start)) return NOOP;

    if (active.kind === 'subcategory') {
        // The top of the list: a sub-category cannot be an orphan there.
        if (target === TOP) return { kind: 'refused', reason: 'orphan-subcategory' };
        // Over something INSIDE a sub-category: land beside that sub-category.
        if (!topLevelCategoryIds.has(target)) {
            const sub = target;
            target = containerOf(start, itemKey('subcategory', sub));
            overKey = itemKey('subcategory', sub);
            atStart = false;
        }
        if (target === null || !topLevelCategoryIds.has(target)) return NOOP;
        if (target === active.id || overKey === activeKey) return NOOP;
    }

    const next: LayoutOrder = { ...start };
    const without = (c: string) => next[c].filter(k => k !== activeKey);

    if (target === source && overKey) {
        // Same container: ordinary sortable move.
        const list = next[source].slice();
        const from = list.indexOf(activeKey);
        const to = list.indexOf(overKey);
        if (from < 0 || to < 0) return NOOP;
        list.splice(to, 0, list.splice(from, 1)[0]);
        next[source] = list;
    } else {
        const list = without(target);
        let index: number;
        if (overKey) {
            const at = list.indexOf(overKey);
            index = at < 0 ? list.length : at + (place === 'after' ? 1 : 0);
        } else {
            index = atStart ? 0 : list.length;
        }
        list.splice(index, 0, activeKey);
        if (source !== target) next[source] = without(source);
        next[target] = list;
    }

    const changed = [...new Set([source, target])].filter(c => next[c].join('|') !== start[c].join('|'));
    if (changed.length === 0) return NOOP;
    return { kind: 'move', plan: { order: next, changed } };
}

/** The PATCH /servers/:sid/channel-layout body for the changed containers. */
export function layoutPatchBody(plan: LayoutDropPlan): {
    containers: Array<{ parent_category_id: string | null; items: Array<{ kind: string; id: string }> }>;
} {
    return {
        containers: plan.changed.map(c => ({
            parent_category_id: c === TOP ? null : c,
            items: plan.order[c].map(k => parseItemKey(k)!).map(p => ({ kind: p.kind, id: p.id })),
        })),
    };
}

/**
 * Apply a plan to the local rows (optimistic): every item in a changed
 * container gets its new container and `(i + 1) * 1000` - exactly what the
 * server will write (channel-layout.ts planLayoutWrites).
 */
export function applyPlanPositions(plan: LayoutDropPlan): Map<string, { parent: string | null; position: number }> {
    const out = new Map<string, { parent: string | null; position: number }>();
    for (const c of plan.changed) {
        plan.order[c].forEach((k, i) => out.set(k, { parent: c === TOP ? null : c, position: (i + 1) * 1000 }));
    }
    return out;
}

// ── Collision detection ─────────────────────────────────────────────────────

/** Most specific first: a row, then a sub-category block, then a category section. */
const specificity = (id: string): number =>
    id.startsWith('ch:') || id.startsWith('div:') ? 0
        : id === UNCATEGORIZED_END_ID ? 0
            : id.startsWith('sub:') ? 1
                : id.startsWith('cat:') ? 2 : 3;

/**
 * Which droppable the pointer means. Category sections and sub-category
 * blocks are droppables that CONTAIN rows; `closestCenter` alone compares
 * centres, and the centre of a tall category section often sits right on a
 * row inside it - a channel released on "#welding" in a sub-category landed at
 * the end of the parent category. So:
 *
 *   - dragging a category header: nearest category section (closestCenter
 *     among `cat:` only), as before;
 *   - otherwise: the MOST SPECIFIC droppable the pointer is inside (row or
 *     end-of-list sentinel, then sub-category block, then category section);
 *   - pointer in a gap between droppables: nearest row / sub-category /
 *     sentinel by centre, never a whole category section.
 */
export const layoutCollisionDetection: CollisionDetection = (args) => {
    const activeId = String(args.active.id);
    const only = (keep: (id: string) => boolean) => ({
        ...args, droppableContainers: args.droppableContainers.filter(c => keep(String(c.id))),
    });
    if (activeId.startsWith('cat:')) return closestCenter(only(id => id.startsWith('cat:')));
    const within = pointerWithin(args);
    if (within.length) {
        const best = [...within].sort((a, b) => specificity(String(a.id)) - specificity(String(b.id)))[0];
        return [best];
    }
    return closestCenter(only(id => !id.startsWith('cat:')));
};
