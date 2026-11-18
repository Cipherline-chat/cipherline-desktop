import { describe, it, expect } from 'vitest';
import { systemRowTime } from './systemRowTime';
import { formatHourMinute, formatNumericDate } from './messageTimeFormat';

const now = new Date(2026, 10, 18, 15, 0, 0);

describe('systemRowTime', () => {
    it('today reads "Today at <time>", like a message header', () => {
        const d = new Date(2026, 10, 18, 9, 5);
        expect(systemRowTime(d.getTime(), now)!.label).toBe(`Today at ${formatHourMinute(d)}`);
    });
    it('yesterday reads "Yesterday at <time>"', () => {
        const d = new Date(2026, 10, 17, 23, 59);
        expect(systemRowTime(d.getTime(), now)!.label).toBe(`Yesterday at ${formatHourMinute(d)}`);
    });
    it('older reads the numeric date and time', () => {
        const d = new Date(2026, 9, 2, 8, 30);
        expect(systemRowTime(d.getTime(), now)!.label).toBe(`${formatNumericDate(d)} ${formatHourMinute(d)}`);
    });
    it('the tooltip carries the full date including the year', () => {
        const d = new Date(2026, 9, 2, 8, 30);
        expect(systemRowTime(d.getTime(), now)!.full).toContain('2026');
    });
    it('a row with no usable time shows nothing', () => {
        expect(systemRowTime(NaN, now)).toBeNull();
    });
});
