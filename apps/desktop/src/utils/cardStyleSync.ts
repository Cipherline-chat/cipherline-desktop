/**
 * cardStyleSync - the pure part of the "My styles" own-device sync
 * (docs/message-card-style-sync.md): payload shape, validation of what another
 * device sends, per-item last-writer-wins merge with tombstones, and the
 * local-edit stamping rules. No React, IPC, DOM or storage: unit-testable.
 */
import { normalizeCardStyle, type CardStyle } from '@cipherline/shared';
import { isSafeSyncId } from './ownSlotSync';

export const CARD_STYLES_SLOT = 'card_styles';
export const CARD_STYLES_MAGIC = 'CLSTY1';
export const CARD_STYLES_PAYLOAD_VERSION = 1;
export const MAX_STYLES_PAYLOAD_BYTES = 256 * 1024;
export const STYLE_LIBRARY_MAX = 24;
export const STYLE_NAME_MAX = 40;
export const STYLE_ID_MAX = 64;
export const MAX_TOMBSTONES_READ = 200;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const cardStyleLibraryKey = (uid: string) => `cipherline_card_styles_${uid}`;
/** Per-item stamps + tombstones (backed up with the library). */
export const cardStyleMetaKey = (uid: string) => `cipherline_card_styles_meta_${uid}`;
/** What THIS device last knew about the slot. Device-local: never backed up. */
export const cardStyleViewKey = (uid: string) => `cipherline_card_styles_sync_view_${uid}`;
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export interface SyncStyleItem {
    id: string;
    name: string;
    style: CardStyle;
    /** Creation time (ms): fixes display order. */
    created: number;
    /** Last create / rename / style-edit of this id (ms). */
    at: number;
}

export interface StyleSyncState {
    items: SyncStyleItem[];
    tombstones: Record<string, number>;
}

export interface StyleMeta {
    stamps: Record<string, { created: number; at: number }>;
    tombstones: Record<string, number>;
}

export const emptyStyleState = (): StyleSyncState => ({ items: [], tombstones: {} });
export const emptyStyleMeta = (): StyleMeta => ({ stamps: {}, tombstones: {} });
export const isEmptyStyleState = (s: StyleSyncState): boolean => s.items.length === 0 && Object.keys(s.tombstones).length === 0;

