/**
 * keysBurst: the spam detector behind the Home mascot's easter egg.
 *
 * Poke Keys at a normal pace and he runs his usual ladder (keysBrain.ts).
 * SPAM him, and keep it up, and he puts on a show that builds the longer the
 * streak lasts (one of five, utils/keysSpam.ts), until at SPAM_DURATION_MS
 * he gives in and the loading screen's Firewall game opens over Home.
 *
 * THE RULE: a streak is a run of clicks with no gap longer than SPAM_GAP_MS
 * between any two. It starts at its first click; the game fires on the click
 * that lands SPAM_DURATION_MS or more after the streak began. One gap longer
 * than SPAM_GAP_MS ends it (no partial credit), and he settles back down.
 *
 * Why 600 ms: the first version said 400 ms and, measured with a real
 * pointer in Chromium at a human cadence (a click every 100-400 ms, about
 * four a second), 14 of 16 attempts never opened the game: one 420-470 ms
 * gap, or one click that missed him while he ducked or skewed, threw away
 * the whole streak ("no partial credit"). People spam at 3-8 clicks a second
 * and tire, stutter and mis-aim; 600 ms rides through all of that, while a
 * poke-and-look or a double-click followed by a pause (a second or more)
 * still never builds a streak worth anything. Five seconds of sustained
 * spam is a deliberate act: a curious person finds it, nobody trips it by
 * accident.
 *
 * Escalation is CONTINUOUS: the shows are functions of
 * progress = elapsed / SPAM_DURATION_MS in [0, 1], not of a click count.
 *
 * Pure and clock-free (the caller passes `now`), so the tests can pin every
 * boundary without timers.
 */

/** A gap longer than this (ms) between two clicks ends the streak. */
export const SPAM_GAP_MS = 600;
/** How long (ms) the spam has to be kept up for the game to open. */
export const SPAM_DURATION_MS = 5000;
/** A streak that gets this far (0.5 s) has used up its show: the next streak
 *  gets the next one. Shorter ones (a double-click) leave the rotation alone. */
export const SPAM_COUNTS_AT = 0.1;

export interface SpamStreak {
    /** When the streak's first click landed. */
    readonly start: number;
    /** When its latest click landed. */
    readonly last: number;
    /** Clicks in the streak so far. */
    readonly clicks: number;
}

export interface ClickResult {
    /** The streak after this click (null once it has fired). */
    streak: SpamStreak | null;
    /** 0..1: how far into the 5 s this click is. */
    progress: number;
    /** Whether this click continued a streak (false = it started a new one). */
    continued: boolean;
    /** This click completed the 5 s: open the game. */
    fired: boolean;
}

/** Does a click at `now` still belong to `streak`? */
export function continues(streak: SpamStreak | null, now: number): streak is SpamStreak {
    return !!streak && now >= streak.last && now - streak.last <= SPAM_GAP_MS;
}

/** One click at `now`. */
export function registerClick(streak: SpamStreak | null, now: number): ClickResult {
    if (!continues(streak, now)) {
        return { streak: { start: now, last: now, clicks: 1 }, progress: 0, continued: false, fired: false };
    }
    const elapsed = now - streak.start;
    if (elapsed >= SPAM_DURATION_MS) {
        return { streak: null, progress: 1, continued: true, fired: true };
    }
    return {
        streak: { start: streak.start, last: now, clicks: streak.clicks + 1 },
        progress: elapsed / SPAM_DURATION_MS,
        continued: true,
        fired: false,
    };
}

/** The streak is over (nothing for longer than the gap) as of `now`? */
export function isBroken(streak: SpamStreak | null, now: number): boolean {
    return !!streak && now - streak.last > SPAM_GAP_MS;
}

/** How far the streak got: progress at its latest click. */
export function reached(streak: SpamStreak | null): number {
    if (!streak) return 0;
    return Math.min(1, Math.max(0, (streak.last - streak.start) / SPAM_DURATION_MS));
}

/** Which of a show's five lines a click at `progress` gets: a new one each second. */
export function lineIndex(progress: number): 0 | 1 | 2 | 3 | 4 {
    return Math.min(4, Math.max(0, Math.floor(progress * 5))) as 0 | 1 | 2 | 3 | 4;
}
