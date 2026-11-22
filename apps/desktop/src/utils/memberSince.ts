/**
 * "Member since" in a server: the day a person first joined that community.
 * Today the API sets `member_since` only from a Discord import (the claimant's
 * Discord `joined_at`, a `YYYY-MM-DD` UTC day). Everyone else shows the day
 * they joined the Cipherline server (`joined_at`).
 *
 * `member_since` is display only: unread state never reads it.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` day, or null for anything else (a forged or garbled value is not shown). */
export function parseMemberSinceDay(v: unknown): string | null {
    if (typeof v !== 'string' || !DAY_RE.test(v)) return null;
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

/** The day to show for a member: the imported first-join day, else their Cipherline join day. */
export function memberSinceDayOf(m: { member_since?: unknown; joined_at?: unknown } | null | undefined): { day: string; imported: boolean } | null {
    if (!m) return null;
    const imported = parseMemberSinceDay(m.member_since);
    if (imported) return { day: imported, imported: true };
    if (typeof m.joined_at !== 'string') return null;
    const t = Date.parse(m.joined_at);
    return Number.isFinite(t) ? { day: new Date(t).toISOString().slice(0, 10), imported: false } : null;
}

/** "Mar 3, 2021" (the day as stored, UTC: never shifted a day by the viewer's time zone). */
export function formatMemberSince(day: string): string {
    const d = parseMemberSinceDay(day);
    if (!d) return '';
    return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
