/**
 * eggStreak — counting "did they mash this N times in a row" without each
 * component reinventing it.
 *
 * Generalized out of `call/ControlBar.tsx`'s `useSpamStreak`, which had the
 * only implementation. Three consumers now (ControlBar's mic, ClToggle's knob,
 * ClSelect's chevron), so the extraction earns its keep.
 *
 * Deliberately pure functions rather than a hook: ControlBar tracks several
 * keyed streaks at once, while ClToggle/ClSelect each track exactly one, so a
 * hook would have to serve both shapes. Callers hold their own ref and pass
 * `Date.now()`/`performance.now()` in — which also makes this the only part of
 * the egg machinery that's unit-testable (vitest is node-env; no DOM).
 */

export interface Streak {
    count: number;
    lastAt: number;
}

/**
 * Advance a streak. A gap longer than `windowMs` restarts it at 1 rather than
 * incrementing, so "six flips over five minutes" never trips a 6-in-3s egg.
 */
export function bumpStreak(prev: Streak | undefined, now: number, windowMs: number): Streak {
    const alive = prev !== undefined && (now - prev.lastAt) < windowMs;
    return { count: alive ? prev.count + 1 : 1, lastAt: now };
}

/**
 * True only on the exact hit, never after — an egg fires once when you cross
 * the line, not on every subsequent press while the streak stays alive
 * (rule 6: visual eggs fire once, and rule 10: no chain-restarting).
 */
export function firesAt(s: Streak, threshold: number): boolean {
    return s.count === threshold;
}
