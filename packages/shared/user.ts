/**
 * Discord-style user identifier helpers.
 *
 * Every user has a `username` (not unique on its own) plus a 4-digit
 * `discriminator` (0..9999) — together they uniquely identify the account.
 * The canonical rendering is `Username#NNNN` with the numeric half zero-padded
 * to always show 4 digits.
 */

/** Zero-pads a numeric discriminator to a 4-digit string: `7` → `"0007"`. */
export function padDiscriminator(n: number): string {
    if (!Number.isFinite(n)) return '0000';
    const i = Math.max(0, Math.min(9999, Math.floor(n)));
    return i.toString().padStart(4, '0');
}

/** Render a user's full tag, e.g. `formatUserTag("Dawson", 8437)` → `"Dawson#8437"`. */
export function formatUserTag(username: string, discriminator: number | null | undefined): string {
    if (discriminator === null || discriminator === undefined) return username;
    return `${username}#${padDiscriminator(discriminator)}`;
}

/** Parse `Dawson#8437` → `{ username: "Dawson", discriminator: 8437 }`.
 *  Returns `null` on malformed input so callers can surface a clear error. */
export function parseUserTag(input: string): { username: string; discriminator: number } | null {
    const m = /^([A-Za-z0-9_]{3,32})#(\d{4})$/.exec(input.trim());
    if (!m) return null;
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n < 0 || n > 9999) return null;
    return { username: m[1], discriminator: n };
}

/** Validation regex for the username portion alone (no `#`). */
export const USERNAME_REGEX = /^[A-Za-z0-9_]{3,32}$/;
