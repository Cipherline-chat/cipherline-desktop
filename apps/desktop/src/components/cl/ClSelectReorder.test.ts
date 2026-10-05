import { describe, it, expect } from 'vitest';
import { computeReorderDropIndex, applyReorderDrop } from './reorderMath';

/**
 * Pure-math cover for `ClSelect`'s drag-to-reorder, used by both the pointer
 * drag path and the Alt+Arrow keyboard equivalent (see ClSelect.tsx). These
 * two functions are the entire ordering computation — everything else is
 * event plumbing — so this is where a subtle off-by-one would hide.
 *
 * Deliberately imports the pure `reorderMath` module rather than `ClSelect`
 * itself: `ClSelect.tsx` pulls in `clPhysics.ts`, which calls
 * `window.matchMedia` at module load — undefined under this suite's `node`
 * vitest environment (no jsdom). Same split as `tooltipPlacement.ts`.
 */

function opts(values: string[]): { value: string }[] {
    return values.map((value) => ({ value }));
}

function rect(top: number, height = 30): DOMRect {
    return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() { return this; } } as DOMRect;
}

const isLocked = (v: string) => v === 'everyone';

describe('computeReorderDropIndex', () => {
    // Four rows stacked at y=0,30,60,90; a locked "everyone" trailing row.
    const options = opts(['a', 'b', 'c', 'everyone']);
    const rects = [rect(0), rect(30), rect(60), rect(90)];

    it('lands before the row whose midpoint the pointer is above', () => {
        expect(computeReorderDropIndex(5, options, rects, isLocked)).toBe(0);
        expect(computeReorderDropIndex(35, options, rects, isLocked)).toBe(1);
        expect(computeReorderDropIndex(65, options, rects, isLocked)).toBe(2);
    });

    it('clamps to just before the first locked option, never at or past it', () => {
        // Pointer well below all unlocked rows, hovering the locked row itself.
        expect(computeReorderDropIndex(95, options, rects, isLocked)).toBe(3);
        // Pointer past everything, off the bottom of the menu entirely.
        expect(computeReorderDropIndex(500, options, rects, isLocked)).toBe(3);
    });

    it('with no locked options, can land at the very end of the list', () => {
        const noLock = () => false;
        expect(computeReorderDropIndex(500, options, rects, noLock)).toBe(4);
    });

    it('skips a null rect (row not yet measured) rather than throwing', () => {
        const sparse = [rect(0), null, rect(60), rect(90)];
        expect(computeReorderDropIndex(35, options, sparse, isLocked)).toBe(2);
    });
});

describe('applyReorderDrop', () => {
    const options = opts(['a', 'b', 'c', 'd']);

    it('moves an item down (insert-before index accounts for the removed slot)', () => {
        // 'a' (index 0) dropped before index 2 ('c') lands directly above 'c'.
        expect(applyReorderDrop(options, 0, 2)).toEqual(['b', 'a', 'c', 'd']);
    });

    it('moves an item up', () => {
        // 'c' (index 2) dropped before index 0 becomes the new first item.
        expect(applyReorderDrop(options, 2, 0)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('moves an item to the very end', () => {
        expect(applyReorderDrop(options, 0, 4)).toEqual(['b', 'c', 'd', 'a']);
    });

    it('moves an item to the very start', () => {
        expect(applyReorderDrop(options, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    });

    it('returns null for a drop that lands back in the same slot (no-op)', () => {
        expect(applyReorderDrop(options, 1, 1)).toBeNull();
        // Dropping right after itself is also a no-op once the removed slot
        // is accounted for.
        expect(applyReorderDrop(options, 1, 2)).toBeNull();
    });

    it('single adjacent swap matches the keyboard nudge formulas in ClSelect (dropAt = index+2 down / index-1 up)', () => {
        // Moving index 1 ('b') down one slot: dropAt = 1 + 2 = 3.
        expect(applyReorderDrop(options, 1, 3)).toEqual(['a', 'c', 'b', 'd']);
        // Moving index 2 ('c') up one slot: dropAt = 2 - 1 = 1.
        expect(applyReorderDrop(options, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
    });
});
