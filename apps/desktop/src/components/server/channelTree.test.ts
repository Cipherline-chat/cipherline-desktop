import { describe, it, expect } from 'vitest';
import { buildChannelTree, dividerVisibility, channelsIn, itemKey, parseItemKey } from './channelTree';
import { planLayoutDrop, decideLayoutDrop, layoutOrderFromTree, layoutPatchBody, applyPlanPositions, layoutCollisionDetection, TOP } from './layoutDrop';
import { closestCenter } from '@dnd-kit/core';
import { UNCATEGORIZED_END_ID } from './channelDrop';
import { buildUnreadModel } from './offscreenUnread';
import type { ChannelInfo, CategoryInfo, DividerInfo } from '../../hooks/useServers';

const ch = (id: string, parent: string | null, position: number): ChannelInfo => ({
    channel_id: id, server_id: 's', kind: 'text', name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
});
const cat = (id: string, position: number, parent: string | null = null): CategoryInfo => ({
    category_id: id, server_id: 's', name: id, position, kind: 'text', icon_name: null, parent_category_id: parent,
});
const div = (id: string, parent: string | null, position: number, style: DividerInfo['style'] = 'label'): DividerInfo => ({
    divider_id: id, server_id: 's', parent_category_id: parent, position, style, label: id, color: null,
});

/** The concept's "Maker Collective" list. */
function concept() {
    return buildChannelTree(
        [
            ch('welcome', null, 1000), ch('general', null, 3000),
            ch('crafting', 'CRAFT', 1000), ch('joinery', 'WOOD', 1000), ch('finishes', 'WOOD', 2000),
            ch('print', 'PRINT', 1000), ch('build', 'EVENTS', 1000), ch('offtopic', 'EVENTS', 3000),
        ],
        [cat('EVENTS', 2000), cat('CRAFT', 1000), cat('WOOD', 2000, 'CRAFT'), cat('PRINT', 3000, 'CRAFT')],
        [div('COMMUNITY', null, 2000), div('line', 'CRAFT', 9000, 'line'), div('dots', 'EVENTS', 2000, 'dots')],
    );
}

describe('buildChannelTree', () => {
    it('nests sub-categories one level under their parent and orders every container', () => {
        const t = concept();
        expect(t.top.map(i => i.id)).toEqual(['welcome', 'COMMUNITY', 'general']);
        expect(t.categories.map(c => c.category.category_id)).toEqual(['CRAFT', 'EVENTS']);
        const craft = t.categories[0];
        expect(craft.items.map(i => i.id)).toEqual(['crafting', 'WOOD', 'PRINT', 'line']);
        const wood = craft.items[1];
        expect(wood.kind).toBe('subcategory');
        expect(wood.kind === 'subcategory' && wood.items.map(i => i.id)).toEqual(['joinery', 'finishes']);
        expect(channelsIn(craft.items).map(c => c.channel_id)).toEqual(['crafting', 'joinery', 'finishes', 'print']);
    });

    it('a sub-category whose parent is missing (or is itself a sub-category) is drawn as top-level', () => {
        const t = buildChannelTree([ch('x', 'ORPHAN', 1000)], [cat('ORPHAN', 500, 'GONE'), cat('A', 1000), cat('B', 2000, 'A'), cat('C', 3000, 'B')], []);
        expect(t.categories.map(c => c.category.category_id)).toEqual(['ORPHAN', 'A', 'C']);
        expect(t.categories[0].items.map(i => i.id)).toEqual(['x']);
    });

    it('a channel or divider whose container is missing falls back to the top, never disappears', () => {
        const t = buildChannelTree([ch('lost', 'NOPE', 1000)], [], [div('d', 'NOPE', 2000)]);
        expect(t.top.map(i => i.id)).toEqual(['lost', 'd']);
    });

    it('ties break like the server: channel before sub-category before divider, then id', () => {
        const t = buildChannelTree([ch('c', 'A', 1000)], [cat('A', 1000), cat('S', 1000, 'A')], [div('d', 'A', 1000)]);
        expect(t.categories[0].items.map(i => i.kind)).toEqual(['channel', 'subcategory', 'divider']);
    });

    it('item keys round-trip', () => {
        for (const k of ['channel', 'divider', 'subcategory'] as const) expect(parseItemKey(itemKey(k, 'x'))).toEqual({ kind: k, id: 'x' });
        expect(parseItemKey('cat:x')).toBeNull();
    });
});

