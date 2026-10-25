import { describe, it, expect } from 'vitest';
import { LOADING_TIPS, TIP_MS, pickTipStart, tipAt } from './loadingTips';

describe('LOADING_TIPS', () => {
    it('has about forty lines, all distinct', () => {
        expect(LOADING_TIPS.length).toBeGreaterThanOrEqual(40);
        expect(new Set(LOADING_TIPS).size).toBe(LOADING_TIPS.length);
    });
    it('keeps every line short, finished and plain', () => {
        for (const l of LOADING_TIPS) {
            expect(l.length, l).toBeLessThanOrEqual(90);
            expect(l.length, l).toBeGreaterThan(10);
            expect(l, l).toMatch(/[.?!]$/);
            expect(l, l).toBe(l.trim());
        }
    });
    it('has no nautical puns', () => {
        const forbidden = /\b(ocean|sea|bubble|bubbles|dive|diving|wave|waves|tide|swim|swimming|fish|deep|drown|splash|current|shoal|anchor|sail|fin|fins)\b/i;
        for (const l of LOADING_TIPS) expect(l, l).not.toMatch(forbidden);
    });
    it('never carries a number that could pass for a stat', () => {
        for (const l of LOADING_TIPS) expect(l, l).not.toMatch(/\b\d{2,}\b/);
    });
});

describe('tipAt', () => {
    const L = ['a', 'b', 'c'];
    it('starts at the start index and advances one line per TIP_MS', () => {
        expect(tipAt(0, 1, L)).toBe('b');
        expect(tipAt(TIP_MS - 1, 1, L)).toBe('b');
        expect(tipAt(TIP_MS, 1, L)).toBe('c');
        expect(tipAt(2 * TIP_MS, 1, L)).toBe('a');
        expect(tipAt(5 * TIP_MS + 10, 0, L)).toBe('c');
    });
    it('is safe for odd input', () => {
        expect(tipAt(-5, 0, L)).toBe('a');
        expect(tipAt(0, -1, L)).toBe('c');
        expect(tipAt(0, 0, [])).toBe('');
    });
});

describe('pickTipStart', () => {
    it('stays inside the list', () => {
        expect(pickTipStart(() => 0)).toBe(0);
        expect(pickTipStart(() => 0.999999)).toBe(LOADING_TIPS.length - 1);
        expect(pickTipStart(() => 0, [])).toBe(0);
    });
});
