import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    getTimeFormatPref, setTimeFormatPref, timeFormatRevision, withTimeFormat, formatClock, formatClockShort,
    formatDateTime, parseTimeFormat, hourCycleFor,
} from './timeFormat';
import { formatHourMinute } from '../messageTimeFormat';
import { systemRowTime } from '../systemRowTime';

// 21:05 local time, 2026-11-20 (a fixed local clock so the tests do not depend on the machine's zone).
const EVENING = new Date(2026, 10, 20, 21, 5, 0);
const MIDNIGHT = new Date(2026, 10, 20, 0, 7, 0);

beforeEach(() => { setTimeFormatPref('auto'); });
afterEach(() => { setTimeFormatPref('auto'); });

describe('time format setting', () => {
    it('Automatic changes nothing: the option bag is returned untouched', () => {
        const o = { hour: 'numeric' as const, minute: '2-digit' as const };
        expect(withTimeFormat(o)).toBe(o);
        expect(hourCycleFor('auto')).toBeUndefined();
    });
    it('24-hour writes 21:05 and 00:07 (never "24:07"); 12-hour writes AM/PM', () => {
        setTimeFormatPref('24h');
        expect(formatClock(EVENING, 'en-US')).toBe('21:05');
        expect(formatClock(MIDNIGHT, 'en-US')).toBe('00:07');
        setTimeFormatPref('12h');
        expect(formatClock(EVENING, 'en-US')).toBe('9:05 PM');
        expect(formatClock(MIDNIGHT, 'en-US')).toBe('12:07 AM');
    });
    it('positive control: 12h and 24h really differ, so the assertions above can fail', () => {
        setTimeFormatPref('12h');
        const a = formatClock(EVENING, 'en-US');
        setTimeFormatPref('24h');
        expect(formatClock(EVENING, 'en-US')).not.toBe(a);
    });
    it('date-only formats are left alone', () => {
        setTimeFormatPref('24h');
        const o = { year: 'numeric' as const, month: 'short' as const, day: 'numeric' as const };
        expect(withTimeFormat(o)).toBe(o);
    });
    it('an explicit hour cycle in the call wins (the arithmetic parser must stay h23)', () => {
        setTimeFormatPref('12h');
        const o = { hour: 'numeric' as const, hourCycle: 'h23' as const };
        expect(withTimeFormat(o)).toBe(o);
    });
    it('timeStyle formats follow it too', () => {
        setTimeFormatPref('24h');
        expect(formatDateTime(EVENING, 'en-US', { timeStyle: 'short' })).toBe('21:05');
        setTimeFormatPref('12h');
        expect(formatDateTime(EVENING, 'en-US', { timeStyle: 'short' })).toMatch(/9:05\sPM/);
    });
    it('the compact-gutter time drops AM/PM', () => {
        setTimeFormatPref('12h');
        expect(formatClockShort(EVENING)).toBe('9:05');
        setTimeFormatPref('24h');
        expect(formatClockShort(EVENING)).toBe('21:05');
    });
    it('revision moves only when the preference does (cache keys stay honest)', () => {
        const r = timeFormatRevision();
        setTimeFormatPref('auto');
        expect(timeFormatRevision()).toBe(r);
        setTimeFormatPref('24h');
        expect(timeFormatRevision()).toBe(r + 1);
        expect(getTimeFormatPref()).toBe('24h');
    });
    it('ignores a value that is not one of the three', () => {
        setTimeFormatPref('24h');
        setTimeFormatPref('military' as never);
        expect(getTimeFormatPref()).toBe('24h');
        expect(parseTimeFormat('military')).toBe('auto');
        expect(parseTimeFormat(null)).toBe('auto');
        expect(parseTimeFormat('12h')).toBe('12h');
    });
});

describe('the message and system-row timestamps go through it', () => {
    it('message header time (formatHourMinute) follows the setting', () => {
        setTimeFormatPref('24h');
        expect(formatHourMinute(EVENING)).toMatch(/^21[:.]05$/);
        setTimeFormatPref('12h');
        expect(formatHourMinute(EVENING)).toMatch(/^0?9[:.]05\s?PM$/i);
    });
    it('system-row hover time: label and tooltip both follow it', () => {
        setTimeFormatPref('24h');
        const t = systemRowTime(EVENING.getTime(), EVENING)!;
        expect(t.label).toMatch(/^Today at 21[:.]05$/);
        expect(t.full).toMatch(/21[:.]05/);
        expect(t.full).not.toMatch(/PM/i);
        setTimeFormatPref('12h');
        expect(systemRowTime(EVENING.getTime(), EVENING)!.full).toMatch(/PM/i);
    });
});

