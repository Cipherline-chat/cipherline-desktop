/**
 * gifLibrarySync — conflict resolution for the GIF library across your own devices.
 *
 * The GIF library is personal, device-local state: metadata in
 * `cipherline_gif_favorites`, one AES-256-GCM key per GIF in
 * `cipherline_gif_key_<id>`, and the ciphertext itself on disk at
 * `<userData>/cipherline-gifs/<id>.enc`. Nothing about it is conversation-
 * scoped, so it cannot ride the `pin` ClientContent envelope the way personal
 * pins do — `POST /v1/messages/send` requires a conversation_id you are an
 * active member of, and a GIF library belongs to no conversation.
 *
 * It travels as a whole-library snapshot in its own `/v1/history` slot instead
 * (see gifLibraryTransport.ts). That makes this module's job SNAPSHOT merge
 * rather than op replay: two devices each hand over their whole view and the
 * result has to be the same on both, whichever order they sync in.
 *
 * The rule is last-write-wins per GIF id, over an LWW-element-set:
 *
 *   • an id present in `entries`            → in the library, at ledger[id]
 *   • an id in `ledger` but not in `entries` → a TOMBSTONE, removed at ledger[id]
 *   • an id in neither                       → never seen
 *
 * Tombstones are why the ledger is not merely a cache. Without them a device
 * that deletes a GIF would have the deletion undone by the next sync from a
 * device that still had it — deletion is unrepresentable in a plain union.
 *
 * Clocks between a user's own devices are close enough for LWW, and the
 * failure mode of a skewed clock is "the library ends up in the state the
 * skewed device chose", not corruption. On an exact timestamp tie we keep the
 * GIF rather than dropping it: a tie is a coin flip either way, and the
 * data-preserving side of a coin flip is the one that doesn't destroy a file
 * the user imported.
 *
 * Everything here is plain data — no React, no DOM, no IPC — so it is
 * unit-testable under vitest's node environment.
 */

import type { FavoriteGif } from './gifStorage';
import { parseKlipyGifRef, type KlipyGifRef } from '@cipherline/shared';

/** The metadata for one saved GIF. Structurally the gifStorage entry; the
 *  type-only import keeps this module free of gifStorage's DOM/IPC deps. */
export type GifEntry = FavoriteGif;

/** `Record<gifId, lastOpAtMs>`. An id here with no matching entry is a
 *  tombstone: the GIF was removed at that timestamp. */
export type GifLedger = Record<string, number>;

export interface GifLibraryState {
    entries: GifEntry[];
    ledger: GifLedger;
}

export interface GifOp {
    id: string;
    action: 'add' | 'remove';
    /** Sender's wall clock in ms. */
    at: number;
    /** Required for `add` — there is nothing to insert without it. */
    entry?: GifEntry;
}

/** What changed across a merge, so the caller knows which encrypted files to
 *  materialise and which to delete. Ids only — this module never touches bytes. */
export interface GifLibraryDiff {
    added: GifEntry[];
    removed: string[];
}

