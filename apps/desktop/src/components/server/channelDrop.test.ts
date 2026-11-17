import { describe, it, expect } from 'vitest';
import { closestCenter } from '@dnd-kit/core';
import { resolveDropCategoryId, moveChannelToEndOfContainer, UNCATEGORIZED_END_ID, planChannelDrop, buildReorderItems, channelCollisionDetection } from './channelDrop';

describe('resolveDropCategoryId', () => {
    const channels = [
        { channel_id: 'a', parent_category_id: null },
        { channel_id: 'b', parent_category_id: 'cat-1' },
    ];

    it('resolves a `ch:` id to that channel\'s category', () => {
        expect(resolveDropCategoryId('ch:b', channels)).toBe('cat-1');
    });

    it('resolves a `ch:` id pointing at an uncategorized channel to null', () => {
        expect(resolveDropCategoryId('ch:a', channels)).toBeNull();
    });

    it('resolves a `cat:` id to the category id directly', () => {
        expect(resolveDropCategoryId('cat:cat-2', channels)).toBe('cat-2');
    });

    it('resolves the end-of-uncategorized sentinel to null (uncategorized)', () => {
        expect(resolveDropCategoryId(UNCATEGORIZED_END_ID, channels)).toBeNull();
    });

    it('returns undefined for a `ch:` id that no longer exists (no change)', () => {
        expect(resolveDropCategoryId('ch:missing', channels)).toBeUndefined();
    });

    it('returns undefined for an unrecognized id shape (no change)', () => {
        expect(resolveDropCategoryId('bogus', channels)).toBeUndefined();
    });
});

describe('moveChannelToEndOfContainer', () => {
    const container = [
        { channel_id: 'a', position: 1000 },
        { channel_id: 'b', position: 2000 },
        { channel_id: 'c', position: 3000 },
    ];

    it('moves the first channel to the last position, renumbering everyone', () => {
        const result = moveChannelToEndOfContainer(container, 'a');
        expect(result.map(c => c.channel_id)).toEqual(['b', 'c', 'a']);
        expect(result.map(c => c.position)).toEqual([1000, 2000, 3000]);
    });

    it('preserves the relative order of the untouched channels', () => {
        const result = moveChannelToEndOfContainer(container, 'b');
        expect(result.map(c => c.channel_id)).toEqual(['a', 'c', 'b']);
    });

    it('is a no-op (by value) when the channel is already last', () => {
        const result = moveChannelToEndOfContainer(container, 'c');
        expect(result.map(c => c.channel_id)).toEqual(['a', 'b', 'c']);
        expect(result.map(c => c.position)).toEqual([1000, 2000, 3000]);
    });

    it('returns the input unchanged when the channel id is not found', () => {
        const result = moveChannelToEndOfContainer(container, 'missing');
        expect(result).toBe(container);
    });

    it('handles a single-channel container', () => {
        const single = [{ channel_id: 'only', position: 1000 }];
        const result = moveChannelToEndOfContainer(single, 'only');
        expect(result).toEqual([{ channel_id: 'only', position: 1000 }]);
    });

    it('handles an empty container gracefully', () => {
        const result = moveChannelToEndOfContainer([], 'x');
        expect(result).toEqual([]);
    });
});

// ── planChannelDrop ─────────────────────────────────────────────────────────

type Ch = { channel_id: string; parent_category_id: string | null; position: number };
const ch = (id: string, cat: string | null, position: number): Ch => ({ channel_id: id, parent_category_id: cat, position });
const CATS = ['cat-1', 'cat-2'];
// uncategorized: u1 u2 | cat-1: a b | cat-2: c
const START: Ch[] = [ch('u1', null, 1000), ch('u2', null, 2000), ch('a', 'cat-1', 1000), ch('b', 'cat-1', 2000), ch('c', 'cat-2', 1000)];
const ids = (items: { channel_id: string }[]) => items.map(i => i.channel_id).join(',');

/** What onDragOver does when `id` enters `cat`: relocate to the END of it. */
const reflow = (list: Ch[], id: string, cat: string | null): Ch[] => {
    const max = Math.max(0, ...list.filter(c => (c.parent_category_id ?? null) === cat).map(c => c.position));
    return list.map(c => (c.channel_id === id ? { ...c, parent_category_id: cat, position: max + 1000 } : c));
};

