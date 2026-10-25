/**
 * My Emojis library state and its cross-device merge.
 *
 * Same snapshot-merge idea as the GIF library (utils/gifLibrarySync.ts): two
 * devices each hand over their whole view and both must settle on the IDENTICAL
 * library whichever order they sync in. Differences: an entry here is mutable
 * (rename, reorder), so every entry carries its own last-modified stamp `at`
 * and deletion is a tombstone map, rather than one ledger entry per id.
 *
 *   per id, the newest of {local entry, remote entry} (by `at`) is the
 *   candidate; a tombstone newer than the candidate deletes it. Exact tie
 *   between a tombstone and an entry keeps the entry (the data-preserving side
 *   of a coin flip, as in the GIF rule).
 *
 * After the per-id merge the result is normalised by pure functions of the
 * merged SET only (sort, de-duplicate names, trim to the 100 cap), so
 * normalisation can never make two devices diverge, and merging the same
 * snapshot twice is a no-op.
 *
 * No React, DOM or IPC in here.
 */

import {
    PERSONAL_EMOJI_LIBRARY_MAX, PERSONAL_EMOJI_MAX_BYTES, PERSONAL_EMOJI_MIMES,
    isPersonalEmojiId, isPersonalEmojiName,
} from './token';

export interface EmojiEntry {
    /** `p_` + content hash: also the key of the stored bytes. */
    id: string;
    name: string;
    mime: string;
    animated: boolean;
    /** Stored bytes, for the settings readout. */
    size: number;
    /** Position in the library (ascending). Fractional so a move touches one entry. */
    order: number;
    /** Last modification (add / rename / move), ms. LWW stamp. */
    at: number;
    addedAt: number;
}

export interface EmojiLibState {
    entries: EmojiEntry[];
    /** id -> when it was removed (ms). */
    tombstones: Record<string, number>;
}

/** Tombstones are forgotten after this; matches pin/GIF sync's window. */
export const EMOJI_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const emptyLibrary = (): EmojiLibState => ({ entries: [], tombstones: {} });

export function isValidEntry(e: unknown): e is EmojiEntry {
    if (!e || typeof e !== 'object') return false;
    const c = e as Partial<EmojiEntry>;
    return isPersonalEmojiId(c.id)
        && isPersonalEmojiName(c.name)
        && typeof c.mime === 'string' && (PERSONAL_EMOJI_MIMES as readonly string[]).includes(c.mime)
        && typeof c.animated === 'boolean'
        && typeof c.size === 'number' && Number.isFinite(c.size) && c.size > 0 && c.size <= PERSONAL_EMOJI_MAX_BYTES
        && typeof c.order === 'number' && Number.isFinite(c.order)
        && typeof c.at === 'number' && Number.isFinite(c.at)
        && typeof c.addedAt === 'number' && Number.isFinite(c.addedAt);
}

/** Coerce an untrusted state (a snapshot from the other device, or the
 *  persisted blob) to one the merge can trust. Invalid entries are dropped. */
export function sanitizeLibrary(raw: unknown): EmojiLibState {
    const out = emptyLibrary();
    if (!raw || typeof raw !== 'object') return out;
    const r = raw as { entries?: unknown; tombstones?: unknown };
    if (Array.isArray(r.entries)) {
        const seen = new Set<string>();
        for (const e of r.entries) {
            if (isValidEntry(e) && !seen.has(e.id)) {
                seen.add(e.id);
                out.entries.push({ id: e.id, name: e.name, mime: e.mime, animated: e.animated, size: e.size, order: e.order, at: e.at, addedAt: e.addedAt });
            }
        }
    }
    if (r.tombstones && typeof r.tombstones === 'object') {
        for (const [id, at] of Object.entries(r.tombstones as Record<string, unknown>)) {
            if (isPersonalEmojiId(id) && typeof at === 'number' && Number.isFinite(at)) out.tombstones[id] = at;
        }
    }
    out.entries = normalise(out.entries);
    return out;
}

const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byOrder = (a: EmojiEntry, b: EmojiEntry) => a.order - b.order || cmpId(a.id, b.id);

