/**
 * Hover timestamp for system rows (member joined / left / kicked / banned, the
 * older plain system lines, and call bars). Owner, 2026-11-18: "hovering mouse
 * over system messages ... you see the date and time that message was sent".
 *
 * `label` matches a normal message header ("Today at 3:42 PM", "Yesterday at
 * …", or "11/14/2026 3:42 PM"); `full` is the long form for the tooltip.
 * Pure and clock-injected so it is testable without a DOM.
 */
import { formatHourMinute, formatNumericDate } from './messageTimeFormat';
import { formatDateTime } from './a11y/timeFormat';

export interface SystemRowTime { label: string; full: string }

function sameDay(a: Date, b: Date): boolean {
    return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
}

export function systemRowTime(ms: number, now: Date = new Date()): SystemRowTime | null {
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const time = formatHourMinute(d);
    const label = sameDay(d, now) ? `Today at ${time}`
        : sameDay(d, yesterday) ? `Yesterday at ${time}`
        : `${formatNumericDate(d)} ${time}`;
    const full = formatDateTime(d, undefined, { dateStyle: 'full', timeStyle: 'short' });
    return { label, full };
}