const isTime = (v: unknown, now: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= now + MAX_FUTURE_SKEW_MS;

const safeId = (id: unknown): id is string => isSafeSyncId(id) && (id as string).length <= STYLE_ID_MAX;

function canon(i: SyncStyleItem): string {
    return JSON.stringify([i.name, i.style]);
}

function byCreated(a: SyncStyleItem, b: SyncStyleItem): number {
    return a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ── Local meta (device-local stamps) ────────────────────────────────────────

/** Parse the persisted meta record. Anything malformed reads as empty. */
export function parseStyleMeta(raw: string | null | undefined, now: number): StyleMeta {
    const out = emptyStyleMeta();
    if (!raw) return out;
    try {
        const o = JSON.parse(raw) as { v?: unknown; stamps?: unknown; tombstones?: unknown };
        if (!o || o.v !== 1) return out;
        if (o.stamps && typeof o.stamps === 'object' && !Array.isArray(o.stamps)) {
            for (const [id, s] of Object.entries(o.stamps as Record<string, { created?: unknown; at?: unknown }>)) {
                if (!safeId(id) || !s || !isTime(s.created, now) || !isTime(s.at, now)) continue;
                out.stamps[id] = { created: s.created, at: s.at };
            }
        }
        if (o.tombstones && typeof o.tombstones === 'object' && !Array.isArray(o.tombstones)) {
            for (const [id, at] of Object.entries(o.tombstones as Record<string, unknown>).slice(0, MAX_TOMBSTONES_READ)) {
                if (safeId(id) && isTime(at, now)) out.tombstones[id] = at;
            }
        }
    } catch { /* corrupt: read as empty */ }
    return out;
}

export function serializeStyleMeta(m: StyleMeta): string {
    return JSON.stringify({ v: 1, stamps: m.stamps, tombstones: m.tombstones });
}

/**
 * The local library as a sync state. Items with no stamp (a library from before
 * sync) get at = 1 and created = 1 + position, so they keep their order, only
 * ever seed an empty slot, and lose to any real edit or tombstone. A tombstone
 * for an id that is still an item is dropped when the item is at least as new.
 */
export function buildLocalState(
    library: readonly { id: string; name: string; style: CardStyle }[], meta: StyleMeta,
): StyleSyncState {
    const items: SyncStyleItem[] = library.map((e, i) => {
        const st = meta.stamps[e.id];
        return { id: e.id, name: e.name, style: e.style, created: st ? st.created : 1 + i, at: st ? st.at : 1 };
    });
    const tombstones: Record<string, number> = {};
    const live = new Map(items.map(i => [i.id, i.at]));
    for (const [id, at] of Object.entries(meta.tombstones)) {
        const itemAt = live.get(id);
        if (itemAt === undefined || at > itemAt) tombstones[id] = at;
    }
    return { items: items.filter(i => !(i.id in tombstones)), tombstones };
}

/** State -> the meta that records it (stamps for every item + tombstones). */
export function metaFromState(s: StyleSyncState): StyleMeta {
    const stamps: StyleMeta['stamps'] = {};
    for (const i of s.items) stamps[i.id] = { created: i.created, at: i.at };
    return { stamps, tombstones: { ...s.tombstones } };
}

export type LocalEditKind = 'create' | 'edit' | 'remove';

/**
 * Stamp a LOCAL user edit. A local edit must beat whatever the ledger already
 * holds for the id even on a clock running behind (max(now, last + 1)).
 */
export function stampLocalEdit(meta: StyleMeta, kind: LocalEditKind, id: string, now: number): StyleMeta {
    const stamps = { ...meta.stamps };
    const tombstones = { ...meta.tombstones };
    const last = Math.max(stamps[id]?.at ?? 0, tombstones[id] ?? 0);
    const at = last >= now ? last + 1 : now;
    if (kind === 'remove') {
        delete stamps[id];
        tombstones[id] = at;
    } else {
        delete tombstones[id];
        stamps[id] = { created: kind === 'create' ? now : (stamps[id]?.created ?? at), at };
    }
    return { stamps, tombstones };
}

/** After a user backup restore / device transfer: every item at = now so the restore wins; tombstones of restored ids go. */
export function restampAll(state: StyleSyncState, now: number): StyleSyncState {
    const items = state.items.map(i => ({ ...i, at: Math.max(now, i.at + 1) }));
    const tombstones = { ...state.tombstones };
    for (const i of items) delete tombstones[i.id];
    return { items, tombstones };
}

// ── Merge ───────────────────────────────────────────────────────────────────

export function sameStyleState(a: StyleSyncState, b: StyleSyncState): boolean {
    if (a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) {
        const x = a.items[i], y = b.items[i];
        if (x.id !== y.id || x.created !== y.created || x.at !== y.at || canon(x) !== canon(y)) return false;
    }
    const ak = Object.keys(a.tombstones), bk = Object.keys(b.tombstones);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (a.tombstones[k] !== b.tombstones[k]) return false;
    return true;
}

/**
 * Merge two states. Commutative and idempotent as sets; returns `a` itself when
 * the result equals it. `now` only drives tombstone pruning.
 */
export function mergeStyleStates(a: StyleSyncState, b: StyleSyncState, now: number): StyleSyncState {
    const ids = new Set<string>([
        ...a.items.map(i => i.id), ...b.items.map(i => i.id), ...Object.keys(a.tombstones), ...Object.keys(b.tombstones),
    ]);
    const ai = new Map(a.items.map(i => [i.id, i]));
    const bi = new Map(b.items.map(i => [i.id, i]));
    const items: SyncStyleItem[] = [];
    const tombstones: Record<string, number> = {};

    for (const id of ids) {
        // A side's effective stamp: its item's `at`, else its tombstone time, else unheard-of.
        const side = (m: Map<string, SyncStyleItem>, t: Record<string, number>) => {
            const it = m.get(id);
            if (it) return { item: it, at: it.at };
            return id in t ? { item: undefined, at: t[id] } : null;
        };
        const x = side(ai, a.tombstones), y = side(bi, b.tombstones);
        let win: { item: SyncStyleItem | undefined; at: number };
        if (!x) win = y!;
        else if (!y) win = x;
        else if (x.at !== y.at) win = x.at > y.at ? x : y;
        else if (x.item && y.item) win = canon(x.item) <= canon(y.item) ? x : y;
        else win = x.item ? x : y; // tie: the item beats the tombstone
        if (win.item) items.push(win.item);
        else if (now - win.at < TOMBSTONE_TTL_MS) tombstones[id] = win.at;
    }

    // Over the cap: keep the 24 newest by created (id tie-break), drop the rest WITHOUT tombstones.
    let kept = items;
    if (kept.length > STYLE_LIBRARY_MAX) {
        kept = [...items].sort((p, q) => q.created - p.created || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)).slice(0, STYLE_LIBRARY_MAX);
    }
    const next: StyleSyncState = { items: kept.sort(byCreated), tombstones };
    return sameStyleState(a, next) ? a : next;
}

// ── Payload ─────────────────────────────────────────────────────────────────

export interface StylesPayload {
    v: number;
    writtenAt: number;
    items: { id: string; name: string; style: CardStyle; created: number; at: number }[];
    tombstones: Record<string, number>;
}

export function buildStylesPayload(state: StyleSyncState, now: number): StylesPayload {
    return {
        v: CARD_STYLES_PAYLOAD_VERSION,
        writtenAt: now,
        items: state.items.map(i => ({ id: i.id, name: i.name, style: i.style, created: i.created, at: i.at })),
        tombstones: { ...state.tombstones },
    };
}

/**
 * Parse + validate a payload from another device. Throws on a structurally
 * invalid or unknown-version payload (the caller changes nothing); drops bad
 * items one by one. Never trusts the received style bytes: stores the
 * normalised style. A bad item never becomes a tombstone.
 */
export function parseStylesPayload(json: string, now: number): StyleSyncState {
    if (json.length > MAX_STYLES_PAYLOAD_BYTES) throw new Error('card styles payload too large');
    let o: { v?: unknown; items?: unknown; tombstones?: unknown } | null;
    try { o = JSON.parse(json); } catch { throw new Error('card styles payload is not valid JSON'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('card styles payload is not an object');
    if (o.v !== CARD_STYLES_PAYLOAD_VERSION) throw new Error(`unsupported card styles payload version ${String(o.v)}`);
    if (!Array.isArray(o.items)) throw new Error('card styles payload has no items');

    const items: SyncStyleItem[] = [];
    const seen = new Set<string>();
    for (const raw of o.items.slice(0, STYLE_LIBRARY_MAX)) {
        const r = raw as { id?: unknown; name?: unknown; style?: unknown; created?: unknown; at?: unknown } | null;
        if (!r || typeof r !== 'object' || !safeId(r.id) || seen.has(r.id)) continue;
        if (typeof r.name !== 'string' || !isTime(r.created, now) || !isTime(r.at, now)) continue;
        const name = r.name.trim().slice(0, STYLE_NAME_MAX);
        const style = normalizeCardStyle(r.style);
        if (!name || !style) continue;
        seen.add(r.id);
        items.push({ id: r.id, name, style, created: r.created, at: r.at });
    }

    const tombstones: Record<string, number> = {};
    if (o.tombstones && typeof o.tombstones === 'object' && !Array.isArray(o.tombstones)) {
        for (const [id, at] of Object.entries(o.tombstones as Record<string, unknown>).slice(0, MAX_TOMBSTONES_READ)) {
            if (safeId(id) && isTime(at, now)) tombstones[id] = at;
        }
    }
    // One side of an id per payload: the item if at least as new, else the tombstone.
    const live = new Map(items.map(i => [i.id, i.at]));
    for (const [id, at] of Object.entries(tombstones)) {
        const itemAt = live.get(id);
        if (itemAt !== undefined && itemAt >= at) delete tombstones[id];
    }
    return { items: items.filter(i => !(i.id in tombstones)).sort(byCreated), tombstones };
}