// ── Ordering ────────────────────────────────────────────────────────────────
// Two devices must converge on the IDENTICAL array, not merely the same set:
// the array is persisted verbatim, feeds the backup vault, and a different
// order would churn the backup fingerprint on every sync. Newest-first matches
// what gifStorage.addFavorite does locally (`[entry, ...loadFavorites()]`),
// with the id as a deterministic tiebreak for equal timestamps.
function sortEntries(entries: GifEntry[]): GifEntry[] {
    return [...entries].sort((a, b) =>
        b.addedAt - a.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function indexById(entries: GifEntry[]): Map<string, GifEntry> {
    const m = new Map<string, GifEntry>();
    for (const e of entries) if (e && typeof e.id === 'string') m.set(e.id, e);
    return m;
}

/** A well-formed entry. A snapshot arrives from another device, so it is
 *  untrusted input even though that device is ours — reject anything that
 *  would poison the local library or the backup vault. */
export function isValidEntry(e: unknown): e is GifEntry {
    if (!e || typeof e !== 'object') return false;
    const c = e as Partial<GifEntry>;
    return typeof c.id === 'string' && c.id.length > 0
        && typeof c.fileName === 'string' && c.fileName.length > 0
        && typeof c.mimeType === 'string'
        && typeof c.addedAt === 'number' && Number.isFinite(c.addedAt);
}

export const emptyLibraryState = (): GifLibraryState => ({ entries: [], ledger: {} });

// ── What may travel between devices ─────────────────────────────────────────

/**
 * `fileName` of a KLIPY reference entry. There is no file: the sentinel only
 * keeps the entry well-formed for older clients' `isValidEntry` (desktop and
 * mobile both require a non-empty fileName), so an older client sees a valid
 * `source: 'klipy'` entry and REFUSES it by source — dropping entry AND ledger
 * timestamp together — instead of dropping it as malformed and keeping its
 * timestamp, which would read as a tombstone. Never used as a path.
 */
export const KLIPY_REF_FILENAME = 'klipy-ref';

/**
 * A saved KLIPY GIF stored the way KLIPY's terms allow: a reference (slug +
 * one rendition's URL/dims/mime), no media bytes, no key, no file.
 */
export function isKlipyRefEntry(e: unknown): e is GifEntry & { klipy: KlipyGifRef } {
    if (!e || typeof e !== 'object') return false;
    const c = e as Partial<GifEntry>;
    return c.source === 'klipy'
        && c.fileName === KLIPY_REF_FILENAME
        && parseKlipyGifRef(c.klipy) !== null;
}

/**
 * Byte COPIES of KLIPY media (what the never-shipped proxy build saved) may
 * not travel: KLIPY's terms forbid keeping copies. Stays false. The mobile
 * client has the same constant (cipherline-mobile
 * src/core/own-sync/gifLibrary.ts). Removals are always honoured.
 */
export const KLIPY_GIF_SYNC_ENABLED = false;

/** Legacy source-only check, kept for callers that only have a source. */
export function isSyncableGifSource(source: unknown): boolean {
    if (source === 'klipy') return KLIPY_GIF_SYNC_ENABLED;
    return true;
}

/**
 * May this entry be synced between the user's devices? A KLIPY REFERENCE may
 * (it is metadata — KLIPY explicitly allows storing the slug/media reference);
 * a KLIPY byte copy may not; everything else follows the source rule.
 */
export function isSyncableGifEntry(e: GifEntry): boolean {
    if (e.source === 'klipy') return isKlipyRefEntry(e);
    return isSyncableGifSource(e.source);
}

// ── Local ops ───────────────────────────────────────────────────────────────

/**
 * A LOCAL op is authoritative at the moment it happens, so it must beat
 * whatever the ledger already holds for that id. Stamping a plain `now` did
 * not guarantee that: on a device whose clock runs behind the one that wrote
 * the ledger entry, `now <= lastAt` and applyGifOp ignored the user's own
 * removal — after removeFavorite had already deleted the file and the key, so
 * the tile stayed, permanently broken. Passing the ledger stamps
 * `max(now, lastAt + 1)`. (Multi-device audit 2026-10-03.)
 */
export function localGifOp(
    id: string,
    action: 'add' | 'remove',
    now: number,
    entry?: GifEntry,
    ledger?: GifLedger,
): GifOp {
    const lastAt = ledger?.[id];
    const at = typeof lastAt === 'number' && Number.isFinite(lastAt) && lastAt >= now ? lastAt + 1 : now;
    return { id, action, at, entry };
}

/**
 * KLIPY favorites get a random id per device, so saving the same KLIPY GIF on
 * two devices syncs as TWO entries for one slug: the picker shows it twice,
 * and un-saving (which found the first match) left the heart on. These two
 * helpers make the slug, not the id, what a user perceives:
 */

/** The picker's view: one tile per KLIPY slug (the first, i.e. newest, wins). */
export function dedupeKlipyRefs<T extends GifEntry>(entries: readonly T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const e of entries) {
        if (isKlipyRefEntry(e)) {
            const slug = e.klipy.slug;
            if (seen.has(slug)) continue;
            seen.add(slug);
        }
        out.push(e);
    }
    return out;
}

/** Every id that represents the same KLIPY GIF as `id` (itself included), so
 *  removing a favorite removes all of its synced duplicates. */
export function sameKlipyGifIds(entries: readonly GifEntry[], id: string): string[] {
    const target = entries.find(e => e.id === id);
    if (!target || !isKlipyRefEntry(target)) return target ? [id] : [];
    const slug = target.klipy.slug;
    return entries.filter(e => isKlipyRefEntry(e) && e.klipy.slug === slug).map(e => e.id);
}

/**
 * Apply one op. Returns the SAME object references when nothing changed, so a
 * caller can use identity to skip a re-render and a persist write.
 *
 * An op is ignored when the ledger already holds an entry at or after its
 * timestamp. Using `<=` rather than `<` makes replays idempotent: a snapshot
 * can be applied twice and the second application is a no-op, not a flip-flop.
 */
export function applyGifOp(state: GifLibraryState, op: GifOp): GifLibraryState {
    if (!op || typeof op.id !== 'string' || !op.id) return state;
    if (!Number.isFinite(op.at)) return state;
    if (op.action === 'add' && !isValidEntry(op.entry)) return state;

    const lastAt = state.ledger[op.id];
    if (lastAt !== undefined && op.at <= lastAt) return state;

    const nextLedger: GifLedger = { ...state.ledger, [op.id]: op.at };

    const has = state.entries.some(e => e.id === op.id);
    const wants = op.action === 'add';

    // Record the timestamp even when the id set doesn't move. Otherwise a
    // later, OLDER op would find no ledger entry and get applied.
    if (has === wants) return { entries: state.entries, ledger: nextLedger };

    const nextEntries = wants
        ? sortEntries([...state.entries, op.entry as GifEntry])
        : state.entries.filter(e => e.id !== op.id);

    return { entries: nextEntries, ledger: nextLedger };
}

/** Apply a batch in order. */
export function applyGifOps(state: GifLibraryState, ops: readonly GifOp[]): GifLibraryState {
    return ops.reduce(applyGifOp, state);
}

// ── Snapshot merge ──────────────────────────────────────────────────────────

/**
 * The effective timestamp for an id on one side.
 *
 * The `addedAt` fallback is load-bearing. A device that has never synced has
 * an empty ledger, so every GIF it imported would otherwise carry NO timestamp
 * and lose to any remote tombstone — silently deleting the user's imports the
 * first time they turn sync on. Falling back to the entry's own `addedAt`
 * gives those GIFs a real, and correct, birth time.
 */
function tsFor(state: GifLibraryState, id: string, present: GifEntry | undefined): number | undefined {
    const led = state.ledger[id];
    if (led !== undefined && Number.isFinite(led)) return led;
    return present ? present.addedAt : undefined;
}

/**
 * Merge a remote snapshot into the local one. Commutative and idempotent:
 * merge(a,b) and merge(b,a) agree, and merging the same snapshot twice is a
 * no-op. Returns `local` itself when the merge changed nothing.
 */
export function mergeGifLibraries(
    local: GifLibraryState,
    remote: GifLibraryState,
): GifLibraryState {
    const localById = indexById(local.entries);
    const remoteById = indexById(remote.entries.filter(isValidEntry));

    const ids = new Set<string>([
        ...localById.keys(),
        ...remoteById.keys(),
        ...Object.keys(local.ledger),
        ...Object.keys(remote.ledger),
    ]);

    const entries: GifEntry[] = [];
    const ledger: GifLedger = {};

    for (const id of ids) {
        const lEntry = localById.get(id);
        const rEntry = remoteById.get(id);
        const lAt = tsFor(local, id, lEntry);
        const rAt = tsFor(remote, id, rEntry);

        // A side that has never heard of this id cannot outvote one that has.
        let winner: 'local' | 'remote';
        if (lAt === undefined && rAt === undefined) continue;
        else if (lAt === undefined) winner = 'remote';
        else if (rAt === undefined) winner = 'local';
        else if (lAt !== rAt) winner = lAt > rAt ? 'local' : 'remote';
        // Exact tie: keep the GIF rather than honour the tombstone.
        else winner = lEntry ? 'local' : 'remote';

        const at = Math.max(lAt ?? Number.NEGATIVE_INFINITY, rAt ?? Number.NEGATIVE_INFINITY);
        if (Number.isFinite(at)) ledger[id] = at;

        const kept = winner === 'local' ? lEntry : rEntry;
        if (kept) entries.push(kept);
    }

    const next: GifLibraryState = { entries: sortEntries(entries), ledger };
    return sameState(local, next) ? local : next;
}

function sameState(a: GifLibraryState, b: GifLibraryState): boolean {
    if (a.entries.length !== b.entries.length) return false;
    for (let i = 0; i < a.entries.length; i++) {
        const x = a.entries[i], y = b.entries[i];
        if (x.id !== y.id || x.addedAt !== y.addedAt || x.label !== y.label
            || x.fileName !== y.fileName || x.mimeType !== y.mimeType) return false;
    }
    const ak = Object.keys(a.ledger), bk = Object.keys(b.ledger);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (a.ledger[k] !== b.ledger[k]) return false;
    return true;
}

/** What a caller must materialise (`added`) or delete (`removed`) on disk to
 *  make the filesystem match a merge result. */
export function diffLibraries(before: GifLibraryState, after: GifLibraryState): GifLibraryDiff {
    const beforeIds = new Set(before.entries.map(e => e.id));
    const afterIds = new Set(after.entries.map(e => e.id));
    return {
        added: after.entries.filter(e => !beforeIds.has(e.id)),
        removed: [...beforeIds].filter(id => !afterIds.has(id)),
    };
}

// ── Ledger upkeep ───────────────────────────────────────────────────────────

/**
 * Drop tombstones older than `maxAgeMs`. Entries for GIFs still in the library
 * are never dropped — their timestamp is what defends them against a stale
 * remote tombstone. A recent tombstone is kept so a slow snapshot from a device
 * that still holds the GIF can't resurrect it.
 *
 * The bound on forgetting is real: past the TTL, a device that was offline
 * longer than that and still has the GIF will re-add it. That is the accepted
 * trade for not growing a tombstone per GIF ever deleted, and it matches the
 * 30-day window pin sync uses.
 */
export function pruneGifLedger(
    state: GifLibraryState,
    now: number,
    maxAgeMs: number,
): GifLibraryState {
    const live = new Set(state.entries.map(e => e.id));
    const nextLedger: GifLedger = {};
    let changed = false;

    for (const [id, at] of Object.entries(state.ledger)) {
        if (live.has(id) || (now - at) < maxAgeMs) nextLedger[id] = at;
        else changed = true;
    }

    return changed ? { entries: state.entries, ledger: nextLedger } : state;
}
