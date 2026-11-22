/**
 * muteSync - the pure part of own-device sync for notification mutes (channels,
 * categories, sub-categories, servers, DMs and group chats). No React, IPC, DOM
 * or storage: unit-testable, and mirrored function-for-function by the phones
 * (cipherline-native core/cl-sync/src/timed_mute.rs, docs/specs/mute-sync.md).
 *
 * ONE record for every mute, stored under `cipherline_mutes_<uid>` (the same
 * key as the v1 blob, so backups carry it unchanged) and synced through the
 * `mutes` own-device slot (client-encrypted; the server only ever learns that
 * the slot changed). Format v2 is a superset of v1:
 *
 *   { "v": 2,
 *     "mutes": { "<uuid>": { "until": <epoch ms> | null, "at": <epoch ms> } },
 *     "gone":  { "<uuid>": <epoch ms> } }
 *
 *   - `mutes` keeps the v1 shape (`until`), so a client that only knows v1
 *     still reads every live mute out of a v2 blob and ignores `at`/`gone`.
 *   - `at` is the entry's modification stamp; `gone` holds TOMBSTONES (an
 *     unmute, or a mute that lapsed) keyed by the stamp of the change.
 *   - A v1 entry has no stamp: it reads as `at = 0` ("legacy"), so any stamped
 *     change from any device beats it, and two legacy entries fall back to the
 *     v1 rule (later end wins, never-ending beats timed).
 *
 * Merge is per id, last-writer-wins by stamp. Tie-break (equal stamps), in
 * order: a live mute beats a tombstone; a never-ending mute beats a timed one;
 * the later `until` wins. Deterministic and symmetric, so both devices
 * converge whichever merges first.
 *
 * Expiry is judged against the clock at READ time (`until > now`), never by a
 * timer on the record; a lapsed entry is turned into a tombstone with the SAME
 * stamp (`pruneMuteState`) instead of being dropped, so an older, longer copy
 * of that mute still sitting on a device that was offline cannot come back.
 * Tombstones older than 30 days are dropped (a device offline for longer than
 * that can resurrect a never-ending mute it still holds); entries are bounded.
 */
import { isSafeSyncId } from './ownSlotSync';
import { MUTE_DURATIONS, type MuteDuration, type MuteMap } from './channelMute';

export const MUTES_SLOT = 'mutes';
export const MUTES_MAGIC = 'CLMUT1';
export const MUTES_PAYLOAD_VERSION = 2;
export const MAX_MUTES_PAYLOAD_BYTES = 256 * 1024;
export const MUTE_ENTRY_MAX = 2000;
export const MUTE_TOMBSTONE_MAX = 2000;
export const MUTE_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MUTE_ID_MAX = 64;
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export interface StampedMute { until: number | null; at: number }
export interface MuteState {
    mutes: Record<string, StampedMute>;
    gone: Record<string, number>;
}

/** The sync view this device last saw (device-local, never backed up). */
export const muteViewKey = (uid: string) => `cipherline_mutes_sync_view_${uid}`;

/** Fired (window) after another device's mutes were adopted: the context re-reads the store. */
export const MUTES_CHANGED_EVENT = 'cipherline:mutes-changed';
/** Fired (window, detail {userId}) after a USER edit of a mute: the sync hook publishes. */
export const MUTES_USER_EDIT_EVENT = 'cipherline:mutes-user-edit';
/** Fired (window, detail {slot, updated_at}) when the server says an own-device slot changed elsewhere. */
export const OWN_SLOT_CHANGED_EVENT = 'cipherline:own-slot-changed';

export const emptyMuteState = (): MuteState => ({ mutes: {}, gone: {} });
export const isEmptyMuteState = (s: MuteState): boolean => Object.keys(s.mutes).length === 0 && Object.keys(s.gone).length === 0;

