/**
 * Level progress, the pure half of the "open someone's level" view
 * (components/profile/LevelProgress.tsx draws it).
 *
 * The level and its points are the SERVER's (public profile `level` +
 * `level_points`, computed in apps/api/src/auth/profile-extras.ts from the
 * public unlocked-achievement list and one point per found easter egg). The
 * curve and the tier points are MIRRORED here (`levelProgress.test.ts` reads
 * the API file and fails on drift) only to draw the bar and, for an older
 * server that does not send `level_points` yet, to estimate the points from
 * the same public inputs.
 *
 * Nothing here is per-achievement progress ("37 / 100 hours"): those counters
 * live on the owner's device only and are never sent to the server.
 */
import { ACHIEVEMENTS, type AchievementTier } from './achievements/catalog';
import { LEVEL_1_POINTS, MAX_LEVEL, pointsForLevel } from './profileExtras';

export const TIER_POINTS: Readonly<Record<AchievementTier, number>> = { bronze: 1, silver: 3, gold: 6 };
export const EGG_POINT = 1;

/** Mirror of the API's levelForPoints: 0 below LEVEL_1_POINTS, then floor(sqrt(points)), capped. */
export function levelForPoints(points: number): number {
    if (!Number.isFinite(points) || points < LEVEL_1_POINTS) return 0;
    return Math.min(MAX_LEVEL, Math.floor(Math.sqrt(points)));
}

const TIER_OF = new Map(ACHIEVEMENTS.map((a) => [a.id, a.tier]));

/** Points from a set of unlocked achievement ids (unknown ids score nothing) + an egg count. */
export function pointsFrom(unlockedIds: Iterable<string>, eggCount: number): number {
    let p = 0;
    for (const id of new Set(unlockedIds)) {
        const t = TIER_OF.get(id);
        if (t) p += TIER_POINTS[t];
    }
    return p + Math.max(0, Math.floor(Number.isFinite(eggCount) ? eggCount : 0)) * EGG_POINT;
}

const cleanCount = (n: unknown): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;

/**
 * The points to draw for a level, or null when they cannot be known.
 *  - the server's `level_points`, when it sent a sane one (agrees with its level);
 *  - else (older server) an estimate from the public unlocked list + the Egg
 *    hunter badge count, used ONLY when it lands on the same level the server
 *    reported (otherwise the bar would contradict the badge: show no numbers).
 */
export function resolveLevelPoints(input: {
    level: number;
    serverPoints?: unknown;
    unlockedIds?: readonly string[] | null;
    eggCount?: number | null;
}): number | null {
    const server = cleanCount(input.serverPoints);
    if (server !== null && levelForPoints(server) === input.level) return server;
    if (!input.unlockedIds) return null;
    const estimate = pointsFrom(input.unlockedIds, input.eggCount ?? 0);
    return levelForPoints(estimate) === input.level ? estimate : null;
}

export interface LevelProgressModel {
    level: number;
    /** Null = level known, points not (draw the level only). */
    points: number | null;
    max: boolean;
    /** Points needed to REACH the next level; null at the max. */
    nextPoints: number | null;
    /** Points still to go; null at the max or without points. */
    remaining: number | null;
    /** The bar, 0..1: points / nextPoints (matches the "12 of 16" text), 1 at the max. */
    fraction: number;
    /** e.g. "12 of 16 points to level 4", "Max level", or "Level 3 of 10" without points. */
    line: string;
}

export function levelProgress(levelIn: number, points: number | null): LevelProgressModel {
    const level = Math.max(0, Math.min(MAX_LEVEL, Math.floor(Number.isFinite(levelIn) ? levelIn : 0)));
    const max = level >= MAX_LEVEL;
    const nextPoints = max ? null : pointsForLevel(level + 1);
    if (points === null) {
        return {
            level, points: null, max, nextPoints, remaining: null,
            fraction: level / MAX_LEVEL,
            line: max ? 'Max level' : `Level ${level} of ${MAX_LEVEL}`,
        };
    }
    if (max) return { level, points, max, nextPoints: null, remaining: null, fraction: 1, line: `Max level · ${points} points` };
    const shown = Math.min(points, nextPoints! - 1);
    return {
        level, points: shown, max, nextPoints,
        remaining: nextPoints! - shown,
        fraction: Math.max(0, Math.min(1, shown / nextPoints!)),
        line: `${shown} of ${nextPoints} points to level ${level + 1}`,
    };
}

export const pointsLabel = (n: number): string => `${n} point${n === 1 ? '' : 's'}`;