/** Deterministic pick between two versions of the same entry. */
function newer(a: EmojiEntry, b: EmojiEntry): EmojiEntry {
    if (a.at !== b.at) return a.at > b.at ? a : b;
    // Same stamp, different content: any fixed total order will do.
    const ka = `${a.name}\u0000${a.order}`, kb = `${b.name}\u0000${b.order}`;
    return ka >= kb ? a : b;
}

/** Sort, make names unique (later entries get _2, _3 ...), trim to the cap.
 *  A function of the SET alone. */
function normalise(entries: EmojiEntry[]): EmojiEntry[] {
    const sorted = [...entries].sort(byOrder).slice(0, PERSONAL_EMOJI_LIBRARY_MAX);
    const used = new Set<string>();
    return sorted.map(e => {
        let name = e.name;
        for (let n = 2; used.has(name); n++) {
            const suffix = `_${n}`;
            name = e.name.slice(0, 32 - suffix.length) + suffix;
        }
        used.add(name);
        return name === e.name ? e : { ...e, name };
    });
}

function sameState(a: EmojiLibState, b: EmojiLibState): boolean {
    if (a.entries.length !== b.entries.length) return false;
    for (let i = 0; i < a.entries.length; i++) {
        const x = a.entries[i], y = b.entries[i];
        if (x.id !== y.id || x.name !== y.name || x.order !== y.order || x.at !== y.at
            || x.mime !== y.mime || x.animated !== y.animated || x.size !== y.size) return false;
    }
    const ak = Object.keys(a.tombstones), bk = Object.keys(b.tombstones);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (a.tombstones[k] !== b.tombstones[k]) return false;
    return true;
}

/**
 * Merge a remote snapshot into the local one. Commutative and idempotent;
 * returns `local` itself when nothing changed.
 */
export function mergeLibraries(local: EmojiLibState, remoteRaw: EmojiLibState): EmojiLibState {
    const remote = sanitizeLibrary(remoteRaw);
    const lMap = new Map(local.entries.map(e => [e.id, e]));
    const rMap = new Map(remote.entries.map(e => [e.id, e]));
    const ids = new Set<string>([
        ...lMap.keys(), ...rMap.keys(), ...Object.keys(local.tombstones), ...Object.keys(remote.tombstones),
    ]);

    const entries: EmojiEntry[] = [];
    const tombstones: Record<string, number> = {};
    for (const id of ids) {
        const l = lMap.get(id), r = rMap.get(id);
        const cand = l && r ? newer(l, r) : (l ?? r);
        const lt = local.tombstones[id], rt = remote.tombstones[id];
        const tomb = lt !== undefined && rt !== undefined ? Math.max(lt, rt) : (lt ?? rt);
        if (cand && (tomb === undefined || cand.at >= tomb)) entries.push(cand);
        else if (tomb !== undefined) tombstones[id] = tomb;
    }

    const next: EmojiLibState = { entries: normalise(entries), tombstones };
    return sameState(local, next) ? local : next;
}

/** Drop tombstones older than `maxAgeMs`. */
export function pruneTombstones(s: EmojiLibState, now: number, maxAgeMs = EMOJI_TOMBSTONE_TTL_MS): EmojiLibState {
    let changed = false;
    const tombstones: Record<string, number> = {};
    for (const [id, at] of Object.entries(s.tombstones)) {
        if (now - at < maxAgeMs) tombstones[id] = at; else changed = true;
    }
    return changed ? { entries: s.entries, tombstones } : s;
}

/** What a caller must write to / delete from disk to match a merge result. */
export function diffLibraries(before: EmojiLibState, after: EmojiLibState): { added: EmojiEntry[]; removed: string[] } {
    const b = new Set(before.entries.map(e => e.id)), a = new Set(after.entries.map(e => e.id));
    return { added: after.entries.filter(e => !b.has(e.id)), removed: [...b].filter(id => !a.has(id)) };
}

// ── Local operations ────────────────────────────────────────────────────────
// A local edit is authoritative the moment it happens, so its stamp must beat
// whatever the entry already carries even when this device's clock runs behind
// (the failure the GIF library's multi-device audit found): at = max(now, prev + 1).

const stamp = (now: number, prev: number | undefined) =>
    prev !== undefined && prev >= now ? prev + 1 : now;

export type LibraryError = 'full' | 'duplicate_name' | 'invalid_name' | 'not_found';
export type OpResult = { ok: true; state: EmojiLibState; entry: EmojiEntry } | { ok: false; error: LibraryError };

