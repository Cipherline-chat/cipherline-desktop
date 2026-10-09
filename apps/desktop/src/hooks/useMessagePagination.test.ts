import { describe, it, expect } from 'vitest';
import { windowStart, MESSAGE_PAGE_SIZE } from './useMessagePagination';

const rows = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ id: `m${from + i}`, timestamp: 1_000 + (from + i) * 10 }));

describe('useMessagePagination windowStart — anchored by row, not by count', () => {
    it('no anchor: the newest PAGE_SIZE rows', () => {
        expect(windowStart(rows(0, 99), null)).toBe(100 - MESSAGE_PAGE_SIZE);
        expect(windowStart(rows(0, 4), null)).toBe(0);
    });

    it('rows inserted in the MIDDLE of the window keep its first row on screen', () => {
        const before = rows(0, 99);
        const anchor = { id: 'm40', ts: 1_400 };
        expect(before[windowStart(before, anchor)].id).toBe('m40');
        // a gap fill lands 100 rows between m60 and m61
        const filled = [...before.slice(0, 61), ...Array.from({ length: 100 }, (_, i) => ({ id: `g${i}`, timestamp: 1_605 })), ...before.slice(61)];
        expect(filled[windowStart(filled, anchor)].id).toBe('m40');
    });

    it('control: a count-from-the-end window would have dropped 100 rows off its top', () => {
        const before = rows(0, 99);
        const visibleCount = 100 - windowStart(before, { id: 'm40', ts: 1_400 }); // 60
        const filled = [...before.slice(0, 61), ...Array.from({ length: 100 }, (_, i) => ({ id: `g${i}`, timestamp: 1_605 })), ...before.slice(61)];
        expect(filled[filled.length - visibleCount].id).not.toBe('m40');
    });

    it('rows prepended ABOVE the anchor (a background prefetch) stay out of the window', () => {
        const anchor = { id: 'm100', ts: 2_000 };
        const after = [...rows(0, 99), ...rows(100, 199)];
        expect(windowStart(after, anchor)).toBe(100);
    });

    it('a vanished anchor row falls back to the first row at/after its time', () => {
        const rs = rows(0, 99).filter(r => r.id !== 'm40');
        expect(rs[windowStart(rs, { id: 'm40', ts: 1_400 })].id).toBe('m41');
    });

    it('…but never shows fewer than PAGE_SIZE rows', () => {
        const rs = rows(0, 99);
        expect(windowStart(rs, { id: 'gone', ts: 999_999 })).toBe(100 - MESSAGE_PAGE_SIZE);
    });
});
