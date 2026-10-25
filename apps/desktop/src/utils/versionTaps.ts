import { bumpStreak, type Streak } from './eggStreak';
import { KEYS_DEV_POOL, pickRotating } from './eggPools';

/**
 * Egg: tap the app version in Settings → Advanced seven times (like Android's
 * build number) → "Keys developer mode". It is purely cosmetic — a badge —
 * and says so. Pure tap-counting + copy; the row owns the rendering.
 *
 * The version chip already copies the version on click (useful for bug
 * reports), so taps never change that: they only add a quiet note under it.
 */
export const VERSION_TAP_GOAL = 7;
/** Max gap between taps for them to count as one run. */
export const VERSION_TAP_WINDOW_MS = 2000;
/** Taps before the countdown starts being shown. */
export const VERSION_TAP_COUNTDOWN_FROM = 3;
/** Ledger id: fired once = developer mode is on, forever (device-local). */
export const DEV_MODE_EGG = 'dev-mode';

export const DEV_MODE_ON_LINE = 'Developer mode on. It does absolutely nothing.';

export interface VersionTapResult {
    streak: Streak;
    /** A short note to show under the chip, or null. */
    note: string | null;
    /** This tap turned developer mode on. */
    activate: boolean;
}

export function versionTap(prev: Streak | undefined, now: number, devOn: boolean): VersionTapResult {
    const streak = bumpStreak(prev, now, VERSION_TAP_WINDOW_MS);
    if (devOn) {
        // Already a "developer": a fast run earns a rotating shrug, nothing else.
        const note = streak.count >= VERSION_TAP_COUNTDOWN_FROM
            ? pickRotating(KEYS_DEV_POOL, streak.count - VERSION_TAP_COUNTDOWN_FROM)
            : null;
        return { streak, note, activate: false };
    }
    if (streak.count >= VERSION_TAP_GOAL) {
        return { streak: { count: 0, lastAt: now }, note: DEV_MODE_ON_LINE, activate: true };
    }
    if (streak.count >= VERSION_TAP_COUNTDOWN_FROM) {
        const left = VERSION_TAP_GOAL - streak.count;
        return { streak, note: `${left} more tap${left === 1 ? '' : 's'} to go…`, activate: false };
    }
    return { streak, note: null, activate: false };
}
