/**
 * Calls-panel dividers: the drop planning that decides what PATCH
 * /channel-layout is sent (channels and dividers interleaved in one container,
 * no sub-categories), and the draw rule shared with the text list.
 */
import { describe, it, expect } from 'vitest';
import type { ChannelInfo, CategoryInfo, DividerInfo } from '../../hooks/useServers';
import { orderForContainer, planCallsDrop, callsChannelKey, callsDividerKey } from './callsLayout';
import { buildChannelTree, dividerVisibility } from './channelTree';

const hd = (id: string, parent: string | null, position: number): ChannelInfo => ({
    channel_id: id, server_id: 's', kind: 'huddle', name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
} as ChannelInfo);
const dv = (id: string, parent: string | null, position: number, style: DividerInfo['style'] = 'label'): DividerInfo => ({
    divider_id: id, server_id: 's', parent_category_id: parent, list_kind: 'calls', position, style, label: id, color: null,
});
const cat = (id: string, position: number): CategoryInfo => ({
    category_id: id, server_id: 's', name: id, position, kind: 'huddle', icon_name: null, parent_category_id: null,
});

describe('orderForContainer', () => {
    it('interleaves Calls channels and dividers by position, per container', () => {
        const order = orderForContainer([hd('a', 'C', 1000), hd('b', 'C', 3000), hd('z', null, 500)], [dv('d', 'C', 2000), dv('t', null, 100)], 'C');
        expect(order.map(i => i.key)).toEqual([callsChannelKey('a'), callsDividerKey('d'), callsChannelKey('b')]);
        expect(orderForContainer([hd('z', null, 500)], [dv('t', null, 100)], null).map(i => i.key)).toEqual([callsDividerKey('t'), callsChannelKey('z')]);
    });
});

describe('planCallsDrop', () => {
    const H = [hd('a', 'C', 1000), hd('b', 'C', 2000)];
    const D = [dv('d', 'C', 1500)];

    it('moves a divider past a channel within a category and renumbers the container', () => {
        const plan = planCallsDrop(H, D, callsDividerKey('d'), callsChannelKey('b'), 'C', 'C')!;
        expect(plan.containers).toHaveLength(1);
        expect(plan.containers[0].parent).toBe('C');
        expect(plan.containers[0].items.map(i => `${i.kind}:${i.id}:${i.position}`)).toEqual(['channel:a:1000', 'channel:b:2000', 'divider:d:3000']);
    });

    it('moves a channel above a divider', () => {
        const plan = planCallsDrop(H, D, callsChannelKey('b'), callsDividerKey('d'), 'C', 'C')!;
        expect(plan.containers[0].items.map(i => i.id)).toEqual(['a', 'b', 'd']);
        const plan2 = planCallsDrop(H, D, callsChannelKey('a'), callsDividerKey('d'), 'C', 'C')!;
        expect(plan2.containers[0].items.map(i => i.id)).toEqual(['d', 'a', 'b']);
    });

    it('a divider dragged into another category lists BOTH containers (destination first), tagged by parent', () => {
        // After the optimistic reflow the divider already has the new parent.
        const moved = [{ ...D[0], parent_category_id: 'E', position: 1000 }];
        const plan = planCallsDrop([...H, hd('e1', 'E', 1000)], moved, callsDividerKey('d'), callsChannelKey('e1'), 'C', 'E')!;
        expect(plan.containers.map(c => c.parent)).toEqual(['E', 'C']);
        expect(plan.containers[0].items.map(i => i.id)).toEqual(['d', 'e1']);
        expect(plan.containers[1].items.map(i => i.id)).toEqual(['a', 'b']);
    });

    it('dropped on a header / nothing: stays at the end of the destination', () => {
        const moved = [{ ...D[0], parent_category_id: null, position: 1000 }];
        const plan = planCallsDrop([hd('z', null, 500), ...H], moved, callsDividerKey('d'), null, 'C', null)!;
        expect(plan.containers[0].parent).toBeNull();
        expect(plan.containers[0].items.map(i => i.id)).toEqual(['z', 'd']);
    });

    it('an unknown dragged item plans nothing', () => {
        expect(planCallsDrop(H, D, callsDividerKey('ghost'), null, 'C', 'C')).toBeNull();
    });
});

describe('Calls list divider visibility (same rule as the text list)', () => {
    it('a label divider shows only over a visible Calls channel; managers see the rest marked, not dimmed', () => {
        const tree = buildChannelTree([hd('a', 'C', 1000)], [cat('C', 1000)], [dv('head', 'C', 500), dv('tail', 'C', 2000)]);
        const member = dividerVisibility(tree, false);
        expect(member.shown.has('head')).toBe(true);
        expect(member.shown.has('tail')).toBe(false);
        const manager = dividerVisibility(tree, true);
        expect(manager.shown.has('tail')).toBe(true);
        expect(manager.faded.has('tail')).toBe(true);
        expect(manager.faded.has('head')).toBe(false);
    });

    it('a divider in a Calls category the member cannot see is not sent, so nothing shows', () => {
        // The category is absent from a member's list: the divider's container is gone.
        const tree = buildChannelTree([], [], []);
        expect(dividerVisibility(tree, false).shown.size).toBe(0);
    });
});
