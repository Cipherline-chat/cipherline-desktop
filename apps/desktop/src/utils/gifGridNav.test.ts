import { describe, it, expect } from 'vitest';
import { nextGridIndex } from './gifGridNav';

// 3-column grid of 8:   0 1 2
//                       3 4 5
//                       6 7
describe('nextGridIndex', () => {
    const nav = (i: number, key: string, count = 8) => nextGridIndex(i, key, count, 3);

    it('moves left/right and clamps at the ends', () => {
        expect(nav(0, 'ArrowRight')).toBe(1);
        expect(nav(7, 'ArrowRight')).toBe(7);
        expect(nav(1, 'ArrowLeft')).toBe(0);
        expect(nav(0, 'ArrowLeft')).toBe(0);
    });

    it('moves by a row vertically', () => {
        expect(nav(1, 'ArrowDown')).toBe(4);
        expect(nav(4, 'ArrowUp')).toBe(1);
    });

    it('ArrowUp from the first row hands focus back to the search box', () => {
        expect(nav(0, 'ArrowUp')).toBe('search');
        expect(nav(2, 'ArrowUp')).toBe('search');
    });

    it('ArrowDown into a ragged last row lands on the last item', () => {
        expect(nav(5, 'ArrowDown')).toBe(7);
        expect(nav(4, 'ArrowDown')).toBe(7);
        expect(nav(3, 'ArrowDown')).toBe(6);
    });

    it('ArrowDown on the last row stays put', () => {
        expect(nav(6, 'ArrowDown')).toBe(6);
        expect(nav(7, 'ArrowDown')).toBe(7);
    });

    it('full last row: ArrowDown from the last row stays', () => {
        expect(nextGridIndex(7, 'ArrowDown', 9, 3)).toBe(7);
        expect(nextGridIndex(4, 'ArrowDown', 9, 3)).toBe(7);
    });

    it('Home/End/PageUp/PageDown', () => {
        expect(nav(5, 'Home')).toBe(0);
        expect(nav(2, 'End')).toBe(7);
        expect(nextGridIndex(0, 'PageDown', 30, 3)).toBe(9);
        expect(nextGridIndex(20, 'PageUp', 30, 3)).toBe(11);
        expect(nextGridIndex(28, 'PageDown', 30, 3)).toBe(29);
    });

    it('ignores non-navigation keys and empty grids', () => {
        expect(nav(0, 'a')).toBeNull();
        expect(nav(0, 'Enter')).toBeNull();
        expect(nextGridIndex(0, 'ArrowRight', 0, 3)).toBeNull();
    });

    it('clamps an out-of-range current index (list shrank under focus)', () => {
        expect(nextGridIndex(50, 'ArrowLeft', 8, 3)).toBe(6);
    });
});