describe('dividerVisibility (never advertise a hidden section)', () => {
    it('a labelled divider shows only when the section AFTER it has something visible', () => {
        const t = buildChannelTree([ch('a', 'A', 1000)], [cat('A', 1000)], [div('L1', 'A', 2000), div('L0', 'A', 500)]);
        const v = dividerVisibility(t, false);
        expect(v.shown.has('L0')).toBe(true);   // heads "a"
        expect(v.shown.has('L1')).toBe(false);  // trailing: nothing visible below it
    });

    it('line / dots / space show when EITHER side has something visible', () => {
        const t = concept();
        const v = dividerVisibility(t, false);
        expect(v.shown.has('line')).toBe(true);  // closes CRAFT (content before it)
        expect(v.shown.has('dots')).toBe(true);
        const empty = buildChannelTree([], [cat('A', 1000)], [div('only', 'A', 1000, 'line')]);
        expect(dividerVisibility(empty, false).shown.size).toBe(0);
    });

    it('everything around it hidden (i.e. absent from the VIEW-filtered list) hides it', () => {
        // The member cannot see #print or #staff, so the list simply lacks them.
        const t = buildChannelTree([ch('pub', 'A', 1000)], [cat('A', 1000)], [div('STAFF ONLY', 'A', 2000)]);
        expect(dividerVisibility(t, false).shown.has('STAFF ONLY')).toBe(false);
    });

    it('a visible sub-category counts as content for the divider above it', () => {
        const t = buildChannelTree([], [cat('A', 1000), cat('S', 2000, 'A')], [div('L', 'A', 1000)]);
        expect(dividerVisibility(t, false).shown.has('L')).toBe(true);
    });

    it('managers see every divider, the would-be-hidden ones marked faded', () => {
        const t = buildChannelTree([ch('a', 'A', 1000)], [cat('A', 1000)], [div('L1', 'A', 2000)]);
        const v = dividerVisibility(t, true);
        expect(v.shown.has('L1')).toBe(true);
        expect(v.faded.has('L1')).toBe(true);
    });

    it.each(['label', 'header', 'pill', 'text'] as const)('the %s style is a LABEL style: it needs a visible item AFTER it', (style) => {
        const t = buildChannelTree([ch('a', 'A', 1000)], [cat('A', 1000)], [div('tail', 'A', 2000, style), div('head', 'A', 500, style)]);
        const v = dividerVisibility(t, false);
        expect(v.shown.has('head')).toBe(true);
        expect(v.shown.has('tail')).toBe(false);
    });

    it('a label divider with a visible channel after it is NOT marked hidden for managers (no dimming)', () => {
        const t = buildChannelTree([ch('a', null, 2000)], [], [div('L', null, 1000, 'pill')]);
        const v = dividerVisibility(t, true);
        expect(v.shown.has('L')).toBe(true);
        expect(v.faded.has('L')).toBe(false);
    });

    // Owner, 2026-11-16: "make dividers visible if they aren't under a category".
    it('top of the list: every divider is shown, never faded, even with nothing after it', () => {
        const t = buildChannelTree([], [cat('A', 1000)], [div('above-cats', null, 500), div('line', null, 600, 'line')]);
        for (const keep of [false, true]) {
            const v = dividerVisibility(t, keep);
            expect(v.shown.has('above-cats')).toBe(true);
            expect(v.shown.has('line')).toBe(true);
            expect(v.faded.size).toBe(0);
        }
    });

    it('control: the same trailing divider INSIDE a category is still hidden', () => {
        const t = buildChannelTree([], [cat('A', 1000)], [div('in-cat', 'A', 500)]);
        expect(dividerVisibility(t, false).shown.has('in-cat')).toBe(false);
    });

    it('walks inside sub-categories too', () => {
        const t = buildChannelTree([ch('j', 'S', 2000)], [cat('A', 1000), cat('S', 1000, 'A')], [div('in', 'S', 1000)]);
        expect(dividerVisibility(t, false).shown.has('in')).toBe(true);
    });
});

