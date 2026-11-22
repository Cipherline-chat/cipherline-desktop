/**
 * Time format — Settings → Accessibility → Time format (Automatic / 12-hour /
 * 24-hour). The ONE place a clock time is formatted, so the setting reaches
 * every timestamp: message headers, system-row hover times, "last seen",
 * "clears at", backup times, server mute times, timezone clocks.
 *
 * `auto` is today's behaviour exactly (the system locale decides). The other
 * two add an explicit `hourCycle` to any Intl option bag that shows an hour
 * (`hour` or `timeStyle`); date-only formats are left alone.
 *
 * State is a module variable (set by components/a11y/A11yRuntime from the
 * stored preference) so pure formatters and non-React callers can read it
 * synchronously; `timeFormatRevision()` changes whenever it does, which is
 * what keeps the formatter caches honest and lets a React tree re-render.
 *
 * A guard test (timeFormat.guard.test.ts) fails if any other source file
 * formats a time with toLocaleTimeString / timeStyle / hour: directly.
 */
export type TimeFormatPref = 'auto' | '12h' | '24h';
export const TIME_FORMAT_VALUES: readonly TimeFormatPref[] = ['auto', '12h', '24h'];
export const TIME_FORMAT_CHANGED_EVENT = 'cipherline:time-format-changed';

let current: TimeFormatPref = 'auto';
let revision = 0;

export function getTimeFormatPref(): TimeFormatPref { return current; }
export function timeFormatRevision(): number { return revision; }

export function setTimeFormatPref(p: TimeFormatPref): void {
    if (!TIME_FORMAT_VALUES.includes(p) || p === current) return;
    current = p;
    revision++;
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent(TIME_FORMAT_CHANGED_EVENT));
    }
}

export function hourCycleFor(pref: TimeFormatPref): 'h12' | 'h23' | undefined {
    return pref === '12h' ? 'h12' : pref === '24h' ? 'h23' : undefined;
}

/** Adds the user's hour cycle to an option bag that shows a time of day. */
export function withTimeFormat(options: Intl.DateTimeFormatOptions | undefined): Intl.DateTimeFormatOptions | undefined {
    const hc = hourCycleFor(current);
    if (!hc || !options) return options;
    const showsTime = options.hour !== undefined || options.timeStyle !== undefined;
    if (!showsTime || options.hourCycle !== undefined || options.hour12 !== undefined) return options;
    return { ...options, hourCycle: hc };
}

const cache = new Map<string, Intl.DateTimeFormat>();

/**
 * `new Intl.DateTimeFormat(locales, options).format(d)` with the time format
 * applied and the formatter cached (building one per call is the slow part —
 * see utils/messageTimeFormat.ts).
 */
export function formatDateTime(d: Date | number, locales: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions): string {
    const opts = withTimeFormat(options);
    const key = `${Array.isArray(locales) ? locales.join(',') : String(locales ?? '')}|${current}|${JSON.stringify(opts ?? {})}`;
    let f = cache.get(key);
    if (!f) {
        if (cache.size > 200) cache.clear();
        f = new Intl.DateTimeFormat(locales as string | string[] | undefined, opts);
        cache.set(key, f);
    }
    return f.format(d);
}

/** Time of day only, in the user's format ("9:41 PM" / "21:41"). */
export function formatClock(d: Date | number, locales: Intl.LocalesArgument = undefined, options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }): string {
    return formatDateTime(d, locales, options);
}

/** = `new Date(x).toLocaleString()` (numeric date and time, the system locale) in the user's time format. */
export function formatFullDateTime(d: Date | number): string {
    return formatDateTime(d, undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
}

/** "9:41" (no AM/PM) for tight spots such as the compact-density gutter. */
export function formatClockShort(d: Date | number): string {
    return formatClock(d, []).replace(/\s*[ap]\.?\s?m\.?$/i, '');
}

export function parseTimeFormat(raw: string | null | undefined): TimeFormatPref {
    return (TIME_FORMAT_VALUES as readonly string[]).includes(raw ?? '') ? (raw as TimeFormatPref) : 'auto';
}
