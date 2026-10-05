import { describe, it, expect } from 'vitest';
import { daysInMonth, parseIsoDate, formatIsoDate, formatDisplayDate, resolveTypedDate, MONTH_LABELS } from './isoDate';

describe('isoDate', () => {
    describe('daysInMonth', () => {
        it('knows February in a leap year vs a common year', () => {
            expect(daysInMonth(2024, 1)).toBe(29); // Feb, 0-indexed
            expect(daysInMonth(2023, 1)).toBe(28);
        });
        it('knows 30- vs 31-day months', () => {
            expect(daysInMonth(2025, 3)).toBe(30); // April
            expect(daysInMonth(2025, 0)).toBe(31); // January
        });
    });

    describe('parseIsoDate', () => {
        it('parses a well-formed date', () => {
            expect(parseIsoDate('1990-01-15')).toEqual({ y: 1990, m: 0, d: 15 });
        });
        it('rejects an impossible day-of-month instead of rolling over (unlike new Date())', () => {
            // A naive `new Date('2024-02-30')` silently becomes March 1 — this
            // must NOT do that; it must reject.
            expect(parseIsoDate('2024-02-30')).toBeNull();
        });
        it('rejects an out-of-range month', () => {
            expect(parseIsoDate('2024-13-01')).toBeNull();
            expect(parseIsoDate('2024-00-01')).toBeNull();
        });
        it('rejects empty string and malformed shapes', () => {
            expect(parseIsoDate('')).toBeNull();
            expect(parseIsoDate('1990/01/15')).toBeNull();
            expect(parseIsoDate('01-15-1990')).toBeNull();
            expect(parseIsoDate('not-a-date')).toBeNull();
        });
        it('round-trips through formatIsoDate', () => {
            const parts = parseIsoDate('2005-07-04');
            expect(parts).not.toBeNull();
            expect(formatIsoDate(parts!.y, parts!.m, parts!.d)).toBe('2005-07-04');
        });
    });

    describe('formatIsoDate', () => {
        it('zero-pads single-digit month and day', () => {
            expect(formatIsoDate(1990, 0, 5)).toBe('1990-01-05');
        });
        it('converts 0-indexed month to 1-indexed in the output', () => {
            expect(formatIsoDate(2000, 11, 25)).toBe('2000-12-25');
        });
    });

    describe('formatIsoDate output parses correctly with Date.parse (mirrors apps/api auth.service.ts:399)', () => {
        it('produces a string Date.parse accepts and recovers the same y/m/d from', () => {
            const iso = formatIsoDate(1997, 5, 9); // June 9, 1997
            const parsed = Date.parse(iso);
            expect(Number.isNaN(parsed)).toBe(false);
            const d = new Date(parsed);
            // Server-side age math (auth.service.ts) works entirely in UTC
            // epoch-ms diffs, so the load-bearing property is "parses to a
            // real instant", not any particular local-timezone y/m/d read —
            // this asserts that via the UTC accessors, which for a bare
            // YYYY-MM-DD string per the ISO 8601 spec always land on the
            // intended calendar date regardless of host timezone.
            expect(d.getUTCFullYear()).toBe(1997);
            expect(d.getUTCMonth()).toBe(5);
            expect(d.getUTCDate()).toBe(9);
        });
        it('a date at the exact 13-year-old boundary still parses to a valid instant', () => {
            // Not asserting the age-gate DECISION here (that's the server's
            // job, out of scope/untouched) — only that whatever date the
            // picker can produce is never itself the reason Date.parse fails.
            const thirteenYearsAgo = new Date();
            thirteenYearsAgo.setUTCFullYear(thirteenYearsAgo.getUTCFullYear() - 13);
            const iso = formatIsoDate(thirteenYearsAgo.getUTCFullYear(), thirteenYearsAgo.getUTCMonth(), thirteenYearsAgo.getUTCDate());
            expect(Number.isNaN(Date.parse(iso))).toBe(false);
        });
    });

    describe('resolveTypedDate', () => {
        it('commits an empty string as an explicit clear', () => {
            expect(resolveTypedDate('')).toBe('');
        });
        it('commits a well-formed date exactly as typed', () => {
            expect(resolveTypedDate('1990-01-15')).toBe('1990-01-15');
        });
        it('withholds commit while a keystroke is still in progress, without throwing', () => {
            expect(() => resolveTypedDate('1990')).not.toThrow();
            expect(resolveTypedDate('1990')).toBeNull();
            expect(resolveTypedDate('1990-0')).toBeNull();
            expect(resolveTypedDate('1990-01')).toBeNull();
            expect(resolveTypedDate('1990-01-1')).toBeNull();
        });
        it('withholds commit for an impossible date instead of coercing it — the same check a picked date gets', () => {
            expect(resolveTypedDate('2024-02-30')).toBeNull();
            expect(resolveTypedDate('2024-13-01')).toBeNull();
        });
        it('withholds commit for garbage without throwing or silently coercing', () => {
            expect(() => resolveTypedDate('not a date')).not.toThrow();
            expect(resolveTypedDate('not a date')).toBeNull();
            expect(resolveTypedDate('1990/01/15')).toBeNull();
        });
    });

    describe('formatDisplayDate', () => {
        it('renders a human month name, day, year', () => {
            expect(formatDisplayDate(2026, 8, 14)).toBe('September 14, 2026');
        });
        it('stays in sync with MONTH_LABELS for every month index', () => {
            for (let m = 0; m < 12; m++) {
                expect(formatDisplayDate(2000, m, 1)).toBe(`${MONTH_LABELS[m]} 1, 2000`);
            }
        });
    });
});
