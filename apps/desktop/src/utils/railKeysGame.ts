/**
 * railKeysGame: the right-click streak behind the rail mark's SECOND easter
 * egg: spam-right-click the Keys button in the server rail and the loading
 * screen's Firewall game opens over whatever you are looking at
 * (components/rail/RailKeys.tsx asks; Dashboard opens it through
 * hooks/useFirewallGame.ts, the same one instance Home's Keys uses).
 *
 * THE RULE: RAIL_GAME_CLICKS (6) right-clicks, with no gap longer than
 * RAIL_GAME_GAP_MS (600 ms) between any two. The sixth click fires. One gap
 * over 600 ms ends the streak and that click starts a fresh one (no partial
 * credit, same as Home's).
 *
 * Why these numbers:
 *   - 600 ms is keysBurst's SPAM_GAP_MS verbatim (and `continues()` is
 *     reused, so the boundary is identical): that value was measured against
 *     real humans' stutter and mis-aim, and the right-click path has the same
 *     fingers. Not re-derived.
 *   - 6 clicks instead of Home's "5 seconds of sustained spam". Home's long
 *     streak is the stage for Keys' five-part show; the rail button has no
 *     show to wait for, so it only has to tell a spam from an accident. A
 *     single right-click does nothing visible, and a person who right-clicks
 *     a button out of habit does it once or twice; six in a row, each within
 *     600 ms of the last, is deliberate (about a second at a normal spam, at
 *     most ~3 s at the slowest the rule allows). It is also the same count as
 *     the left-click ladder's second rung, so it reads as the next thing in
 *     the same family.
 *
 * Pure and clock-free (the caller passes `now`; take it from keysBurst's
 * inputTime so a busy main thread cannot stretch a gap).
 */
import { SPAM_GAP_MS, continues, type SpamStreak, type PlayVerdict } from './keysBurst';

/** Right-clicks that open the game. */
export const RAIL_GAME_CLICKS = 6;
/** A gap longer than this (ms) between two right-clicks ends the streak. */
export const RAIL_GAME_GAP_MS = SPAM_GAP_MS;

export interface RailGameResult {
    /** The streak after this click (null once it has fired). */
    streak: SpamStreak | null;
    /** Clicks in the streak including this one (RAIL_GAME_CLICKS when fired). */
    clicks: number;
    /** This click completed the streak: ask the host to open the game. */
    fired: boolean;
}

/** One right-click at `now`. */
export function railGameClick(streak: SpamStreak | null, now: number): RailGameResult {
    const cont = continues(streak, now);
    const clicks = cont ? streak.clicks + 1 : 1;
    if (clicks >= RAIL_GAME_CLICKS) return { streak: null, clicks, fired: true };
    const start = cont ? streak.start : now;
    return { streak: { start, last: now, clicks }, clicks, fired: false };
}

/**
 * The quiet line shown (a toast; the rail has no speech bubble) when the
 * streak completes but the game may not open. Same wording as Home's Keys
 * where he has one: 'unavailable' is HomeKeys' own BURST_LINES.unavailable.
 * For a call Home's Keys answers with the show's playful payoff line, which
 * has no rail equivalent, so this one is plain.
 */
export const RAIL_GAME_REFUSAL = {
    call: 'Keys will play after your call.',
    unavailable: 'I’d play, but this machine can’t draw the game.',
} as const;

export function railGameRefusal(verdict: PlayVerdict): string | null {
    return verdict === 'ok' ? null : RAIL_GAME_REFUSAL[verdict];
}
