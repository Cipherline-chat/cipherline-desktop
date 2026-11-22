/**
 * customThemeSync - the pure part of custom-theme own-device sync (plan T5,
 * owner decision D8): payload shape, validation of what another device sends,
 * per-theme last-writer-wins merge with tombstones, and local-edit stamping.
 * Same rules as utils/cardStyleSync.ts (the "My styles" slot), applied to the
 * `themes` slot. No React, IPC, DOM or storage: unit-testable.
 *
 * What syncs: the custom theme LIBRARY (names + colours). Which theme a device
 * shows stays device-level ("this laptop uses Light"), never synced.
 */
import { normalizeCustomTheme, type CustomThemeDef, type StoredCustomTheme } from '../theme/customTheme';
import { isSafeSyncId } from './ownSlotSync';

export const THEMES_SLOT = 'themes';
export const THEMES_MAGIC = 'CLTHM1';
export const THEMES_PAYLOAD_VERSION = 1;
export const MAX_THEMES_PAYLOAD_BYTES = 128 * 1024;
export const THEME_LIBRARY_MAX = 24;
export const THEME_ID_MAX = 64;
export const MAX_THEME_TOMBSTONES_READ = 200;
export const THEME_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export const customThemeLibraryKey = (uid: string) => `cipherline_custom_themes_${uid}`;
/** Per-theme stamps + tombstones (backed up with the library). */
export const customThemeMetaKey = (uid: string) => `cipherline_custom_themes_meta_${uid}`;
/** What THIS device last knew about the slot. Device-local: never backed up. */
export const customThemeViewKey = (uid: string) => `cipherline_custom_themes_sync_view_${uid}`;

export interface SyncThemeItem {
    id: string;
    def: CustomThemeDef;
    /** Creation time (ms): fixes display order. */
    created: number;
    /** Last create / edit / rename of this id (ms). */
    at: number;
}

export interface ThemeSyncState {
    items: SyncThemeItem[];
    tombstones: Record<string, number>;
}

export interface ThemeMeta {
    stamps: Record<string, { created: number; at: number }>;
    tombstones: Record<string, number>;
}

export const emptyThemeState = (): ThemeSyncState => ({ items: [], tombstones: {} });
export const emptyThemeMeta = (): ThemeMeta => ({ stamps: {}, tombstones: {} });
export const isEmptyThemeState = (s: ThemeSyncState): boolean => s.items.length === 0 && Object.keys(s.tombstones).length === 0;

