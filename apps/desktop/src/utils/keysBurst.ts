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

/** The host's answer when the streak completes (HomeKeys says why on a refusal). */
export type PlayVerdict = 'ok' | 'call' | 'unavailable';

/**
 * May the egg open the game right now? HomePanel's canPlay (HomeKeys asks it
 * when a streak completes), here so it is testable on its own.
 *
 * Deliberately NOT gated on prefers-reduced-motion. It used to be, and with
 * Windows' "Animation effects" off (which Electron reports as reduce) the
 * egg could NEVER open: five seconds of spam, a "motion is turned down"
 * bubble, no game, 0 of 25 real-pointer attempts. Reduced motion is about
 * motion nobody asked for; this game opens only after five seconds of
 * deliberate, sustained clicking, its motion IS the thing asked for, and
 * Esc or the close button puts it away. (The loading and offline screens
 * still do not offer it under reduced motion: there nobody asked.)
 */
export function homeGameVerdict(inCall: boolean, canDraw: () => boolean): PlayVerdict {
    if (inCall) return 'call';
    if (!canDraw()) return 'unavailable';
    return 'ok';
}

/** An input timestamp older than this (ms) is not trusted (see inputTime). */
export const MAX_INPUT_LAG_MS = 2000;

/**
 * WHEN a click happened, for the streak rule: the event's own timestamp
 * (`event.timeStamp`, the moment the press reached the browser, on the same
 * clock as performance.now()), not the moment the handler got to run.
 *
 * The two differ whenever the renderer's main thread is busy: clicks queue
 * up and are handled late, and in a burst. Judged by handler time, a person
 * clicking every 500 ms could show a 650 ms "gap" (measured: under a 6x CPU
 * throttle, handler gaps ran up to ~100 ms longer than the input gaps) and
 * the streak broke for something they did not do.
 *
 * Falls back to `now` when the stamp cannot be on that clock: missing, in
 * the future, or implausibly old (a synthetic event, a test DOM whose clock
 * is the epoch).
 */
export function inputTime(timeStamp: number | undefined, now: number): number {
    if (typeof timeStamp !== 'number' || !Number.isFinite(timeStamp)) return now;
    if (timeStamp > now || now - timeStamp > MAX_INPUT_LAG_MS) return now;
    return timeStamp;
}

/** Which of a show's five lines a click at `progress` gets: a new one each second. */
export function lineIndex(progress: number): 0 | 1 | 2 | 3 | 4 {
    return Math.min(4, Math.max(0, Math.floor(progress * 5))) as 0 | 1 | 2 | 3 | 4;
}
