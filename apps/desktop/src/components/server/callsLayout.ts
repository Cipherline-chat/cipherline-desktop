/**
 * Pure helpers for the Calls panel's dividers: dnd-kit ids, the per-container
 * display order, and the drop planning that decides what PATCH
 * /channel-layout is sent. No React, so it is unit-tested directly.
 */
import { compareLayoutItems, type LayoutItemKind } from '@cipherline/shared';
import type { ChannelInfo, DividerInfo } from '../../hooks/useServers';

/** dnd-kit id of a Calls divider (Calls channels keep their `hd:` ids). */
export const CALLS_DIVIDER_PREFIX = 'cdiv:';
export const callsDividerKey = (id: string) => `${CALLS_DIVIDER_PREFIX}${id}`;
export const callsChannelKey = (id: string) => `hd:${id}`;

export interface CallsItem { key: string; kind: LayoutItemKind; id: string; position: number }

/** The display order of one container (a Calls category, or the top: null). */
export function orderForContainer(huddles: ChannelInfo[], dividers: DividerInfo[], parent: string | null): CallsItem[] {
    const items: CallsItem[] = [
        ...huddles.filter(h => (h.parent_category_id ?? null) === parent)
            .map(h => ({ key: callsChannelKey(h.channel_id), kind: 'channel' as const, id: h.channel_id, position: h.position })),
        ...dividers.filter(d => (d.parent_category_id ?? null) === parent)
            .map(d => ({ key: callsDividerKey(d.divider_id), kind: 'divider' as const, id: d.divider_id, position: d.position })),
    ];
    return items.sort(compareLayoutItems);
}

/**
 * What a drop does to the layout: the destination container's full new order
 * (the dragged item moved next to the item it was dropped on; at the end when
 * dropped on a header or nothing), plus the source container's order when the
 * item changed containers. Each is one `containers[]` entry of
 * PATCH /servers/:id/channel-layout, positions renumbered `(i + 1) * 1000`.
 */
export function planCallsDrop(
    huddles: ChannelInfo[],
    dividers: DividerInfo[],
    dragKey: string,
    overKey: string | null,
    fromParent: string | null,
    toParent: string | null,
): { containers: Array<{ parent: string | null; items: CallsItem[] }> } | null {
    const dest = orderForContainer(huddles, dividers, toParent);
    const from = dest.findIndex(i => i.key === dragKey);
    if (from === -1) return null;
    const to = overKey && overKey !== dragKey ? dest.findIndex(i => i.key === overKey) : -1;
    const moved = [...dest];
    if (to !== -1) { const [it] = moved.splice(from, 1); moved.splice(to, 0, it); }
    const number = (list: CallsItem[]) => list.map((it, i) => ({ ...it, position: (i + 1) * 1000 }));
    const containers = [{ parent: toParent, items: number(moved) }];
    if (fromParent !== toParent) containers.push({ parent: fromParent, items: number(orderForContainer(huddles, dividers, fromParent)) });
    return { containers };
}
