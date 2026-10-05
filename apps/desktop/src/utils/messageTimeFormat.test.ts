import { describe, it, expect } from 'vitest';
import {
    formatHourMinute, formatNumericDate, formatWeekdayShortMonthDay,
    formatWeekdayLongMonthDay, formatLongMonthDayYear,
} from './messageTimeFormat';

// The chat feed swapped `toLocale*String(...)` (a new Intl.DateTimeFormat per
// call — ~1 s of a 1.45 s typing profile) for cached formatters. The strings
// on screen must not change: pin them against the calls they replace.
describe('messageTimeFormat matches the toLocale* calls it replaces', () => {
    const dates: Date[] = [];
    for (let i = 0; i < 200; i++) dates.push(new Date(Date.UTC(2020, 0, 1) + i * 37_123_457_000 / 13));
    dates.push(new Date(2026, 9, 3, 0, 0), new Date(2026, 9, 3, 12, 0), new Date(2026, 9, 3, 23, 59));

    it('time of day', () => {
        for (const d of dates) expect(formatHourMinute(d)).toBe(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    });
    it('numeric date', () => {
        for (const d of dates) expect(formatNumericDate(d)).toBe(d.toLocaleDateString());
    });
    it('date-divider labels', () => {
        for (const d of dates) {
            expect(formatWeekdayShortMonthDay(d)).toBe(d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }));
            expect(formatWeekdayLongMonthDay(d)).toBe(d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
            expect(formatLongMonthDayYear(d)).toBe(d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }));
        }
    });
});
