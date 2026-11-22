/**
 * channelMute — timed / indefinite mute of a server channel, a category, a
 * Calls channel or a whole server. Pure functions over plain data (no DOM, no
 * React, no clock of its own) so every rule is testable under vitest's node
 * environment; the React wiring lives in contexts/ChannelMuteContext.tsx.
 *
 * Storage: ONE client-side JSON blob under `cipherline_mutes_<uid>` in
 * secureLocalStore (encrypted at rest, included in encrypted backups via
 * services/backupRegistry.ts). The server never learns which channels a user
 * mutes. Record format (mobile parity; keep it stable):
 *
 *   { "v": 1, "mutes": { "<channel|category|server uuid>": { "until": <epoch ms> | null } } }
 *
 * `until: null` = "until I turn it back on"; a number is the wall-clock
 * instant (ms since the epoch) the mute lapses. Ids are UUIDs so one flat map
 * serves every scope; the scope is resolved by the caller (see
 * isMutedInScope). Expiry is judged against the clock at READ time, so a mute
 * that lapsed while the app was closed is already gone on the next launch.
 *
 * Mention semantics while muted (Discord's): a DIRECT @mention of you still
 * counts and notifies; @everyone/@here, role pings and keyword hits do not.
 * That rule is applied in notificationDecision.decideChannelMessage.
 */

export type MuteDuration = '15m' | '1h' | '8h' | '24h' | 'forever';

export interface MuteRecord { until: number | null }
export type MuteMap = Record<string, MuteRecord>;

export const MUTE_DURATIONS: ReadonlyArray<{ id: MuteDuration; label: string; ms: number | null }> = [
    { id: '15m', label: 'For 15 minutes', ms: 15 * 60_000 },
    { id: '1h', label: 'For 1 hour', ms: 60 * 60_000 },
    { id: '8h', label: 'For 8 hours', ms: 8 * 60 * 60_000 },
    { id: '24h', label: 'For 24 hours', ms: 24 * 60 * 60_000 },
    { id: 'forever', label: 'Until I turn it back on', ms: null },
];

export const mutesStoreKey = (userId: string): string => `cipherline_mutes_${userId}`;

/** A record is live when it has no end, or its end is still ahead of `now`. */
export function isRecordLive(rec: MuteRecord | undefined, now: number): boolean {
    if (!rec) return false;
    return rec.until === null || rec.until > now;
}

export function isMuted(map: MuteMap, id: string | null | undefined, now: number): boolean {
    return !!id && isRecordLive(map[id], now);
}

/** Muted if ANY id in the scope chain (channel, its categories, its server) is. */
export function isMutedInScope(map: MuteMap, scopeIds: ReadonlyArray<string | null | undefined>, now: number): boolean {
    return scopeIds.some(id => isMuted(map, id, now));
}

export function muteFor(map: MuteMap, id: string, duration: MuteDuration, now: number): MuteMap {
    const d = MUTE_DURATIONS.find(x => x.id === duration);
    if (!d) return map;
    return { ...map, [id]: { until: d.ms === null ? null : now + d.ms } };
}

export function unmute(map: MuteMap, id: string): MuteMap {
    if (!(id in map)) return map;
    const next = { ...map };
    delete next[id];
    return next;
}

/** Drop lapsed records. Returns the SAME object when nothing lapsed, so a React
 *  setter bails out instead of re-rendering (and nothing is written). */
export function pruneExpired(map: MuteMap, now: number): MuteMap {
    let next: MuteMap | null = null;
    for (const [id, rec] of Object.entries(map)) {
        if (!isRecordLive(rec, now)) {
            if (!next) next = { ...map };
            delete next[id];
        }
    }
    return next ?? map;
}

/** The soonest future lapse, or null if nothing is timed. Drives the one timer. */
export function nextExpiry(map: MuteMap, now: number): number | null {
    let best: number | null = null;
    for (const rec of Object.values(map)) {
        if (rec.until !== null && rec.until > now && (best === null || rec.until < best)) best = rec.until;
    }
    return best;
}

/** Parse the stored blob defensively: anything malformed or already lapsed is
 *  dropped, never coerced. Empty on garbage. */
export function parseMuteMap(raw: string | null | undefined, now: number): MuteMap {
    if (!raw) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return {}; }
    const mutes = (parsed as { v?: unknown; mutes?: unknown } | null)?.mutes;
    if (!mutes || typeof mutes !== 'object' || Array.isArray(mutes)) return {};
    const out: MuteMap = {};
    for (const [id, rec] of Object.entries(mutes as Record<string, unknown>)) {
        const until = (rec as { until?: unknown } | null)?.until;
        if (until === null) out[id] = { until: null };
        else if (typeof until === 'number' && Number.isFinite(until) && until > now) out[id] = { until };
    }
    return out;
}

export function serializeMuteMap(map: MuteMap): string {
    return JSON.stringify({ v: 1, mutes: map });
}

/** "Muted until 3:40 PM" / "Muted until you turn it back on". `formatClock` is
 *  injected (the shared a11y time formatter honouring the 12/24 h setting). A
 *  mute ending on a later calendar day names the day via `formatDay`. */
export function mutedHint(
    rec: MuteRecord | undefined,
    now: number,
    formatClock: (ms: number) => string,
    formatDay: (ms: number) => string = () => '',
): string | null {
    if (!rec || !isRecordLive(rec, now)) return null;
    if (rec.until === null) return 'Muted until you turn it back on';
    const same = new Date(rec.until).toDateString() === new Date(now).toDateString();
    return same
        ? `Muted until ${formatClock(rec.until)}`
        : `Muted until ${formatDay(rec.until)} ${formatClock(rec.until)}`;
}

export interface ScopeData {
    /** channel_id → its category_id (null/undefined = top level). */
    categoryOfChannel: (channelId: string) => string | null | undefined;
    /** category_id → parent category_id (sub-categories nest one level). */
    parentOfCategory: (categoryId: string) => string | null | undefined;
    /** channel_id → server_id. */
    serverOfChannel: (channelId: string) => string | undefined;
}

/** [channel, category, parent category, server] — the ids whose mute covers a channel. */
export function channelScopeIds(channelId: string, d: ScopeData): string[] {
    const ids = [channelId];
    const cat = d.categoryOfChannel(channelId);
    if (cat) {
        ids.push(cat);
        const parent = d.parentOfCategory(cat);
        if (parent) ids.push(parent);
    }
    const srv = d.serverOfChannel(channelId);
    if (srv) ids.push(srv);
    return ids;
}

/** Every channel id currently muted by itself, its category chain or its server. */
export function effectiveMutedChannels(
    map: MuteMap,
    channelIds: Iterable<string>,
    d: ScopeData,
    now: number,
): Set<string> {
    const out = new Set<string>();
    if (Object.keys(map).length === 0) return out;
    for (const id of channelIds) {
        if (isMutedInScope(map, channelScopeIds(id, d), now)) out.add(id);
    }
    return out;
}

/** Counts with muted channels' PLAIN unread removed (mentions are a separate
 *  map and are never touched here). Used for category / server / rail totals. */
export function withoutMuted(counts: Record<string, number>, muted: ReadonlySet<string>): Record<string, number> {
    if (muted.size === 0) return counts;
    let next: Record<string, number> | null = null;
    for (const id of Object.keys(counts)) {
        if (muted.has(id)) { if (!next) next = { ...counts }; delete next[id]; }
    }
    return next ?? counts;
}