describe('planChannelDrop', () => {
    it('REGRESSION: a category channel reflowed into uncategorized and released over ITSELF is still saved', () => {
        const current = reflow(START, 'a', null);
        const plan = planChannelDrop(current, START, CATS, 'a', 'ch:a');
        expect(plan).not.toBeNull();
        expect(plan!.items.find(i => i.channel_id === 'a')!.parent_category_id).toBeNull();
        expect(ids(plan!.items.slice(0, 3))).toBe('u1,u2,a'); // at the end of uncategorized
    });

    it('dropping on the end-of-uncategorized sentinel puts the channel last in uncategorized', () => {
        const current = reflow(START, 'b', null);
        const plan = planChannelDrop(current, START, CATS, 'b', UNCATEGORIZED_END_ID);
        expect(ids(plan!.items.slice(0, 3))).toBe('u1,u2,b');
        expect(plan!.items.find(i => i.channel_id === 'b')!.parent_category_id).toBeNull();
    });

    it('sentinel works even when the channel was never reflowed (fast release)', () => {
        const plan = planChannelDrop(START, START, CATS, 'a', UNCATEGORIZED_END_ID);
        expect(plan!.items.find(i => i.channel_id === 'a')!.parent_category_id).toBeNull();
        expect(ids(plan!.items.slice(0, 3))).toBe('u1,u2,a');
        expect(plan!.channels.find(c => c.channel_id === 'a')!.position).toBe(3000);
    });

    it('top of uncategorized: dropping on the first uncategorized row puts the channel first', () => {
        const current = reflow(START, 'a', null);
        const plan = planChannelDrop(current, START, CATS, 'a', 'ch:u1');
        expect(ids(plan!.items.slice(0, 3))).toBe('a,u1,u2');
        expect(plan!.items[0].parent_category_id).toBeNull();
    });

    it('dropping on a row of another container that was not reflowed lands just above it', () => {
        const plan = planChannelDrop(START, START, CATS, 'a', 'ch:u2');
        expect(ids(plan!.items.slice(0, 3))).toBe('u1,a,u2');
        expect(plan!.items.find(i => i.channel_id === 'a')!.parent_category_id).toBeNull();
    });

    it('empty uncategorized list: the sentinel still receives the channel', () => {
        const start = [ch('a', 'cat-1', 1000), ch('b', 'cat-1', 2000)];
        const plan = planChannelDrop(start, start, CATS, 'b', UNCATEGORIZED_END_ID);
        expect(plan!.items).toEqual([
            { channel_id: 'b', parent_category_id: null },
            { channel_id: 'a', parent_category_id: 'cat-1' },
        ]);
    });

    it('empty uncategorized list after reflow, released over itself, is saved', () => {
        const start = [ch('a', 'cat-1', 1000), ch('b', 'cat-1', 2000)];
        const plan = planChannelDrop(reflow(start, 'a', null), start, CATS, 'a', 'ch:a');
        expect(plan!.items[0]).toEqual({ channel_id: 'a', parent_category_id: null });
    });

    it('end of a category: dropping on the category it is already in moves nothing, dropping on another appends', () => {
        expect(planChannelDrop(START, START, CATS, 'a', 'cat:cat-1')).toBeNull();
        const plan = planChannelDrop(START, START, CATS, 'u1', 'cat:cat-1');
        expect(plan!.items.filter(i => i.parent_category_id === 'cat-1').map(i => i.channel_id)).toEqual(['a', 'b', 'u1']);
    });

    it('end of a category via a reflow released over itself is saved', () => {
        const plan = planChannelDrop(reflow(START, 'u1', 'cat-2'), START, CATS, 'u1', 'ch:u1');
        expect(plan!.items.filter(i => i.parent_category_id === 'cat-2').map(i => i.channel_id)).toEqual(['c', 'u1']);
    });

    it('same-container reorder follows sortable semantics in both directions', () => {
        expect(ids(planChannelDrop(START, START, CATS, 'u1', 'ch:u2')!.items.slice(0, 2))).toBe('u2,u1');
        expect(ids(planChannelDrop(START, START, CATS, 'u2', 'ch:u1')!.items.slice(0, 2))).toBe('u2,u1');
    });

    it('dropped back exactly where it started => null (nothing to save)', () => {
        expect(planChannelDrop(START, START, CATS, 'u1', 'ch:u1')).toBeNull();
        expect(planChannelDrop(START, START, CATS, 'u1', 'bogus')).toBeNull();
        // moved away and back within one gesture
        expect(planChannelDrop(START, START, CATS, 'a', UNCATEGORIZED_END_ID)).not.toBeNull();
        const back = reflow(reflow(START, 'a', null), 'a', 'cat-1').map(c => (c.channel_id === 'a' ? { ...c, position: 1000 } : c));
        expect(planChannelDrop(back, START, CATS, 'a', 'ch:a')).toBeNull();
    });

    it('unknown channel id => null', () => {
        expect(planChannelDrop(START, START, CATS, 'zzz', UNCATEGORIZED_END_ID)).toBeNull();
    });

    it('buildReorderItems orders uncategorized first, then categories in display order', () => {
        expect(ids(buildReorderItems(START, ['cat-2', 'cat-1']))).toBe('u1,u2,c,a,b');
    });
});

describe('channelCollisionDetection', () => {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 200, width: 200, height });
    const mk = (pointerY: number, rectTop = pointerY + 20) => {
        const droppableRects = new Map<string, any>([
            ['ch:u1', rect(0, 32)],
            [UNCATEGORIZED_END_ID, rect(32, 8)],
            ['cat:cat-1', rect(56, 120)],
        ]);
        return {
            active: { id: 'ch:a' },
            collisionRect: rect(rectTop, 32), // by default the dragged rect sits BELOW the pointer: centre nearer cat:cat-1
            droppableRects,
            droppableContainers: [...droppableRects.keys()].map(id => ({ id, rect: { current: droppableRects.get(id) }, disabled: false })),
            pointerCoordinates: { x: 50, y: pointerY },
        } as any;
    };

    it('a pointer inside the sentinel wins even when another centre is nearer', () => {
        expect(channelCollisionDetection(mk(36, 96))[0].id).toBe(UNCATEGORIZED_END_ID);
    });

    it('control: plain closestCenter would have picked the category here', () => {
        expect(closestCenter(mk(36, 96))[0].id).toBe('cat:cat-1');
    });

    it('elsewhere it falls back to closestCenter', () => {
        expect(channelCollisionDetection(mk(10, 0))[0].id).toBe('ch:u1');
    });
});
