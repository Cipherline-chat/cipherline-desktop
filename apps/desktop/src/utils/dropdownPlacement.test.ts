/**
 * The picker's resolution / frame-rate list always opened upward; with the
 * settings row near the top of the dialog body the top options were cut off
 * (owner screenshot 2026-11-04: "Source (Native)" half hidden).
 */
import { describe, it, expect } from 'vitest';
import { chooseDropUp } from './dropdownPlacement';

describe('chooseDropUp', () => {
    it('opens up when the whole list fits above (the old behaviour, kept)', () => {
        expect(chooseDropUp(400, 50, 5)).toBe(true);
    });
    it('opens down when the list does not fit above and there is more room below', () => {
        expect(chooseDropUp(60, 450, 5)).toBe(false);
    });
    it('neither fits: takes the larger side', () => {
        expect(chooseDropUp(120, 90, 5)).toBe(true);
        expect(chooseDropUp(90, 120, 5)).toBe(false);
    });
    it('the boundary: exactly enough room above still opens up', () => {
        expect(chooseDropUp(5 * 32 + 12 + 6, 0, 5)).toBe(true);
        expect(chooseDropUp(5 * 32 + 12 + 5, 1000, 5)).toBe(false);
    });
});