describe('planLayoutDrop', () => {
    const tops = new Set(['CRAFT', 'EVENTS']);
    const start = () => layoutOrderFromTree(concept());

    it('reorders within a container (sortable semantics)', () => {
        const plan = planLayoutDrop(start(), 'ch:general', 'ch:welcome', 'before', tops)!;
        expect(plan.order[TOP]).toEqual(['ch:general', 'ch:welcome', 'div:COMMUNITY']);
        expect(plan.changed).toEqual([TOP]);
    });

    it('drops a divider into a sub-category (start when over the top half of its header)', () => {
        const plan = planLayoutDrop(start(), 'div:COMMUNITY', 'sub:WOOD', 'before', tops)!;
        expect(plan.order.WOOD).toEqual(['div:COMMUNITY', 'ch:joinery', 'ch:finishes']);
        expect(plan.order[TOP]).toEqual(['ch:welcome', 'ch:general']);
        expect(plan.changed.sort()).toEqual([TOP, 'WOOD'].sort());
    });

    it('drops a channel next to an item of another container, honouring the half', () => {
        const after = planLayoutDrop(start(), 'ch:welcome', 'ch:joinery', 'after', tops)!;
        expect(after.order.WOOD).toEqual(['ch:joinery', 'ch:welcome', 'ch:finishes']);
        const before = planLayoutDrop(start(), 'ch:welcome', 'ch:joinery', 'before', tops)!;
        expect(before.order.WOOD).toEqual(['ch:welcome', 'ch:joinery', 'ch:finishes']);
    });

    it('end-of-list sentinel and category sections land at the end', () => {
        expect(planLayoutDrop(start(), 'ch:joinery', UNCATEGORIZED_END_ID, 'after', tops)!.order[TOP])
            .toEqual(['ch:welcome', 'div:COMMUNITY', 'ch:general', 'ch:joinery']);
        expect(planLayoutDrop(start(), 'ch:welcome', 'cat:EVENTS', 'after', tops)!.order.EVENTS)
            .toEqual(['ch:build', 'div:dots', 'ch:offtopic', 'ch:welcome']);
    });

    it('moves a sub-category between parents; over something inside a sub-category it lands beside it', () => {
        const toEvents = planLayoutDrop(start(), 'sub:PRINT', 'ch:build', 'after', tops)!;
        expect(toEvents.order.EVENTS).toEqual(['ch:build', 'sub:PRINT', 'div:dots', 'ch:offtopic']);
        expect(toEvents.order.CRAFT).toEqual(['ch:crafting', 'sub:WOOD', 'div:line']);
        const beside = planLayoutDrop(start(), 'sub:PRINT', 'ch:joinery', 'before', tops)!;
        expect(beside.order.CRAFT).toEqual(['ch:crafting', 'sub:PRINT', 'sub:WOOD', 'div:line']);
    });

    it('refuses a sub-category at the top of the list (one level of nesting, no orphan sub-categories)', () => {
        expect(planLayoutDrop(start(), 'sub:PRINT', 'ch:welcome', 'after', tops)).toBeNull();
        expect(planLayoutDrop(start(), 'sub:PRINT', UNCATEGORIZED_END_ID, 'after', tops)).toBeNull();
    });

    it('released over itself, or where it already is, changes nothing', () => {
        expect(planLayoutDrop(start(), 'ch:general', 'ch:general', 'after', tops)).toBeNull();
        expect(planLayoutDrop(start(), 'ch:general', UNCATEGORIZED_END_ID, 'after', tops)).toBeNull();
        expect(planLayoutDrop(start(), 'sub:WOOD', 'ch:joinery', 'after', tops)).toBeNull();
    });

    it('builds the PATCH body and the optimistic positions the server will write', () => {
        const plan = planLayoutDrop(start(), 'div:COMMUNITY', 'sub:WOOD', 'after', tops)!;
        const body = layoutPatchBody(plan);
        const wood = body.containers.find(c => c.parent_category_id === 'WOOD')!;
        expect(wood.items).toEqual([{ kind: 'channel', id: 'joinery' }, { kind: 'channel', id: 'finishes' }, { kind: 'divider', id: 'COMMUNITY' }]);
        expect(body.containers.find(c => c.parent_category_id === null)!.items.map(i => i.id)).toEqual(['welcome', 'general']);
        expect(applyPlanPositions(plan).get('div:COMMUNITY')).toEqual({ parent: 'WOOD', position: 3000 });
    });

    it('placeholder rows are never part of a write', () => {
        const t = buildChannelTree([ch('a', null, 1000), ch('pending:1', null, 2000)], [], []);
        expect(layoutOrderFromTree(t)[TOP]).toEqual(['ch:a']);
    });
});

