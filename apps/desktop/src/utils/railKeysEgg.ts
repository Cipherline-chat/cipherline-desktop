/**
 * railKeysEgg: the click-streak rule behind the rail mark's easter egg
 * (components/rail/RailKeys.tsx). Pure and clock-free: the caller passes `now`.
 *
 * Click the mark at an ordinary pace and it is just the Home button. SPAM it
 * (each click within RAIL_GAP_MS of the last) and the streak climbs a ladder
 * of playful, text-free animations: a wiggle, a hop, a spin, a squash, a jelly
 * swim, and a dizzy-with-sparkles finale. After the finale the egg rests for
 * RAIL_COOLDOWN_MS (clicks still navigate; nothing animates), so a held-down
 * autoclicker can never keep the compositor busy.
 *
 * One move fires per rung, never per click, and the rungs are 3-6 clicks
 * apart: at most one new animation every few clicks regardless of click rate.
 */

/** A gap longer than this (ms) between two clicks ends the streak. */
export const RAIL_GAP_MS = 600;
/** After the finale, the egg sleeps this long (longer than the finale itself). */
export const RAIL_COOLDOWN_MS = 3200;

export type RailMove = 'wiggle' | 'hop' | 'spin' | 'squash' | 'jelly' | 'dizzy';

/** The ladder: the streak's Nth click plays this move. Escalating, ending in the finale. */
export const RAIL_LADDER: ReadonlyArray<{ at: number; move: RailMove }> = [
    { at: 3, move: 'wiggle' },
    { at: 6, move: 'hop' },
    { at: 10, move: 'spin' },
    { at: 14, move: 'squash' },
    { at: 18, move: 'jelly' },
    { at: 24, move: 'dizzy' },
];

export interface RailEggState {
    /** Clicks in the current streak. */
    readonly n: number;
    /** When the latest click landed. */
    readonly last: number;
    /** Until when (same clock) the egg rests after a finale. */
    readonly coolUntil: number;
}

export const RAIL_EGG_START: RailEggState = { n: 0, last: -Infinity, coolUntil: -Infinity };

export interface RailClickResult {
    state: RailEggState;
    /** The move this click earns, if any. */
    move: RailMove | null;
}

/** One click at `now`. */
export function railClick(s: RailEggState, now: number): RailClickResult {
    // Resting after a finale: the click is just a click. The streak stays
    // empty, so the first click after the rest starts a fresh one.
    if (now < s.coolUntil) return { state: { n: 0, last: now, coolUntil: s.coolUntil }, move: null };
    const continued = now >= s.last && now - s.last <= RAIL_GAP_MS;
    const n = continued ? s.n + 1 : 1;
    const move = RAIL_LADDER.find(r => r.at === n)?.move ?? null;
    if (move === 'dizzy') return { state: { n: 0, last: now, coolUntil: now + RAIL_COOLDOWN_MS }, move };
    return { state: { n, last: now, coolUntil: s.coolUntil }, move };
}