const isTime = (v: unknown, now: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= now + MAX_FUTURE_SKEW_MS;
const safeId = (id: unknown): id is string => isSafeSyncId(id) && (id as string).length <= MUTE_ID_MAX;

/** Is this entry still muting at `now`? */
export const isStampedLive = (m: StampedMute | undefined, now: number): boolean =>
    !!m && (m.until === null || m.until > now);

/** The tie-break rank of an entry: a never-ending mute outranks any end. */
const untilRank = (u: number | null): number => (u === null ? Number.POSITIVE_INFINITY : u);

/** Which of two competing records for one id wins. `null` tombstone = no live mute. */
interface Rec { at: number; mute: StampedMute | null }
function winner(a: Rec, b: Rec): Rec {
    if (a.at !== b.at) return a.at > b.at ? a : b;
    if (!!a.mute !== !!b.mute) return a.mute ? a : b;           // mute beats tombstone
    if (!a.mute || !b.mute) return a;                            // two tombstones, same stamp
    const ra = untilRank(a.mute.until), rb = untilRank(b.mute.until);
    return ra >= rb ? a : b;
}

function recOf(s: MuteState, id: string): Rec | null {
    const m = s.mutes[id];
    if (m) return { at: m.at, mute: m };
    const g = s.gone[id];
    if (g !== undefined) return { at: g, mute: null };
    return null;
}

/** Per-id LWW merge. Pure; the result is pruned against `now`. */
export function mergeMuteStates(a: MuteState, b: MuteState, now: number): MuteState {
    const out = emptyMuteState();
    const ids = new Set<string>([...Object.keys(a.mutes), ...Object.keys(a.gone), ...Object.keys(b.mutes), ...Object.keys(b.gone)]);
    for (const id of ids) {
        const ra = recOf(a, id), rb = recOf(b, id);
        const w = ra && rb ? winner(ra, rb) : (ra ?? rb)!;
        if (w.mute) out.mutes[id] = { until: w.mute.until, at: w.at };
        else out.gone[id] = w.at;
    }
    return pruneMuteState(out, now);
}

/**
 * Lapsed entries become tombstones (same stamp); old tombstones and any excess
 * are dropped (oldest first). Returns the SAME object when nothing changed so a
 * React setter bails out and nothing is rewritten.
 */
export function pruneMuteState(s: MuteState, now: number): MuteState {
    let mutes = s.mutes, gone = s.gone, changed = false;
    for (const [id, m] of Object.entries(s.mutes)) {
        if (!isStampedLive(m, now)) {
            if (!changed) { mutes = { ...s.mutes }; gone = { ...s.gone }; changed = true; }
            delete mutes[id];
            gone[id] = Math.max(gone[id] ?? 0, m.at);
        }
    }
    for (const [id, at] of Object.entries(gone)) {
        if (now - at > MUTE_TOMBSTONE_TTL_MS) {
            if (!changed) { mutes = { ...s.mutes }; gone = { ...s.gone }; changed = true; }
            delete gone[id];
        }
    }
    const capped = <T,>(o: Record<string, T>, max: number, at: (v: T) => number): Record<string, T> => {
        const keys = Object.keys(o);
        if (keys.length <= max) return o;
        changed = true;
        return Object.fromEntries(keys.sort((x, y) => at(o[y]) - at(o[x])).slice(0, max).map(k => [k, o[k]]));
    };
    mutes = capped(mutes, MUTE_ENTRY_MAX, v => v.at);
    gone = capped(gone, MUTE_TOMBSTONE_MAX, v => v);
    return changed ? { mutes, gone } : s;
}

/** A stamp for a local change to `id`: now, but always newer than what this device already holds for it. */
function nextStamp(s: MuteState, id: string, now: number): number {
    const prev = Math.max(s.mutes[id]?.at ?? 0, s.gone[id] ?? 0);
    return Math.max(now, prev + 1);
}

export function muteStateFor(s: MuteState, id: string, duration: MuteDuration, now: number): MuteState {
    const d = MUTE_DURATIONS.find(x => x.id === duration);
    if (!d || !safeId(id)) return s;
    const at = nextStamp(s, id, now);
    const gone = { ...s.gone }; delete gone[id];
    return { mutes: { ...s.mutes, [id]: { until: d.ms === null ? null : now + d.ms, at } }, gone };
}

/** An unmute is a tombstone, so it propagates. Unmuting what is not muted changes nothing. */
export function unmuteState(s: MuteState, id: string, now: number): MuteState {
    if (!(id in s.mutes)) return s;
    const at = nextStamp(s, id, now);
    const mutes = { ...s.mutes }; delete mutes[id];
    return { mutes, gone: { ...s.gone, [id]: at } };
}

/** The live mutes as the plain `{id:{until}}` map every decision rule already reads. */
export function liveMuteMap(s: MuteState, now: number): MuteMap {
    const out: MuteMap = {};
    for (const [id, m] of Object.entries(s.mutes)) if (isStampedLive(m, now)) out[id] = { until: m.until };
    return out;
}

/** Do two states say the same thing (same winners, same stamps)? */
export function sameMuteState(a: MuteState, b: MuteState): boolean {
    const ka = Object.keys(a.mutes), kb = Object.keys(b.mutes);
    if (ka.length !== kb.length || Object.keys(a.gone).length !== Object.keys(b.gone).length) return false;
    for (const id of ka) { const x = a.mutes[id], y = b.mutes[id]; if (!y || x.until !== y.until || x.at !== y.at) return false; }
    for (const [id, at] of Object.entries(a.gone)) if (b.gone[id] !== at) return false;
    return true;
}

// ── Storage / wire format ───────────────────────────────────────────────────

/**
 * Parse a stored blob or a downloaded payload, v1 or v2. Untrusted: anything
 * malformed is dropped (never coerced), a lapsed v1 entry (no stamp to keep) is
 * dropped, a lapsed v2 entry becomes a tombstone. Throws only for an oversize
 * payload or a version newer than this build understands (`strict`).
 */
export function parseMuteState(raw: string | null | undefined, now: number, strict = false): MuteState {
    if (!raw) return emptyMuteState();
    if (strict && raw.length > MAX_MUTES_PAYLOAD_BYTES) throw new Error('mutes payload too large');
    let o: { v?: unknown; mutes?: unknown; gone?: unknown } | null;
    try { o = JSON.parse(raw); } catch { if (strict) throw new Error('mutes payload is not JSON'); return emptyMuteState(); }
    if (!o || typeof o !== 'object') return emptyMuteState();
    if (strict && typeof o.v === 'number' && o.v > MUTES_PAYLOAD_VERSION) throw new Error(`mutes payload v${o.v} is newer than this build`);
    const out = emptyMuteState();
    if (o.mutes && typeof o.mutes === 'object' && !Array.isArray(o.mutes)) {
        for (const [id, rec] of Object.entries(o.mutes as Record<string, unknown>)) {
            if (!safeId(id)) continue;
            const until = (rec as { until?: unknown } | null)?.until;
            const atRaw = (rec as { at?: unknown } | null)?.at;
            const at = atRaw === undefined ? 0 : isTime(atRaw, now) ? atRaw : null;
            if (at === null) continue;
            if (until === null) out.mutes[id] = { until: null, at };
            else if (typeof until === 'number' && Number.isFinite(until) && until >= 0) {
                if (until > now) out.mutes[id] = { until, at };
                else if (at > 0) out.gone[id] = Math.max(out.gone[id] ?? 0, at);   // lapsed: keep as tombstone
            }
        }
    }
    if (o.gone && typeof o.gone === 'object' && !Array.isArray(o.gone)) {
        for (const [id, at] of Object.entries(o.gone as Record<string, unknown>)) {
            if (!safeId(id) || !isTime(at, now)) continue;
            out.gone[id] = Math.max(out.gone[id] ?? 0, at);
        }
    }
    // An id cannot be both: the newer record decides (equal: the mute, as in the merge).
    for (const id of Object.keys(out.mutes)) {
        if (id in out.gone) {
            if (out.gone[id] > out.mutes[id].at) delete out.mutes[id]; else delete out.gone[id];
        }
    }
    return pruneMuteState(out, now);
}

/** Canonical form: ids sorted, so equal states are byte-identical on every client (and the Rust encoder agrees). */
export function serializeMuteState(s: MuteState): string {
    const sorted = <T,>(o: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
    const mutes = sorted(Object.fromEntries(Object.entries(s.mutes).map(([k, m]) => [k, { until: m.until, at: m.at }])));
    return JSON.stringify({ v: MUTES_PAYLOAD_VERSION, mutes, gone: sorted(s.gone) });
}

/** The snapshot body published to the slot (same format as the stored blob). */
export function buildMutesPayload(s: MuteState, now: number): string {
    return serializeMuteState(pruneMuteState(s, now));
}
export function parseMutesPayload(raw: string, now: number): MuteState {
    return parseMuteState(raw, now, true);
}

/**
 * One-time migration of the legacy per-conversation "Mute" (notif prefs mode
 * 'none', permanent, never synced) into the shared record. Each becomes a
 * stamped `until: null` entry unless the record already has something for the
 * id. Returns the new state and the prefs with those entries reset to 'all'
 * (the mute now carries the meaning), or null when there was nothing to do.
 */
export function migrateLegacyConvMutes(
    prefs: Record<string, 'all' | 'mentions' | 'none'>, s: MuteState, now: number,
): { state: MuteState; prefs: Record<string, 'all' | 'mentions' | 'none'> } | null {
    const legacy = Object.entries(prefs).filter(([id, m]) => m === 'none' && safeId(id));
    if (legacy.length === 0) return null;
    let state = s;
    const nextPrefs = { ...prefs };
    for (const [id] of legacy) {
        if (!(id in state.mutes) && !(id in state.gone)) state = muteStateFor(state, id, 'forever', now);
        delete nextPrefs[id];
    }
    return { state, prefs: nextPrefs };
}
