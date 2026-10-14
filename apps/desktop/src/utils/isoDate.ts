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
 *
 * What the user SEES and TYPES in the field is month/day/year (`MM/DD/YYYY`).
 * The typed-text helpers below take "today" as a parameter instead of reading
 * the clock, so they stay deterministic under test.
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

/** `{y,m,d}` -> `"09/02/2003"` (the field's display format). `m` is 0-indexed in. */
export function formatMdyDate(y: number, m: number, d: number): string {
    return `${pad2(m + 1)}/${pad2(d)}/${String(y).padStart(4, '0')}`;
}

/** Longest digit string the field holds: MMDDYYYY. */
export const DOB_MAX_DIGITS = 8;

/**
 * Turns whatever is in the input (typed, pasted, autofilled) into the masked
 * `MM/DD/YYYY` text, keeping at most 8 digits. Slashes are placed
 * automatically: one after the 2nd digit and one after the 4th, so `09` shows
 * as `09/` and `0902` as `09/02/`.
 *
 * Accepted shapes: bare digits (`09022003`), any separator (`/ - . space`),
 * single-digit month/day before a separator (`9/2/2003` -> `09/02/2003`,
 * and a typed `9/` -> `09/`), and ISO `2003-09-02` — unambiguous because it
 * starts with a 4-digit year followed by a separator.
 */
export function normalizeDobInput(raw: string): string {
    raw = raw.replace(/^\D+/, '');
    const iso = /^\s*(\d{4})\D+(\d{1,2})\D+(\d{1,2})\s*$/.exec(raw);
    let digits: string;
    if (iso) {
        digits = iso[2].padStart(2, '0') + iso[3].padStart(2, '0') + iso[1];
    } else {
        const runs = raw.split(/\D+/);
        digits = runs
            .map((run, i) => (i < runs.length - 1 && i < 2 && run.length === 1 ? `0${run}` : run))
            .join('');
    }
    digits = digits.slice(0, DOB_MAX_DIGITS);
    let out = digits.slice(0, 2);
    if (digits.length >= 2) out += '/';
    if (digits.length > 2) out += digits.slice(2, 4);
    if (digits.length >= 4) out += '/';
    if (digits.length > 4) out += digits.slice(4);
    return out;
}

const digitCount = (s: string): number => s.replace(/\D/g, '').length;

/**
 * Applies one edit event from the input to the masked draft, returning the new
 * masked text and where the caret should sit.
 *
 * `prev` is the text before the edit, `raw` what the input holds now, `caret`
 * the caret in `raw`. The only special case beyond re-masking is Backspace over
 * an auto-inserted slash: the browser removes just the `/`, which re-masking
 * would put straight back (the caret would be stuck). That is detected as "raw
 * is prev minus exactly one slash" and treated as deleting the digit before the
 * slash instead.
 */
export function applyDobEdit(prev: string, raw: string, caret: number = raw.length): { text: string; caret: number } {
    let work = raw;
    let at = Math.max(0, Math.min(caret, raw.length));
    if (raw.length === prev.length - 1) {
        let i = 0;
        while (i < raw.length && raw[i] === prev[i]) i++;
        if (i > 0 && prev[i] === '/' && raw === prev.slice(0, i) + prev.slice(i + 1)) {
            work = raw.slice(0, i - 1) + raw.slice(i);
            at = i - 1;
        }
    }
    const text = normalizeDobInput(work);
    if (at >= work.length) return { text, caret: text.length };
    const k = digitCount(normalizeDobInput(work.slice(0, at)));
    const pos = k <= 2 ? k : k <= 4 ? k + 1 : k + 2;
    return { text, caret: Math.min(pos, text.length) };
}

export type DobCheck =
    | { status: 'empty' }
    | { status: 'incomplete' }
    | { status: 'invalid' }
    | { status: 'future' }
    | { status: 'ok'; iso: string };

/**
 * Judges the masked text. `ok` needs 8 digits forming a real calendar date
 * (02/30 and 13/01 are `invalid`; leap years are honoured), a year >= `minYear`,
 * and a date that is not after `today` (`future`). Pure: "today" is injected.
 */
export function checkTypedDob(text: string, today: IsoDateParts, minYear = 1900): DobCheck {
    const norm = normalizeDobInput(text);
    if (norm === '') return { status: 'empty' };
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(norm);
    if (!match) return { status: 'incomplete' };
    const m = Number(match[1]) - 1;
    const d = Number(match[2]);
    const y = Number(match[3]);
    if (y < minYear || m < 0 || m > 11 || d < 1 || d > daysInMonth(y, m)) return { status: 'invalid' };
    if (y > today.y || (y === today.y && (m > today.m || (m === today.m && d > today.d)))) return { status: 'future' };
    return { status: 'ok', iso: formatIsoDate(y, m, d) };
}

/**
 * What a typed `MM/DD/YYYY` string should commit to, for `DatePicker`'s "type
 * OR pick" mode. A typed date goes through the same real-calendar-date check
 * (`daysInMonth`) a picked one is built from, and the committed value is the
 * same ISO string the calendar commits.
 *
 *  - `''` if the text is empty — an explicit "cleared" commit.
 *  - the ISO `YYYY-MM-DD` string if the text is a complete, valid, non-future
 *    date at or after `minYear`.
 *  - `null` otherwise (still being typed, impossible, or in the future). No
 *    throw, no rounding to a nearby date.
 */
export function resolveTypedDate(text: string, today: IsoDateParts, minYear = 1900): string | null {
    const r = checkTypedDob(text, today, minYear);
    if (r.status === 'empty') return '';
    return r.status === 'ok' ? r.iso : null;
}
