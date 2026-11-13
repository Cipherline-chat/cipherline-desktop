/**
 * The Firewall leaderboard's plausibility floor, MIRRORED by hand from
 * apps/api/src/games/flappy-rules.ts (flappyRules.test.ts reads that file and
 * fails if the two drift).
 *
 * The client needs it for exactly one thing: a best score that was set BEFORE
 * the leaderboard existed has no recorded run duration, so when it is first
 * synced up it is sent with the shortest duration the server would accept.
 * (The game is open source and the client is trusted for score anyway: the
 * server's check is a sanity limit, not anti-cheat. See the API file.)
 */

export const FLAPPY_MAX_SCORE = 400;
export const FLAPPY_MAX_RUN_MS = 6 * 60 * 60 * 1000;
export const FLAPPY_MIN_RUN_MS = 1000;

const SPACING = 0.95;
const SPEED0 = 0.55;
const SPEED_PER_POINT = 0.012;
const FIRST_PILLAR_U = 1.0;
const SLACK = 0.9;

/** The fastest a run of `score` points can take, in ms (includes the slack). */
export function minRunMs(score: number): number {
    if (!Number.isFinite(score) || score <= 0) return 0;
    let seconds = FIRST_PILLAR_U / SPEED0;
    for (let k = 1; k < score; k++) seconds += SPACING / (SPEED0 + SPEED_PER_POINT * k);
    return Math.max(FLAPPY_MIN_RUN_MS, Math.floor(seconds * 1000 * SLACK));
}

/** A run duration for a score whose real one was never recorded: just over the floor. */
export function legacyRunMs(score: number): number {
    return Math.min(FLAPPY_MAX_RUN_MS, minRunMs(score) + 1000);
}

/** Could the server accept this score at all (range)? */
export const isSubmittableScore = (score: number): boolean =>
    Number.isInteger(score) && score >= 1 && score <= FLAPPY_MAX_SCORE;