const isTime = (v: unknown, now: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= now + MAX_FUTURE_SKEW_MS;

export const safeThemeId = (id: unknown): id is string => isSafeSyncId(id) && (id as string).length <= THEME_ID_MAX;

function canon(i: SyncThemeItem): string {
    const d = i.def;
    return JSON.stringify([d.name, d.base, d.glow, d.colors.bg, d.colors.panel, d.colors.surface, d.colors.text, d.colors.muted, d.colors.accent, d.colors.onAccent, d.colors.danger, d.colors.border]);
}

function byCreated(a: SyncThemeItem, b: SyncThemeItem): number {
    return a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ── Library record ──────────────────────────────────────────────────────────

/** The stored library -> validated themes (re-normalised on read: it can come from a backup or another device). */
export function parseThemeLibrary(raw: string | null | undefined): StoredCustomTheme[] {
    if (!raw) return [];
    try {
        const o = JSON.parse(raw) as { items?: unknown };
        if (!Array.isArray(o?.items)) return [];
        const out: StoredCustomTheme[] = [];
        const seen = new Set<string>();
        for (const it of o.items.slice(0, THEME_LIBRARY_MAX)) {
            const id = (it as { id?: unknown } | null)?.id;
            if (!safeThemeId(id) || seen.has(id)) continue;
            const r = normalizeCustomTheme(it);
            if (!r.ok) continue;
            seen.add(id);
            out.push({ id, ...r.def });
        }
        return out;
    } catch { return []; }
}

export function serializeThemeLibrary(items: readonly StoredCustomTheme[]): string {
    return JSON.stringify({
        v: 1,
        items: items.slice(0, THEME_LIBRARY_MAX).map((t) => ({ id: t.id, v: t.v, name: t.name, base: t.base, colors: t.colors, glow: t.glow })),
    });
}

// ── Local meta ──────────────────────────────────────────────────────────────

export function parseThemeMeta(raw: string | null | undefined, now: number): ThemeMeta {
    const out = emptyThemeMeta();
    if (!raw) return out;
    try {
        const o = JSON.parse(raw) as { v?: unknown; stamps?: unknown; tombstones?: unknown };
        if (!o || o.v !== 1) return out;
        if (o.stamps && typeof o.stamps === 'object' && !Array.isArray(o.stamps)) {
            for (const [id, s] of Object.entries(o.stamps as Record<string, { created?: unknown; at?: unknown }>)) {
                if (!safeThemeId(id) || !s || !isTime(s.created, now) || !isTime(s.at, now)) continue;
                out.stamps[id] = { created: s.created, at: s.at };
            }
        }
        if (o.tombstones && typeof o.tombstones === 'object' && !Array.isArray(o.tombstones)) {
            for (const [id, at] of Object.entries(o.tombstones as Record<string, unknown>).slice(0, MAX_THEME_TOMBSTONES_READ)) {
                if (safeThemeId(id) && isTime(at, now)) out.tombstones[id] = at;
            }
        }
    } catch { /* corrupt: read as empty */ }
    return out;
}

export function serializeThemeMeta(m: ThemeMeta): string {
    return JSON.stringify({ v: 1, stamps: m.stamps, tombstones: m.tombstones });
}

/** The local library as a sync state (unstamped items: at = 1, created = 1 + position). */
export function buildLocalThemeState(library: readonly StoredCustomTheme[], meta: ThemeMeta): ThemeSyncState {
    const items: SyncThemeItem[] = library.map((t, i) => {
        const st = meta.stamps[t.id];
        const { id, ...def } = t;
        return { id, def, created: st ? st.created : 1 + i, at: st ? st.at : 1 };
    });
    const tombstones: Record<string, number> = {};
    const live = new Map(items.map((i) => [i.id, i.at]));
    for (const [id, at] of Object.entries(meta.tombstones)) {
        const itemAt = live.get(id);
        if (itemAt === undefined || at > itemAt) tombstones[id] = at;
    }
    return { items: items.filter((i) => !(i.id in tombstones)), tombstones };
}

export function themeMetaFromState(s: ThemeSyncState): ThemeMeta {
    const stamps: ThemeMeta['stamps'] = {};
    for (const i of s.items) stamps[i.id] = { created: i.created, at: i.at };
    return { stamps, tombstones: { ...s.tombstones } };
}

export function libraryFromState(s: ThemeSyncState): StoredCustomTheme[] {
    return s.items.map((i) => ({ id: i.id, ...i.def }));
}

export type ThemeEditKind = 'create' | 'edit' | 'remove';

/** Stamp a LOCAL user edit: it must beat whatever the ledger holds for the id even on a clock running behind. */
export function stampThemeEdit(meta: ThemeMeta, kind: ThemeEditKind, id: string, now: number): ThemeMeta {
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

/** After a user backup restore / device transfer: every theme at = now so the restore wins. */
export function restampAllThemes(state: ThemeSyncState, now: number): ThemeSyncState {
    const items = state.items.map((i) => ({ ...i, at: Math.max(now, i.at + 1) }));
    const tombstones = { ...state.tombstones };
    for (const i of items) delete tombstones[i.id];
    return { items, tombstones };
}

// ── Merge ───────────────────────────────────────────────────────────────────

export function sameThemeState(a: ThemeSyncState, b: ThemeSyncState): boolean {
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
 * Merge two states: per id, the newer stamp wins (an item's `at`, or its
 * tombstone time); equal stamps: two items -> the smaller canonical form
 * (deterministic on every device), item vs tombstone -> the item. Commutative
 * and idempotent; returns `a` itself when the result equals it. `now` only
 * prunes expired tombstones.
 */
export function mergeThemeStates(a: ThemeSyncState, b: ThemeSyncState, now: number): ThemeSyncState {
    const ids = new Set<string>([
        ...a.items.map((i) => i.id), ...b.items.map((i) => i.id), ...Object.keys(a.tombstones), ...Object.keys(b.tombstones),
    ]);
    const ai = new Map(a.items.map((i) => [i.id, i]));
    const bi = new Map(b.items.map((i) => [i.id, i]));
    const items: SyncThemeItem[] = [];
    const tombstones: Record<string, number> = {};
    for (const id of ids) {
        const side = (m: Map<string, SyncThemeItem>, t: Record<string, number>) => {
            const it = m.get(id);
            if (it) return { item: it, at: it.at };
            return id in t ? { item: undefined, at: t[id] } : null;
        };
        const x = side(ai, a.tombstones), y = side(bi, b.tombstones);
        let win: { item: SyncThemeItem | undefined; at: number };
        if (!x) win = y!;
        else if (!y) win = x;
        else if (x.at !== y.at) win = x.at > y.at ? x : y;
        else if (x.item && y.item) win = canon(x.item) <= canon(y.item) ? x : y;
        else win = x.item ? x : y;
        if (win.item) items.push(win.item);
        else if (now - win.at < THEME_TOMBSTONE_TTL_MS) tombstones[id] = win.at;
    }
    let kept = items;
    if (kept.length > THEME_LIBRARY_MAX) {
        kept = [...items].sort((p, q) => q.created - p.created || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)).slice(0, THEME_LIBRARY_MAX);
    }
    const next: ThemeSyncState = { items: kept.sort(byCreated), tombstones };
    return sameThemeState(a, next) ? a : next;
}

// ── Payload ─────────────────────────────────────────────────────────────────

export interface ThemesPayload {
    v: number;
    writtenAt: number;
    items: { id: string; theme: CustomThemeDef; created: number; at: number }[];
    tombstones: Record<string, number>;
}

export function buildThemesPayload(state: ThemeSyncState, now: number): ThemesPayload {
    return {
        v: THEMES_PAYLOAD_VERSION,
        writtenAt: now,
        items: state.items.map((i) => ({ id: i.id, theme: i.def, created: i.created, at: i.at })),
        tombstones: { ...state.tombstones },
    };
}

/**
 * Parse + validate a payload from another device. Throws on a structurally
 * invalid / oversize / unknown-version payload (the caller changes nothing);
 * drops bad items one by one (each theme re-normalised: the same validation
 * and readability guard as the editor). A bad item never becomes a tombstone.
 */
export function parseThemesPayload(json: string, now: number): ThemeSyncState {
    if (json.length > MAX_THEMES_PAYLOAD_BYTES) throw new Error('themes payload too large');
    let o: { v?: unknown; items?: unknown; tombstones?: unknown } | null;
    try { o = JSON.parse(json); } catch { throw new Error('themes payload is not valid JSON'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('themes payload is not an object');
    if (o.v !== THEMES_PAYLOAD_VERSION) throw new Error(`unsupported themes payload version ${String(o.v)}`);
    if (!Array.isArray(o.items)) throw new Error('themes payload has no items');
    const items: SyncThemeItem[] = [];
    const seen = new Set<string>();
    for (const raw of o.items.slice(0, THEME_LIBRARY_MAX)) {
        const r = raw as { id?: unknown; theme?: unknown; created?: unknown; at?: unknown } | null;
        if (!r || typeof r !== 'object' || !safeThemeId(r.id) || seen.has(r.id)) continue;
        if (!isTime(r.created, now) || !isTime(r.at, now)) continue;
        const n = normalizeCustomTheme(r.theme);
        if (!n.ok) continue;
        seen.add(r.id);
        items.push({ id: r.id, def: n.def, created: r.created, at: r.at });
    }
    const tombstones: Record<string, number> = {};
    if (o.tombstones && typeof o.tombstones === 'object' && !Array.isArray(o.tombstones)) {
        for (const [id, at] of Object.entries(o.tombstones as Record<string, unknown>).slice(0, MAX_THEME_TOMBSTONES_READ)) {
            if (safeThemeId(id) && isTime(at, now)) tombstones[id] = at;
        }
    }
    const live = new Map(items.map((i) => [i.id, i.at]));
    for (const [id, at] of Object.entries(tombstones)) {
        const itemAt = live.get(id);
        if (itemAt !== undefined && itemAt >= at) delete tombstones[id];
    }
    return { items: items.filter((i) => !(i.id in tombstones)).sort(byCreated), tombstones };
}
