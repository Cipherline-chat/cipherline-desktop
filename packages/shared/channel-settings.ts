/**
 * Per-channel moderation settings shared by API, desktop and (later) the
 * Discord importer: SLOWMODE and AGE-RESTRICTED.
 *
 * Wire fields (channel create / update bodies, channel list rows):
 *   slowmode_seconds : integer, one of SLOWMODE_OPTIONS_SECONDS (0 = off)
 *   age_restricted   : boolean (false = off)
 *
 * Only text channels honour either setting; for any other kind the API
 * ignores them and answers the off values.
 */

/** Discord's slowmode ladder, in seconds. 0 = off. Order is display order. */
export const SLOWMODE_OPTIONS_SECONDS = [
    0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600,
] as const;

export type SlowmodeSeconds = (typeof SLOWMODE_OPTIONS_SECONDS)[number];

export function isValidSlowmodeSeconds(n: unknown): n is SlowmodeSeconds {
    return typeof n === 'number' && (SLOWMODE_OPTIONS_SECONDS as readonly number[]).includes(n);
}

/**
 * Round an arbitrary number of seconds (e.g. Discord's rate_limit_per_user,
 * which Discord itself restricts to the same ladder) DOWN to the nearest
 * supported step, so an importer can pass it straight through.
 */
export function nearestSlowmodeSeconds(n: number): SlowmodeSeconds {
    if (!Number.isFinite(n) || n <= 0) return 0;
    let best: SlowmodeSeconds = 0;
    for (const o of SLOWMODE_OPTIONS_SECONDS) if (o <= n) best = o;
    return best;
}

/** "Off", "5 seconds", "1 minute", "2 hours". */
export function slowmodeLabel(seconds: number): string {
    if (!seconds || seconds <= 0) return 'Off';
    if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    if (seconds < 3600) { const m = seconds / 60; return `${m} minute${m === 1 ? '' : 's'}`; }
    const h = seconds / 3600;
    return `${h} hour${h === 1 ? '' : 's'}`;
}

/** Compact: "5s", "1m", "2h" (channel header chip). */
export function slowmodeShort(seconds: number): string {
    if (!seconds || seconds <= 0) return 'Off';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${seconds / 60}m`;
    return `${seconds / 3600}h`;
}

/** Error `code` of the 429 a send gets inside a slowmode window. Body:
 *  { statusCode: 429, code, message, retry_after_ms, slowmode_seconds }. */
export const SLOWMODE_ERROR_CODE = 'SLOWMODE_ACTIVE';

/** Error `code` of the 403 a read of an age-restricted channel gets before
 *  the member confirmed they are 18 or older. */
export const AGE_GATE_ERROR_CODE = 'AGE_RESTRICTED_UNCONFIRMED';