/**
 * GUARD: every timestamp must go through utils/a11y/timeFormat. A source file that formats a
 * time of day itself (toLocaleTimeString, timeStyle, hour: 'numeric' | '2-digit') ignores the
 * user's 12/24-hour choice. Add `// time-format-ok: <why>` on the line for a parser that is
 * never shown to a person. Positive controls below prove the scan sees a violation.
 */
const SRC = path.resolve(__dirname, '..', '..');
/** A line that shows an hour: an Intl option bag with `hour` / `timeStyle`, or toLocaleTimeString. */
const SHOWS_TIME = /toLocaleTimeString|timeStyle\s*:|\bhour\s*:\s*['"](?:numeric|2-digit)['"]/;
/** What carries the option bag through the user's setting. */
const SHARED = /\b(?:formatDateTime|formatClock|formatClockShort|withTimeFormat|formatHourMinute|systemRowTime)\(/;
/** Ways to format a time that skip the shared formatter. */
const DIRECT = /toLocaleTimeString|\.toLocaleString\(|new Intl\.DateTimeFormat\(/;
/** `new Date(x).toLocaleString()` with no arguments prints a time too, in any file. */
const BARE_DATE_STRING = /new Date\([^()]*(?:\([^()]*\))?[^()]*\)\.toLocaleString\(\)/;
function* walk(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(p); }
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) yield p;
    }
}
const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
/** Reasons this file's source bypasses the setting (empty = fine). */
function bypasses(text: string): string[] {
    const lines = text.split('\n').filter(l => !isComment(l));
    const bare = lines.filter(l => BARE_DATE_STRING.test(l) && !/time-format-ok/.test(l)).map(l => `prints date and time directly: ${l.trim().slice(0, 100)}`);
    const shows = lines.some(l => SHOWS_TIME.test(l) && !/time-format-ok/.test(l));
    if (!shows) return bare;
    const out: string[] = [...bare];
    if (!lines.some(l => SHARED.test(l))) out.push('shows a time but never calls the shared formatter');
    for (const l of lines) {
        if (DIRECT.test(l) && !/time-format-ok|withTimeFormat\(/.test(l)) out.push(`formats directly: ${l.trim().slice(0, 100)}`);
    }
    return out;
}

describe('guard: no source file formats a clock time outside the shared formatter', () => {
    it('positive controls: the scan flags each way of bypassing the setting, and honours the marker', () => {
        expect(bypasses("const t = d.toLocaleTimeString([], { hour: '2-digit' });").length).toBeGreaterThan(0);
        expect(bypasses("new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d)").length).toBeGreaterThan(0);
        expect(bypasses("d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })").length).toBeGreaterThan(0);
        expect(bypasses("formatDateTime(d, [], { hour: 'numeric' }); x.toLocaleString(undefined, { hour: 'numeric' });").length).toBeGreaterThan(0);
        // ...and passes the shapes the app uses
        expect(bypasses("formatDateTime(d, [], { hour: 'numeric', minute: '2-digit' })")).toEqual([]);
        expect(bypasses("new Intl.DateTimeFormat('en-US', withTimeFormat({ hour: 'numeric' }))")).toEqual([]);
        expect(bypasses("hour: 'numeric', // time-format-ok: parse only")).toEqual([]);
        expect(bypasses("// toLocaleTimeString is banned here")).toEqual([]);
        expect(bypasses("d.toLocaleDateString([], { month: 'short' })")).toEqual([]);
        expect(bypasses('<p>{new Date(e.created_at).toLocaleString()}</p>').length).toBeGreaterThan(0);
        expect(bypasses('<p>{formatFullDateTime(new Date(e.created_at))}</p>')).toEqual([]);
    });
    it('the real tree is clean', () => {
        const bad: string[] = [];
        for (const f of walk(SRC)) {
            if (f.endsWith(path.join('utils', 'a11y', 'timeFormat.ts'))) continue;
            for (const why of bypasses(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(SRC, f)}: ${why}`);
        }
        expect(bad).toEqual([]);
    });
});
