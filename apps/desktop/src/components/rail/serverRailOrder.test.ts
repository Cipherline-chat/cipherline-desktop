import { describe, it, expect } from 'vitest';
import { mergeServerRailOrder, moveServerInRailOrder, moveServerToRailPosition } from './serverRailOrder';

describe('mergeServerRailOrder', () => {
    it('preserves the saved order for servers still joined', () => {
        expect(mergeServerRailOrder(['b', 'a', 'c'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    });

    it('appends a newly joined server (not in savedOrder) at the end, in currentIds order', () => {
        expect(mergeServerRailOrder(['a', 'c'], ['a', 'b', 'c', 'd'])).toEqual(['a', 'c', 'b', 'd']);
    });

    it('drops a server no longer joined (left, kicked, banned)', () => {
        expect(mergeServerRailOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c']);
    });

    it('drops AND appends at once', () => {
        expect(mergeServerRailOrder(['x', 'a', 'y'], ['a', 'b'])).toEqual(['a', 'b']);
    });

    it('collapses duplicate ids in savedOrder to their first occurrence', () => {
        expect(mergeServerRailOrder(['a', 'a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
    });

    it('silently drops ids in savedOrder that were never valid (unknown/garbage), never throws', () => {
        expect(mergeServerRailOrder(['ghost', 'a'], ['a', 'b'])).toEqual(['a', 'b']);
    });

    it('empty savedOrder (first run, never reordered) falls back to currentIds order', () => {
        expect(mergeServerRailOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('empty currentIds (no servers joined) returns empty, regardless of savedOrder', () => {
        expect(mergeServerRailOrder(['a', 'b'], [])).toEqual([]);
    });

    it('is idempotent: merging the merge result with the same currentIds is a no-op', () => {
        const once = mergeServerRailOrder(['c', 'a'], ['a', 'b', 'c']);
        expect(mergeServerRailOrder(once, ['a', 'b', 'c'])).toEqual(once);
    });
});

describe('moveServerInRailOrder (keyboard reorder — Alt+ArrowUp/Down)', () => {
    it('moves one slot down', () => {
        expect(moveServerInRailOrder(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
    });

    it('moves one slot up', () => {
        expect(moveServerInRailOrder(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    });

    it('clamps at the top boundary — returns the SAME reference (no-op)', () => {
        const order = ['a', 'b', 'c'];
        expect(moveServerInRailOrder(order, 'a', -1)).toBe(order);
    });

    it('clamps at the bottom boundary — returns the SAME reference (no-op)', () => {
        const order = ['a', 'b', 'c'];
        expect(moveServerInRailOrder(order, 'c', 1)).toBe(order);
    });

    it('an unknown id is a no-op — returns the SAME reference, never throws', () => {
        const order = ['a', 'b', 'c'];
        expect(moveServerInRailOrder(order, 'ghost', 1)).toBe(order);
    });

    it('a multi-slot delta still clamps to bounds instead of overshooting', () => {
        expect(moveServerInRailOrder(['a', 'b', 'c'], 'a', 10)).toEqual(['b', 'c', 'a']);
    });
});

describe('moveServerToRailPosition (pointer drag-and-drop)', () => {
    it('moves the dragged id to sit where the drop target is', () => {
        expect(moveServerToRailPosition(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    });

    it('moves upward the same way', () => {
        expect(moveServerToRailPosition(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    });

    it('dropping on itself is a no-op — returns the SAME reference', () => {
        const order = ['a', 'b', 'c'];
        expect(moveServerToRailPosition(order, 'b', 'b')).toBe(order);
    });

    it('an unknown active id is a no-op', () => {
        const order = ['a', 'b', 'c'];
        expect(moveServerToRailPosition(order, 'ghost', 'b')).toBe(order);
    });

    it('an unknown drop-target id is a no-op', () => {
        const order = ['a', 'b', 'c'];
        expect(moveServerToRailPosition(order, 'a', 'ghost')).toBe(order);
    });
});
