/**
 * Pure date-formatting helpers for `DatePicker.tsx`. Kept dependency-free and
 * side-effect-free (no `Date.now()`, no locale APIs) so they're trivially
 * unit-testable and so the SAME calendar math the UI renders is exactly what
 * gets sent to the server — no drift between what the user clicked and what
 * `Date.parse()` (apps/api/src/auth/auth.service.ts:399) sees.
 *
 * The wire format is the ISO date-only string `YYYY-MM-DD` — identical to
 * what the native `<input type="date">` this component replaces already
 * produced, so nothing downstream (the `!dob` required-field check, the
 * `Date.parse(dto.dob)` age gate) needed to change.
 */

export const MONTH_LABELS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export interface IsoDateParts {
    /** Full year, e.g. 1990. */
    y: number;
    /** Zero-indexed month, 0-11 (matches `Date`'s convention). */
    m: number;
    /** Day of month, 1-31. */
    d: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Days in `y`-`m` (0-indexed month), via the "day 0 of next month" trick. */
export function daysInMonth(y: number, m: number): number {
    return new Date(y, m + 1, 0).getDate();
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Strict `YYYY-MM-DD` parse. Rejects anything that isn't exactly that shape
 * AND isn't a real calendar date (e.g. `2024-02-30`, `2024-13-01`) — unlike
 * `new Date('2024-02-30')`, which silently rolls over to March 1st. Returns
 * `null` for empty string, malformed input, or an out-of-range date.
 */
export function parseIsoDate(value: string): IsoDateParts | null {
    const match = ISO_RE.exec(value);
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]) - 1;
    const d = Number(match[3]);
    if (m < 0 || m > 11) return null;
    if (d < 1 || d > daysInMonth(y, m)) return null;
    return { y, m, d };
}

/** `{y,m,d}` -> `"YYYY-MM-DD"`. `m` is 0-indexed in, 1-indexed out. */
export function formatIsoDate(y: number, m: number, d: number): string {
    return `${String(y).padStart(4, '0')}-${pad2(m + 1)}-${pad2(d)}`;
}

/** `{y,m,d}` -> `"September 14, 2026"` — locale-independent by design (a
 *  fixed English label table), so display text is deterministic across
 *  environments/tests rather than riding `toLocaleDateString`'s ICU data. */
export function formatDisplayDate(y: number, m: number, d: number): string {
    return `${MONTH_LABELS[m]} ${d}, ${y}`;
}

/**
 * Decides what a typed date-of-birth string should commit to, for
 * `DatePicker`'s "type OR pick" mode. Kept pure and exported so this exact
 * decision is unit-testable — `DatePicker.tsx` itself can't be, since this
 * app's vitest config runs in a `node` environment with no DOM/testing-
 * library, so anything that needs to actually render is out of reach for a
 * unit test here.
 *
 * This is also what makes "a typed date goes through exactly the same check
 * a picked one does" (CLAUDE.md's COPPA note) true by construction rather
 * than by two hand-kept-in-sync implementations: it calls the SAME
 * `parseIsoDate` the calendar popup's own day cells are built from.
 *
 * Returns:
 *  - `''` if `raw` is empty — an explicit "the date was cleared" commit, not
 *    a partial/invalid state.
 *  - `raw` itself, unchanged, if it parses to a real calendar date (`parseIsoDate`
 *    only accepts the exact `YYYY-MM-DD` shape, so there is nothing to
 *    normalize — what's returned is exactly what was typed).
 *  - `null` if `raw` is non-empty but does not — yet, or ever — parse. The
 *    caller must leave the previously committed value alone in this case: no
 *    throw, no rounding to the nearest valid date, just "not committed yet".
 *    This is the same `null` a still-in-progress keystroke (`"1990-0"`) and a
 *    date that will never be valid (`"2024-02-30"`) both produce — the caller
 *    can't tell those apart and doesn't need to; it only needs to know not to
 *    commit.
 */
export function resolveTypedDate(raw: string): string | null {
    if (raw === '') return '';
    return parseIsoDate(raw) ? raw : null;
}