// Owner, 2026-11-16: a sub-category dragged outside a category shows a red
// preview and, if dropped, a dialog - so "refused" must be told apart from
// "nothing changes" (both used to be null).
describe('decideLayoutDrop (refused vs no-op vs move)', () => {
    const tops = new Set(['CRAFT', 'EVENTS']);
    const start = () => layoutOrderFromTree(concept());
    const kind = (activeKey: string, overId: string, place: 'before' | 'after' = 'after') =>
        decideLayoutDrop(start(), activeKey, overId, place, tops).kind;

    describe('a sub-category: invalid targets are everything at the top of the list', () => {
        it.each([
            ['an uncategorized channel', 'ch:welcome'],
            ['the last uncategorized channel', 'ch:general'],
            ['a top-of-list divider', 'div:COMMUNITY'],
            ['the end-of-list zone (also the gap above the first category)', UNCATEGORIZED_END_ID],
        ])('over %s: refused, either half', (_label, overId) => {
            for (const place of ['before', 'after'] as const) {
                expect(decideLayoutDrop(start(), 'sub:PRINT', overId, place, tops))
                    .toEqual({ kind: 'refused', reason: 'orphan-subcategory' });
                expect(decideLayoutDrop(start(), 'sub:WOOD', overId, place, tops).kind).toBe('refused');
            }
        });

        it('planLayoutDrop still answers null there (unchanged contract)', () => {
            expect(planLayoutDrop(start(), 'sub:PRINT', 'ch:welcome', 'after', tops)).toBeNull();
            expect(planLayoutDrop(start(), 'sub:PRINT', UNCATEGORIZED_END_ID, 'before', tops)).toBeNull();
        });
    });

    describe('a sub-category: valid targets keep the normal preview (never refused)', () => {
        it.each([
            ['a category section (end of it)', 'cat:EVENTS'],
            ['a channel in another category', 'ch:build'],
            ['a divider in another category', 'div:dots'],
            ['a channel in its own category', 'ch:crafting'],
            ['another sub-category', 'sub:WOOD'],
            ['a channel INSIDE another sub-category (lands beside that sub-category)', 'ch:joinery'],
        ])('over %s: a move', (_label, overId) => {
            expect(kind('sub:PRINT', overId)).toBe('move');
        });

        it('over its own category header: a move to the end of it', () => {
            expect(kind('sub:WOOD', 'cat:CRAFT')).toBe('move');
        });
    });

    it('no-op is not a refusal: released over itself, or where it already is', () => {
        expect(kind('sub:PRINT', 'sub:PRINT')).toBe('noop');
        expect(kind('sub:WOOD', 'ch:joinery')).toBe('noop'); // inside itself = beside itself
        expect(kind('sub:PRINT', 'ch:print')).toBe('noop');
    });

    it('unknown keys are a no-op, not a refusal', () => {
        expect(kind('sub:NOPE', UNCATEGORIZED_END_ID)).toBe('noop');
        expect(kind('sub:PRINT', 'ch:nope')).toBe('noop');
        expect(kind('bogus', UNCATEGORIZED_END_ID)).toBe('noop');
    });

    describe('channels and dividers are unaffected: never refused, top of the list included', () => {
        const targets = ['ch:welcome', 'ch:general', 'div:COMMUNITY', UNCATEGORIZED_END_ID, 'cat:EVENTS', 'sub:WOOD', 'ch:joinery', 'ch:build'];
        it.each([['ch:joinery'], ['ch:print'], ['ch:offtopic'], ['div:line'], ['div:dots'], ['ch:welcome'], ['div:COMMUNITY']])('%s', (activeKey) => {
            for (const overId of targets) {
                for (const place of ['before', 'after'] as const) {
                    expect(decideLayoutDrop(start(), activeKey, overId, place, tops).kind).not.toBe('refused');
                }
            }
        });

        it('and the drops the old tests pinned still produce the same plan', () => {
            const v = decideLayoutDrop(start(), 'ch:joinery', UNCATEGORIZED_END_ID, 'after', tops);
            expect(v.kind).toBe('move');
            expect(v.kind === 'move' && v.plan.order[TOP]).toEqual(['ch:welcome', 'div:COMMUNITY', 'ch:general', 'ch:joinery']);
            expect(planLayoutDrop(start(), 'ch:joinery', UNCATEGORIZED_END_ID, 'after', tops))
                .toEqual(v.kind === 'move' ? v.plan : null);
        });
    });
});

