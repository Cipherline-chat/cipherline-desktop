/**
 * Pure helpers for the "Bring one friend" step (InviteStep.tsx), split out so
 * they can be unit-tested in vitest's node environment.
 */

/** Referral rewards stop after this many sign-ups: MAX_REFERRAL_REWARDS in apps/api auth.service.ts. */
export const MAX_REFERRAL_REWARDS = 5;

const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five'];

/**
 * `https://cipherline.chat/ref/7C41E9A2` -> `{ prefix: 'cipherline.chat/ref/', code: '7C41E9A2' }`,
 * so the link box can show the host plainly and the code highlighted.
 */
export function splitReferralLink(url: string): { prefix: string; code: string } {
    const shown = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const cut = shown.lastIndexOf('/') + 1;
    return { prefix: shown.slice(0, cut), code: shown.slice(cut) };
}

/**
 * The tally after a friend joins: " One down, four to go." for 1..4 sign-ups,
 * nothing at or past the cap (or when the count is unknown).
 * `n` = sign-ups with the link so far, including the one just seen.
 */
export function joinTally(n: number | null): string {
    if (n === null || !Number.isInteger(n) || n < 1 || n >= MAX_REFERRAL_REWARDS) return '';
    return ` ${WORDS[n]} down, ${WORDS[MAX_REFERRAL_REWARDS - n].toLowerCase()} to go.`;
}

/** Did the sign-up that brought the count to `n` still earn the +7 days? Unknown counts say no. */
export function joinEarnedBonus(n: number | null): boolean {
    return n !== null && Number.isInteger(n) && n >= 1 && n <= MAX_REFERRAL_REWARDS;
}

/** "sam" -> "Sam" (headlines). */
export function capitalize(s: string): string {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}
