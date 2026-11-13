/**
 * backupKvMerge — the few backed-up settings keys that must be MERGED into
 * this device's copy on restore, not overwritten by it.
 *
 * `applyIncludedKv` writes every included key straight over the local value.
 * That is right for a preference (the user asked for the backup's), and wrong
 * for state that only grows: achievement counters, private notes on people,
 * easter eggs found, the connected-call count. The registry has always
 * described those as "a restore can only add" — but a straight write made
 * restoring an older backup onto a device that already had newer progress
 * (or newer notes) silently roll it back. Each merger here is the same pure
 * merge the own-device sync already uses for that record, so a restore and a
 * sync can never disagree about the result.
 *
 * Keys are matched with the `{uid}` placeholder already resolved by the caller.
 */

import { mergeState, parseState } from '../utils/achievements/state';
import { mergeNotes, sanitizeNotes } from '../utils/profileNotes';

/** (local value or null, value from the vault) → value to write. */
export type KvMerger = (local: string | null, incoming: string) => string;

const parseJson = (raw: string | null): unknown => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
};

const mergeAchievements: KvMerger = (local, incoming) =>
    JSON.stringify(mergeState(parseState(local), parseState(incoming)));

const mergeProfileNotes: KvMerger = (local, incoming) =>
    JSON.stringify(mergeNotes(sanitizeNotes(parseJson(local)), sanitizeNotes(parseJson(incoming))));

/** Easter eggs FOUND: a set that only grows. `synced`/`tier`/`serverCount`
 *  describe what the server last told THIS device, so they stay local (the
 *  next egg sync posts the union and the server answers with the truth). */
const EGG_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const mergeEggProgress: KvMerger = (local, incoming) => {
    const l = parseJson(local) as Record<string, unknown> | null;
    const r = parseJson(incoming) as Record<string, unknown> | null;
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && EGG_ID.test(x)) : []);
    const base = l && typeof l === 'object' && !Array.isArray(l) ? l : {};
    const found = Array.from(new Set([...ids(base.found), ...ids(r?.found)])).slice(0, 64);
    return JSON.stringify({ found, synced: ids(base.synced), tier: base.tier ?? 0, serverCount: base.serverCount ?? 0 });
};

/** A count that only grows: the larger one. */
const maxCount: KvMerger = (local, incoming) => {
    const n = (s: string | null) => { const v = Number(s); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0; };
    return String(Math.max(n(local), n(incoming)));
};

/** Exact key (after `{uid}` substitution) → merger. */
export function kvMergerFor(key: string, userId: string): KvMerger | null {
    switch (key) {
        case `cipherline_achievements_${userId}`: return mergeAchievements;
        case `cipherline_profile_notes_${userId}`: return mergeProfileNotes;
        case `cipherline_egg_progress_${userId}`: return mergeEggProgress;
        case `cipherline_calls_connected_${userId}`: return maxCount;
        default: return null;
    }
}