const nameTaken = (s: EmojiLibState, name: string, exceptId?: string) =>
    s.entries.some(e => e.id !== exceptId && e.name === name);

/** Add an emoji at the end. Re-adding an id already present is a no-op success. */
export function addEntry(
    s: EmojiLibState,
    meta: { id: string; name: string; mime: string; animated: boolean; size: number },
    now: number,
): OpResult {
    const existing = s.entries.find(e => e.id === meta.id);
    if (existing) return { ok: true, state: s, entry: existing };
    if (!isPersonalEmojiName(meta.name)) return { ok: false, error: 'invalid_name' };
    if (s.entries.length >= PERSONAL_EMOJI_LIBRARY_MAX) return { ok: false, error: 'full' };
    if (nameTaken(s, meta.name)) return { ok: false, error: 'duplicate_name' };
    const maxOrder = s.entries.reduce((m, e) => Math.max(m, e.order), -1);
    // Beat a tombstone for the same id (delete then re-add on a slow clock).
    const at = stamp(now, s.tombstones[meta.id]);
    const entry: EmojiEntry = { ...meta, order: maxOrder + 1, at, addedAt: now };
    const tombstones = { ...s.tombstones };
    delete tombstones[meta.id];
    return { ok: true, state: { entries: normalise([...s.entries, entry]), tombstones }, entry };
}

export function renameEntry(s: EmojiLibState, id: string, name: string, now: number): OpResult {
    const cur = s.entries.find(e => e.id === id);
    if (!cur) return { ok: false, error: 'not_found' };
    if (!isPersonalEmojiName(name)) return { ok: false, error: 'invalid_name' };
    if (nameTaken(s, name, id)) return { ok: false, error: 'duplicate_name' };
    if (cur.name === name) return { ok: true, state: s, entry: cur };
    const entry = { ...cur, name, at: stamp(now, cur.at) };
    return { ok: true, state: { ...s, entries: normalise(s.entries.map(e => (e.id === id ? entry : e))) }, entry };
}

/** Move `id` so it sits at `toIndex` (0-based) in the displayed order. */
export function moveEntry(s: EmojiLibState, id: string, toIndex: number, now: number): OpResult {
    const sorted = [...s.entries].sort(byOrder);
    const from = sorted.findIndex(e => e.id === id);
    if (from === -1) return { ok: false, error: 'not_found' };
    const to = Math.max(0, Math.min(sorted.length - 1, Math.trunc(toIndex)));
    if (to === from) return { ok: true, state: s, entry: sorted[from] };
    const rest = sorted.filter(e => e.id !== id);
    const prev = rest[to - 1], next = rest[to];
    const order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order + 1 : next.order - 1;
    const cur = sorted[from];
    const entry = { ...cur, order, at: stamp(now, cur.at) };
    return { ok: true, state: { ...s, entries: normalise(s.entries.map(e => (e.id === id ? entry : e))) }, entry };
}

export function removeEntry(s: EmojiLibState, id: string, now: number): EmojiLibState {
    const cur = s.entries.find(e => e.id === id);
    if (!cur) return s;
    return {
        entries: s.entries.filter(e => e.id !== id),
        tombstones: { ...s.tombstones, [id]: stamp(now, cur.at) },
    };
}

/**
 * Put back an entry that was just removed (Undo), keeping its original
 * position and name. Stamped newer than the tombstone, so the restore wins
 * over the removal on every device (same rule as re-adding a removed emoji).
 * A no-op when the id is already present.
 */
export function restoreEntry(s: EmojiLibState, entry: EmojiEntry, now: number): OpResult {
    const existing = s.entries.find(e => e.id === entry.id);
    if (existing) return { ok: true, state: s, entry: existing };
    if (s.entries.length >= PERSONAL_EMOJI_LIBRARY_MAX) return { ok: false, error: 'full' };
    const restored: EmojiEntry = { ...entry, at: stamp(now, Math.max(entry.at, s.tombstones[entry.id] ?? 0)) };
    const tombstones = { ...s.tombstones };
    delete tombstones[entry.id];
    return { ok: true, state: { entries: normalise([...s.entries, restored]), tombstones }, entry: restored };
}
