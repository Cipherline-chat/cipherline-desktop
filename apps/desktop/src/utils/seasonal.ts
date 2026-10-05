/**
 * seasonal — date-windowed ambient decoration.
 *
 * Marine snow is a real deep-sea phenomenon: the slow fall of organic detritus
 * from the water above, the only "weather" that reaches the abyss. That's the
 * whole reason it's the seasonal effect here rather than actual snow — it
 * belongs in this app's world year-round, so turning it up for a few weeks
 * reads as the deep doing its thing rather than a Santa hat bolted onto a
 * chat client. It also sidesteps the hemisphere problem: December isn't
 * winter for half the planet, but marine snow isn't winter for anyone.
 *
 * Pure and DOM-free so `seasonal.test.ts` can cover the window maths — every
 * bug here is an off-by-one on a date boundary that would otherwise only show
 * up on one specific day of the year.
 */

export type Season = 'marine-snow';

export interface SeasonWindow {
    season: Season;
    /** 1-12. */
    startMonth: number;
    startDay: number;
    endMonth: number;
    endDay: number;
}

/**
 * Windows may wrap the year end (start month > end month), which this one
 * does: it runs to Twelfth Night so the whole New Year period is covered by
 * one window instead of two abutting ones.
 */
export const SEASON_WINDOWS: readonly SeasonWindow[] = [
    { season: 'marine-snow', startMonth: 12, startDay: 1, endMonth: 1, endDay: 6 },
];

/** Compare (month, day) pairs as a single ordinal — no Date, no timezone. */
function md(month: number, day: number): number {
    return month * 100 + day;
}

function inWindow(w: SeasonWindow, month: number, day: number): boolean {
    const at = md(month, day);
    const from = md(w.startMonth, w.startDay);
    const to = md(w.endMonth, w.endDay);
    // A window that wraps the year end is "on or after the start OR on or
    // before the end"; a normal window is the intersection.
    return from <= to ? (at >= from && at <= to) : (at >= from || at <= to);
}

/**
 * Which season, if any, is active on `now` — evaluated in the user's LOCAL
 * time, deliberately. A seasonal effect should turn on when the calendar on
 * the user's wall says so, not when a server's UTC clock does.
 */
export function activeSeason(now: Date): Season | null {
    const month = now.getMonth() + 1;
    const day = now.getDate();
    return SEASON_WINDOWS.find(w => inWindow(w, month, day))?.season ?? null;
}

// ── the flake field ──────────────────────────────────────────────────────────

export interface FlakeSpec {
    left: string;
    size: number;
    dur: string;
    delay: string;
    drift: string;
    opacity: number;
}

/**
 * How many flakes to draw. Mirrors deepField's bubbleCount tiering but caps
 * lower: this layer can be on screen at the same time as a call, a video, and
 * whatever else is already animating, and a background field that costs frames
 * is exactly the trade this app has already been burned by — 15 animated
 * gradient elements measured ~30fps in the invite page's ray field before they
 * were collapsed into one static gradient.
 */
export function flakeCount(viewportWidth: number): number {
    return Math.min(Math.max(10, Math.round(viewportWidth / 96)), 22);
}

/**
 * Deterministic flake placement — no Math.random, matching deepField, so the
 * field is stable across re-renders and identical between sessions.
 *
 * Delays are NEGATIVE so the field is already mid-fall on the first frame;
 * without that, opening the app in December shows an empty screen that
 * gradually fills, which reads as a loading artifact rather than weather.
 */
export function makeFlakes(n: number): FlakeSpec[] {
    const SIZES   = [2, 3, 2, 4, 2, 3, 5, 2, 3, 2, 4, 3, 2, 3, 2, 4];
    const DURS    = [26, 34, 29, 41, 24, 37, 31, 45, 27, 39, 33, 23, 36, 30, 43, 28];
    const DELAYS  = [0, -12, -25, -7, -33, -18, -3, -28, -9, -21, -15, -37, -5, -30, -11, -23];
    const DRIFTS  = [18, -14, 26, -22, 12, -28, 20, 30, -16, 24, -25, 15, 28, -12, 22, -20];
    const OPACITY = [0.5, 0.32, 0.62, 0.28, 0.45, 0.55, 0.3, 0.48, 0.38, 0.6, 0.34, 0.52, 0.42, 0.29, 0.58, 0.36];
    return Array.from({ length: n }, (_, i) => ({
        left:    `${(3 + (i / n) * 92 + (i % 3 === 1 ? 3 : i % 3 === 2 ? -3 : 0)).toFixed(1)}%`,
        size:    SIZES[i % SIZES.length],
        dur:     `${DURS[i % DURS.length]}s`,
        delay:   `${DELAYS[i % DELAYS.length]}s`,
        drift:   `${DRIFTS[i % DRIFTS.length]}px`,
        opacity: OPACITY[i % OPACITY.length],
    }));
}
