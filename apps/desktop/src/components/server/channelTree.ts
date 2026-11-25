/**
 * channelTree — the pure model behind the server channel list once it has
 * sub-categories and dividers. No React, no I/O: ServerChannelList renders
 * what this returns, and channelTree.test.ts pins the rules.
 *
 * Shape (see @cipherline/shared channel-layout.ts for the server side):
 *
 *   top        uncategorized channels + top-of-list dividers
 *   categories each TOP-LEVEL text category, with its items:
 *                channels, dividers and SUB-CATEGORIES (one level), all in
 *                one order; a sub-category holds channels + dividers.
 *
 * Every container's items are sorted with the shared `compareLayoutItems`, so
 * the order here is the server's order, tie-breaks included.
 */

import { compareLayoutItems, isLabelDividerStyle, type LayoutItemKind } from '@cipherline/shared';
import type { ChannelInfo, CategoryInfo, DividerInfo } from '../../hooks/useServers';

export interface TreeChannel { kind: 'channel'; key: string; id: string; position: number; channel: ChannelInfo }
export interface TreeDivider { kind: 'divider'; key: string; id: string; position: number; divider: DividerInfo }
export type TreeLeaf = TreeChannel | TreeDivider;
export interface TreeSub {
    kind: 'subcategory'; key: string; id: string; position: number;
    category: CategoryInfo;
    items: TreeLeaf[];
}
export type TreeItem = TreeLeaf | TreeSub;
export interface TreeCategory { category: CategoryInfo; items: TreeItem[] }
export interface ChannelTree { top: TreeLeaf[]; categories: TreeCategory[] }

/** dnd-kit / anchor ids for list items. `cat:` stays the top-level category section. */
export function itemKey(kind: LayoutItemKind, id: string): string {
    return kind === 'channel' ? `ch:${id}` : kind === 'divider' ? `div:${id}` : `sub:${id}`;
}
export function parseItemKey(key: string): { kind: LayoutItemKind; id: string } | null {
    if (key.startsWith('ch:')) return { kind: 'channel', id: key.slice(3) };
    if (key.startsWith('div:')) return { kind: 'divider', id: key.slice(4) };
    if (key.startsWith('sub:')) return { kind: 'subcategory', id: key.slice(4) };
    return null;
}

const byLayout = (a: TreeItem, b: TreeItem) => compareLayoutItems(a, b);

/**
 * Build the tree. Pass the TEXT channels and TEXT categories only (the Calls
 * panel has its own list). Defensive about shapes the server should never
 * send, so a half-applied refetch can never make a channel vanish:
 *   - a sub-category whose parent is missing or is itself a sub-category is
 *     drawn as a top-level category;
 *   - a channel or divider whose container is missing goes to the top.
 */
export function buildChannelTree(
    channels: ChannelInfo[],
    categories: CategoryInfo[],
    dividers: DividerInfo[],
): ChannelTree {
    const byId = new Map(categories.map(c => [c.category_id, c]));
    const isTop = (c: CategoryInfo) => {
        const p = c.parent_category_id ?? null;
        if (!p || p === c.category_id) return true;
        const parent = byId.get(p);
        return !parent || !!parent.parent_category_id;
    };
    const tops = categories.filter(isTop).sort((a, b) => a.position - b.position || (a.category_id < b.category_id ? -1 : 1));
    const subs = categories.filter(c => !isTop(c));

    const containerOf = (parent: string | null | undefined): string | null => (parent && byId.has(parent) ? parent : null);
    const leaves = new Map<string | null, TreeLeaf[]>();
    const push = (container: string | null, leaf: TreeLeaf) => {
        const list = leaves.get(container);
        if (list) list.push(leaf); else leaves.set(container, [leaf]);
    };
    for (const ch of channels) {
        push(containerOf(ch.parent_category_id), { kind: 'channel', key: itemKey('channel', ch.channel_id), id: ch.channel_id, position: ch.position, channel: ch });
    }
    for (const d of dividers) {
        push(containerOf(d.parent_category_id), { kind: 'divider', key: itemKey('divider', d.divider_id), id: d.divider_id, position: d.position, divider: d });
    }

    const subItems = (sub: CategoryInfo): TreeSub => ({
        kind: 'subcategory', key: itemKey('subcategory', sub.category_id), id: sub.category_id, position: sub.position,
        category: sub,
        items: [...(leaves.get(sub.category_id) ?? [])].sort(byLayout) as TreeLeaf[],
    });

    return {
        top: [...(leaves.get(null) ?? [])].sort(byLayout) as TreeLeaf[],
        categories: tops.map(cat => ({
            category: cat,
            items: [
                ...(leaves.get(cat.category_id) ?? []),
                ...subs.filter(s => s.parent_category_id === cat.category_id).map(subItems),
            ].sort(byLayout),
        })),
    };
}

/** Every channel in a list of items, sub-categories included, in display order. */
export function channelsIn(items: TreeItem[]): ChannelInfo[] {
    const out: ChannelInfo[] = [];
    for (const it of items) {
        if (it.kind === 'channel') out.push(it.channel);
        else if (it.kind === 'subcategory') for (const leaf of it.items) if (leaf.kind === 'channel') out.push(leaf.channel);
    }
    return out;
}

// ── Divider visibility ──────────────────────────────────────────────────────

/**
 * Which dividers to draw: ALL of them (owner, 2026-11-24: "all divider types
 * can be placed anywhere and seen").
 *
 * Who may see a divider is decided by the SERVER, by its container: one inside
 * a category the member cannot see never arrives (ChannelLayoutService.
 * listDividers). Beyond that nothing here hides a divider. The old rule - hide
 * a divider when the channels around it were hidden from this member, or when
 * there was nothing after it - made a divider placed between, above or below
 * channels vanish for members and flicker for managers; a divider is a
 * decoration the manager put there on purpose, so it is drawn wherever it was
 * placed, first, last, or alone in an otherwise empty section.
 *
 * Kept as a function (not inlined) so the lists, the Calls panel and the tests
 * share one answer. `faded` is always empty now (nothing is "would be hidden
 * from members"); it stays in the shape so a caller need not change.
 */
export function dividerVisibility(tree: ChannelTree): { shown: Set<string>; faded: Set<string> } {
    const shown = new Set<string>();
    const walk = (items: TreeItem[]) => {
        for (const it of items) {
            if (it.kind === 'divider') shown.add(it.id);
            else if (it.kind === 'subcategory') walk(it.items);
        }
    };
    walk(tree.top);
    for (const c of tree.categories) walk(c.items);
    return { shown, faded: new Set<string>() };
}

/** Screen-reader text for a divider: a separator, labelled when it has words. */
export function dividerAriaLabel(d: Pick<DividerInfo, 'style' | 'label'>): string {
    return isLabelDividerStyle(d.style) && d.label ? `Section: ${d.label}` : 'Divider';
}
