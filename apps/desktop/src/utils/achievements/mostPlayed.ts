/**
 * "Most played this week": per-game play time on THIS device, kept as
 * per-calendar-day buckets and read back as a rolling 7-day top 3.
 *
 * Local-only bookkeeping (never in a backup: it describes this machine's last
 * week). Only if the user opted in does the top 3 {game, minutes} leave the
 * device, and only to PUT /v1/most-played/me. Raw per-day buckets and
 * timestamps are never sent.
 */
import { dayNumber } from './state';

/** day ('YYYY-MM-DD') -> game -> milliseconds */
export type WeeklyBuckets = Record<string, Record<string, number>>;

export interface PlayedGame {
    game: string;
    minutes: number;
}

/** The window shown to friends. */
export const WEEK_DAYS = 7;
/** Buckets older than this are dropped (one more than the window, for the server's 8-day grace). */
export const KEEP_DAYS = 8;
export const MAX_TOP = 3;
const MAX_GAMES_PER_DAY = 50;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function pruneBuckets(b: WeeklyBuckets, today: string): WeeklyBuckets {
    const t = dayNumber(today);
    const out: WeeklyBuckets = {};
    for (const [day, games] of Object.entries(b)) {
        if (DAY_RE.test(day) && dayNumber(day) > t - KEEP_DAYS && dayNumber(day) <= t) out[day] = games;
    }
    return out;
}

export function addPlay(b: WeeklyBuckets, today: string, game: string, dtMs: number): WeeklyBuckets {
    if (!game || game.length > 64 || !(dtMs > 0)) return b;
    const pruned = pruneBuckets(b, today);
    const day = { ...(pruned[today] ?? {}) };
    day[game] = (day[game] ?? 0) + Math.floor(dtMs);
    const keys = Object.keys(day);
    if (keys.length > MAX_GAMES_PER_DAY) {
        const smallest = keys.reduce((m, k) => (day[k] < day[m] ? k : m));
        delete day[smallest];
    }
    return { ...pruned, [today]: day };
}

/** Rolling-week top games (case-insensitive merge, at least one whole minute). */
export function topGames(b: WeeklyBuckets, today: string, n = MAX_TOP): PlayedGame[] {
    const t = dayNumber(today);
    const totals = new Map<string, { name: string; ms: number }>();
    for (const [day, games] of Object.entries(b)) {
        if (!DAY_RE.test(day)) continue;
        const age = t - dayNumber(day);
        if (age < 0 || age >= WEEK_DAYS) continue;
        for (const [name, ms] of Object.entries(games)) {
            const k = name.toLowerCase();
            const prev = totals.get(k);
            totals.set(k, { name: prev?.name ?? name, ms: (prev?.ms ?? 0) + ms });
        }
    }
    return [...totals.values()]
        .map(v => ({ game: v.name, minutes: Math.round(v.ms / 60_000) }))
        .filter(g => g.minutes >= 1)
        .sort((a, b2) => b2.minutes - a.minutes || (a.game.toLowerCase() < b2.game.toLowerCase() ? -1 : 1))
        .slice(0, n);
}

export const sameTop = (a: readonly PlayedGame[], b: readonly PlayedGame[]): boolean =>
    a.length === b.length && a.every((g, i) => g.game === b[i].game && g.minutes === b[i].minutes);

export function parseBuckets(raw: string | null): WeeklyBuckets {
    if (!raw) return {};
    try {
        const v = JSON.parse(raw) as unknown;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
        const out: WeeklyBuckets = {};
        for (const [day, games] of Object.entries(v as Record<string, unknown>)) {
            if (!DAY_RE.test(day) || !games || typeof games !== 'object' || Array.isArray(games)) continue;
            const g: Record<string, number> = {};
            for (const [name, ms] of Object.entries(games as Record<string, unknown>)) {
                if (name && name.length <= 64 && typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms <= 86_400_000) g[name] = Math.floor(ms);
            }
            out[day] = g;
        }
        return out;
    } catch { return {}; }
}