describe('off-screen unread model with sub-categories', () => {
    const base = {
        uncategorized: [],
        unreadCounts: { j: 3, p: 1 }, mentionCounts: { p: 1 },
        serverNotifMode: 'all' as const, activeChannelId: null,
    };
    const categories = [{ category_id: 'CRAFT', channels: [], subcategories: [
        { category_id: 'WOOD', channels: [{ channel_id: 'j' }] },
        { category_id: 'PRINT', channels: [{ channel_id: 'p' }] },
    ] }];

    it('a collapsed sub-category stands in for its channels; an open one shows rows', () => {
        const m = buildUnreadModel({ ...base, categories, collapsed: { PRINT: true } });
        expect(m.has('ch:j')).toBe(true);
        expect(m.get('cat:PRINT')).toMatchObject({ kind: 'mention', mentions: 1, channelId: 'p', expandCategoryId: 'PRINT' });
    });

    it('a collapsed PARENT rolls up its sub-categories too', () => {
        const m = buildUnreadModel({ ...base, categories, collapsed: { CRAFT: true } });
        expect([...m.keys()]).toEqual(['cat:CRAFT']);
        expect(m.get('cat:CRAFT')).toMatchObject({ kind: 'mention', mentions: 1, channelId: 'j' });
    });
});

describe('layoutCollisionDetection (rows beat the sections that contain them)', () => {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 200, width: 200, height });
    const rects: Array<[string, ReturnType<typeof rect>]> = [
        ['ch:top', rect(0, 32)],
        [UNCATEGORIZED_END_ID, rect(32, 20)],
        ['cat:CRAFT', rect(60, 400)],          // the whole section: centre at y=260
        ['sub:METAL', rect(230, 60)],          // header + one row
        ['ch:welding', rect(258, 32)],
        ['cat:EVENTS', rect(470, 100)],
    ];
    const mk = (activeId: string, pointerY: number): any => {
        const droppableRects = new Map(rects);
        return {
            active: { id: activeId },
            collisionRect: rect(pointerY - 16, 32),
            droppableRects,
            droppableContainers: rects.map(([id, r]) => ({ id, rect: { current: r }, disabled: false })),
            pointerCoordinates: { x: 50, y: pointerY },
        };
    };

    it('a channel released on a row inside a sub-category targets that row, not the category section', () => {
        expect(layoutCollisionDetection(mk('ch:x', 270))[0].id).toBe('ch:welding');
        // control: centre distance alone picks the category section near there
        expect(closestCenter(mk('ch:x', 262))[0].id).toBe('cat:CRAFT');
    });

    it('on a sub-category header (inside its block, not a row): the sub-category', () => {
        expect(layoutCollisionDetection(mk('ch:x', 240))[0].id).toBe('sub:METAL');
    });

    it('inside a category but on no row or sub-category: the category (end of it)', () => {
        expect(layoutCollisionDetection(mk('div:x', 400))[0].id).toBe('cat:CRAFT');
    });

    it('the end-of-list sentinel still wins when the pointer is in it', () => {
        expect(layoutCollisionDetection(mk('ch:x', 40))[0].id).toBe(UNCATEGORIZED_END_ID);
    });

    it('in a gap: nearest row / sub-category, never a whole category section', () => {
        expect(String(layoutCollisionDetection(mk('ch:x', 465))[0].id)).not.toMatch(/^cat:/);
    });

    it('dragging a category header only ever targets category sections', () => {
        expect(String(layoutCollisionDetection(mk('cat:EVENTS', 270))[0].id)).toMatch(/^cat:/);
    });
});
