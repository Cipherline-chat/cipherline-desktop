/**
 * "Pro member since March 2026 · 7 months" - the hover/focus tip on the Pro
 * badge.
 *
 * The server sends `pro_since` as "YYYY-MM" (UTC, month precision only - the
 * day is deliberately never revealed). Pure and dependency-free so the website
 * build (which pulls `components/` through the `@app-cl` alias) and the test
 * suite can both use it.
 */

const PRO_SINCE_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Parse the wire value. Anything that is not exactly "YYYY-MM" is null. */
export function parseProSince(value: unknown): { year: number; month: number } | null {
    if (typeof value !== 'string') return null;
    const m = PRO_SINCE_RE.exec(value);
    if (!m) return null;
    return { year: Number(m[1]), month: Number(m[2]) };
}

/**
 * Whole calendar months from the start month to `now`'s month (UTC, matching
 * how the server cut the value). Never negative: a start "in the future"
 * (clock skew) reads as 0.
 */
export function proMonthsElapsed(since: { year: number; month: number }, now: Date): number {
    const months = (now.getUTCFullYear() - since.year) * 12 + (now.getUTCMonth() + 1 - since.month);
    return Math.max(0, months);
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "less than a month" / "1 month" / "11 months" / "1 year" / "1 year, 2 months" / "2 years". */
export function formatProDuration(months: number): string {
    const m = Math.max(0, Math.floor(months));
    if (m < 1) return 'less than a month';
    if (m < 12) return plural(m, 'month');
    const years = Math.floor(m / 12);
    const rest = m % 12;
    return rest === 0 ? plural(years, 'year') : `${plural(years, 'year')}, ${plural(rest, 'month')}`;
}

/**
 * The tooltip text, or null when there is nothing truthful to say (an older
 * server that omits `pro_since`, a null for a comped account, a malformed
 * value) - the caller then renders the badge exactly as it always did.
 */
export function formatProSinceTooltip(proSince: unknown, now: Date = new Date()): string | null {
    const since = parseProSince(proSince);
    if (!since) return null;
    const label = `${MONTH_NAMES[since.month - 1]} ${since.year}`;
    return `Pro member since ${label} · ${formatProDuration(proMonthsElapsed(since, now))}`;
}
