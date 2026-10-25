import { describe, it, expect } from 'vitest';
import { formatProDuration, formatProSinceTooltip, parseProSince, proMonthsElapsed } from './proSince';

/** "Now" is pinned to mid-October 2026 so every case is deterministic. */
const NOW = new Date('2026-10-16T12:00:00Z');
const tip = (since: unknown, now = NOW) => formatProSinceTooltip(since, now);

describe('formatProDuration - boundaries', () => {
    it.each([
        [0, 'less than a month'],
        [1, '1 month'],
        [2, '2 months'],
        [11, '11 months'],
        [12, '1 year'],
        [13, '1 year, 1 month'],
        [14, '1 year, 2 months'],
        [23, '1 year, 11 months'],
        [24, '2 years'],
        [25, '2 years, 1 month'],
        [36, '3 years'],
    ])('%i months -> %s', (months, expected) => {
        expect(formatProDuration(months)).toBe(expected);
    });

    it('never says "-1 months" or "NaN": negatives and fractions are clamped', () => {
        expect(formatProDuration(-3)).toBe('less than a month');
        expect(formatProDuration(1.9)).toBe('1 month');
    });
});

describe('proMonthsElapsed', () => {
    it('counts calendar months in UTC', () => {
        expect(proMonthsElapsed({ year: 2026, month: 10 }, NOW)).toBe(0);
        expect(proMonthsElapsed({ year: 2026, month: 9 }, NOW)).toBe(1);
        expect(proMonthsElapsed({ year: 2026, month: 3 }, NOW)).toBe(7);
        expect(proMonthsElapsed({ year: 2025, month: 11 }, NOW)).toBe(11);
        expect(proMonthsElapsed({ year: 2025, month: 10 }, NOW)).toBe(12);
        expect(proMonthsElapsed({ year: 2025, month: 9 }, NOW)).toBe(13);
        expect(proMonthsElapsed({ year: 2024, month: 10 }, NOW)).toBe(24);
    });

    it('crosses a year boundary correctly (Dec -> Jan)', () => {
        const jan = new Date('2027-01-02T00:00:00Z');
        expect(proMonthsElapsed({ year: 2026, month: 12 }, jan)).toBe(1);
        expect(proMonthsElapsed({ year: 2026, month: 1 }, jan)).toBe(12);
    });

    it('uses the UTC month, not the local one, at a month edge', () => {
        // 23:30 UTC on Oct 31 is already Nov 1 in UTC+2; the server cut in UTC.
        expect(proMonthsElapsed({ year: 2026, month: 10 }, new Date('2026-10-31T23:30:00Z'))).toBe(0);
    });

    it('a start in the future (clock skew) is 0, not negative', () => {
        expect(proMonthsElapsed({ year: 2027, month: 6 }, NOW)).toBe(0);
    });
});

describe('formatProSinceTooltip', () => {
    it('the headline case: since March 2026, 7 months', () => {
        expect(tip('2026-03')).toBe('Pro member since March 2026 · 7 months');
    });

    it('same month: "less than a month"', () => {
        expect(tip('2026-10')).toBe('Pro member since October 2026 · less than a month');
    });

    it('1, 11, 12, 13 and 24 months', () => {
        expect(tip('2026-09')).toBe('Pro member since September 2026 · 1 month');
        expect(tip('2025-11')).toBe('Pro member since November 2025 · 11 months');
        expect(tip('2025-10')).toBe('Pro member since October 2025 · 1 year');
        expect(tip('2025-09')).toBe('Pro member since September 2025 · 1 year, 1 month');
        expect(tip('2024-10')).toBe('Pro member since October 2024 · 2 years');
    });

    it('names every month correctly', () => {
        const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        names.forEach((n, i) => {
            const mm = String(i + 1).padStart(2, '0');
            expect(tip(`2026-${mm}`, new Date('2026-12-31T00:00:00Z'))).toContain(`since ${n} 2026`);
        });
    });

    it("is null (no tooltip, today's behaviour) when there is nothing truthful to say", () => {
        for (const bad of [undefined, null, '', 'garbage', '2026-3', '2026-13', '2026-00', '2026-03-17', '2026-03-17T00:00:00Z', 202603, {}, [], true]) {
            expect(tip(bad)).toBeNull();
        }
    });

    it('CONTROL: the null cases are not just "everything is null" - a valid value does produce text', () => {
        expect(tip('2026-03')).not.toBeNull();
        expect(parseProSince('2026-03')).toEqual({ year: 2026, month: 3 });
        expect(parseProSince('2026-3')).toBeNull();
    });

    it('does not reveal anything finer than the month', () => {
        expect(tip('2026-03')).not.toMatch(/\d{1,2}(st|nd|rd|th)|2026-03-/);
    });
});
