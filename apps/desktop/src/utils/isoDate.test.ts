import { describe, it, expect } from 'vitest';
import { daysInMonth, parseIsoDate, formatIsoDate, formatMdyDate, normalizeDobInput, applyDobEdit, checkTypedDob, resolveTypedDate } from './isoDate';

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

    describe('formatMdyDate', () => {
        it('renders MM/DD/YYYY, zero-padded, from a 0-indexed month', () => {
            expect(formatMdyDate(2003, 8, 2)).toBe('09/02/2003');
            expect(formatMdyDate(1990, 0, 31)).toBe('01/31/1990');
            expect(formatMdyDate(2000, 11, 5)).toBe('12/05/2000');
        });
    });

    describe('normalizeDobInput (the mask)', () => {
        it('masks digit-by-digit, inserting slashes after month and day', () => {
            expect(normalizeDobInput('0')).toBe('0');
            expect(normalizeDobInput('09')).toBe('09/');
            expect(normalizeDobInput('090')).toBe('09/0');
            expect(normalizeDobInput('0902')).toBe('09/02/');
            expect(normalizeDobInput('09022')).toBe('09/02/2');
            expect(normalizeDobInput('09022003')).toBe('09/02/2003');
        });
        it('keeps at most 8 digits', () => {
            expect(normalizeDobInput('0902200399')).toBe('09/02/2003');
            expect(normalizeDobInput('09/02/20031')).toBe('09/02/2003');
        });
        it('drops non-digits that are not separators', () => {
            expect(normalizeDobInput('ab')).toBe('');
            expect(normalizeDobInput('a09')).toBe('09/');
        });
        it('pads a single digit before a typed slash (9/ -> 09/)', () => {
            expect(normalizeDobInput('9/')).toBe('09/');
            expect(normalizeDobInput('09/2/')).toBe('09/02/');
        });
        it('normalises paste variants', () => {
            expect(normalizeDobInput('09/02/2003')).toBe('09/02/2003');
            expect(normalizeDobInput('9/2/2003')).toBe('09/02/2003');
            expect(normalizeDobInput('09-02-2003')).toBe('09/02/2003');
            expect(normalizeDobInput('09.02.2003')).toBe('09/02/2003');
            expect(normalizeDobInput('09022003')).toBe('09/02/2003');
            expect(normalizeDobInput(' 09/02/2003 ')).toBe('09/02/2003');
        });
        it('reads ISO YYYY-MM-DD (4-digit year first) as year-month-day', () => {
            expect(normalizeDobInput('2003-09-02')).toBe('09/02/2003');
            expect(normalizeDobInput('2003-9-2')).toBe('09/02/2003');
        });
        it('negative control: bare 8 digits are MMDDYYYY, never read as YYYYMMDD', () => {
            expect(normalizeDobInput('20030902')).toBe('20/03/0902');
        });
    });

    describe('applyDobEdit (caret + backspace)', () => {
        it('typing at the end keeps the caret at the end', () => {
            expect(applyDobEdit('09', '090')).toEqual({ text: '09/0', caret: 4 });
            expect(applyDobEdit('0', '09')).toEqual({ text: '09/', caret: 3 });
        });
        it('backspace over an auto slash removes the digit before it, instead of sticking', () => {
            // "09/" + Backspace: the browser yields "09" (slash gone).
            expect(applyDobEdit('09/', '09', 2)).toEqual({ text: '0', caret: 1 });
            // "09/02/" + Backspace -> "09/02"
            expect(applyDobEdit('09/02/', '09/02', 5)).toEqual({ text: '09/0', caret: 4 });
        });
        it('negative control: a plain digit deletion does not trigger the slash rule', () => {
            expect(applyDobEdit('09/0', '09/', 3)).toEqual({ text: '09/', caret: 3 });
        });
        it('backspace over a slash in the middle removes the digit before it and keeps the caret there', () => {
            // "09/02/2003", caret after the first slash (3); backspace removes "/".
            const r = applyDobEdit('09/02/2003', '0902/2003', 2);
            expect(r.text).toBe('00/22/003');
            expect(r.caret).toBe(1);
        });
        it('a typed slash after one digit pads it', () => {
            expect(applyDobEdit('9', '9/')).toEqual({ text: '09/', caret: 3 });
        });
        it('an edit in the middle keeps the caret next to the edit', () => {
            // "09/02/2003", insert "5" after the "0" at the start: caret was 2.
            const r = applyDobEdit('09/02/2003', '059/02/2003', 2);
            expect(r.text).toBe('05/90/2200');
            expect(r.caret).toBe(2);
        });
        it('a paste replaces the whole field', () => {
            expect(applyDobEdit('', '2003-09-02')).toEqual({ text: '09/02/2003', caret: 10 });
        });
    });

    describe('checkTypedDob / resolveTypedDate', () => {
        const today = { y: 2026, m: 9, d: 13 }; // 13 Oct 2026

        it('is empty / incomplete while typing', () => {
            expect(checkTypedDob('', today)).toEqual({ status: 'empty' });
            for (const t of ['0', '09', '090', '0902', '09/02/', '09/02/2', '09/02/200']) {
                expect(checkTypedDob(t, today).status).toBe('incomplete');
                expect(resolveTypedDate(t, today)).toBeNull();
            }
        });
        it('commits a complete valid date as ISO', () => {
            expect(checkTypedDob('09/02/2003', today)).toEqual({ status: 'ok', iso: '2003-09-02' });
            expect(resolveTypedDate('09/02/2003', today)).toBe('2003-09-02');
            expect(resolveTypedDate('', today)).toBe('');
        });
        it('accepts a leap day only in a leap year', () => {
            expect(resolveTypedDate('02/29/2024', today)).toBe('2024-02-29');
            expect(resolveTypedDate('02/29/2023', today)).toBeNull();
            expect(checkTypedDob('02/29/2023', today).status).toBe('invalid');
        });
        it('rejects impossible dates instead of rolling over', () => {
            expect(checkTypedDob('02/30/2000', today).status).toBe('invalid');
            expect(checkTypedDob('13/01/2000', today).status).toBe('invalid');
            expect(checkTypedDob('00/10/2000', today).status).toBe('invalid');
            expect(checkTypedDob('04/31/2000', today).status).toBe('invalid');
            expect(checkTypedDob('01/00/2000', today).status).toBe('invalid');
            expect(resolveTypedDate('02/30/2000', today)).toBeNull();
        });
        it('rejects years before 1900 (and honours a custom minYear)', () => {
            expect(checkTypedDob('12/31/1899', today).status).toBe('invalid');
            expect(checkTypedDob('01/01/1900', today).status).toBe('ok');
            expect(checkTypedDob('01/01/1950', today, 1960).status).toBe('invalid');
        });
        it('flags a future date, with today itself still allowed', () => {
            expect(checkTypedDob('10/14/2026', today).status).toBe('future');
            expect(checkTypedDob('11/01/2026', today).status).toBe('future');
            expect(checkTypedDob('01/01/2027', today).status).toBe('future');
            expect(checkTypedDob('10/13/2026', today).status).toBe('ok');
            expect(checkTypedDob('10/12/2026', today).status).toBe('ok');
            expect(resolveTypedDate('10/14/2026', today)).toBeNull();
        });
        it('takes the pasted variants through the same check', () => {
            expect(resolveTypedDate('2003-09-02', today)).toBe('2003-09-02');
            expect(resolveTypedDate('9/2/2003', today)).toBe('2003-09-02');
        });
        it('negative control: the old YYYYMMDD reading (20030902) is NOT accepted', () => {
            // 20/03/0902 -> month 20, invalid.
            expect(checkTypedDob('20030902', today).status).toBe('invalid');
            expect(resolveTypedDate('20030902', today)).toBeNull();
        });
        it('the committed ISO round-trips through parseIsoDate', () => {
            const iso = resolveTypedDate('07/04/2005', today);
            expect(parseIsoDate(iso!)).toEqual({ y: 2005, m: 6, d: 4 });
        });
    });
});
