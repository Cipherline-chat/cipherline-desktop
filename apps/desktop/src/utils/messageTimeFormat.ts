/**
 * Cached date/time formatters for the chat feed.
 *
 * PERF: `Date#toLocaleTimeString(locales, options)` / `toLocaleDateString`
 * build a brand-new Intl.DateTimeFormat (ICU pattern resolution included) on
 * EVERY call. ChatPane formatted every visible row's timestamp that way on
 * every render — and the pane renders on every keystroke — which profiled as
 * ~1.0 s of the ~1.45 s ChatPane render time while typing 49 characters in a
 * 50-row channel (dev box, 2026-10-03). Formatting through one cached
 * Intl.DateTimeFormat per option set produces the identical string (ECMA-402
 * defines the toLocale* methods as exactly that construction) at a small
 * fraction of the cost.
 */
const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(key: string, options: Intl.DateTimeFormatOptions | undefined): Intl.DateTimeFormat {
    let f = cache.get(key);
    if (!f) {
        // `[]` = the runtime default locale, same as the calls this replaces.
        f = new Intl.DateTimeFormat([], options);
        cache.set(key, f);
    }
    return f;
}

/** = `d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })` */
export function formatHourMinute(d: Date): string {
    return fmt('hm', { hour: '2-digit', minute: '2-digit' }).format(d);
}

/** = `d.toLocaleDateString()` (numeric year/month/day in the default locale) */
export function formatNumericDate(d: Date): string {
    return fmt('ymd', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(d);
}

/** = `d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })` */
export function formatWeekdayShortMonthDay(d: Date): string {
    return fmt('wsd', { weekday: 'long', month: 'short', day: 'numeric' }).format(d);
}

/** = `d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })` */
export function formatWeekdayLongMonthDay(d: Date): string {
    return fmt('wld', { weekday: 'long', month: 'long', day: 'numeric' }).format(d);
}

/** = `d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })` */
export function formatLongMonthDayYear(d: Date): string {
    return fmt('mdy', { month: 'long', day: 'numeric', year: 'numeric' }).format(d);
}
