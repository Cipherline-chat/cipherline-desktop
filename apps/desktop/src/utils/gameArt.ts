/**
 * Pictures for the profile's "Playing ..." row: the shape main hands over, the
 * per-device cache, and the loader for YOUR OWN game.
 *
 * Three picture tiers, shown in this order of preference and swapped in place
 * (the art box has a fixed size, so nothing moves when a better one lands):
 *  1. the game's own executable icon, read by the main process from YOUR
 *     computer (electron/game-art.ts). Never sent anywhere: it is drawn here
 *     and kept in this device's encrypted local store;
 *  2. the game's Steam store picture, fetched through our art proxy by Steam
 *     app id (hooks/useIntegrations.ts fetchArt) - for a game you play the id
 *     comes from your own Steam library, for a friend's it comes from the
 *     bundled catalogue (utils/gameCatalog.ts), by name;
 *  3. a plain drawing (controller / cube).
 *
 * The per-game cache (`cipherline_game_art_v1`, one encrypted JSON record,
 * least-recently-used, 16 games, <= 100 KB a picture) is what makes the second
 * time instant: both the icon and the better picture are kept, so the row
 * paints its FINAL picture on the very first frame after a restart. It holds a
 * game's name and its picture, never who plays it. It is a derived cache: it
 * is not in backups (services/backupRegistry.ts).
 */
import secureLocalStore from './secureLocalStore';
import { isStoreId, normGameName, type StoreId } from './gameCatalog';

/** What the main process says about the game it detected. Parsed, never trusted. */
export interface OwnGameArt {
    name: string;
    /** `data:image/png;base64,...` read from the executable, or null. */
    icon: string | null;
    /** The launcher the executable lives under (from its path), or null. */
    store: StoreId | null;
    /** The Steam app id of an installed Steam game, or null. */
    appId: number | null;
}

/** A picture's cap (characters of the data URL). Mirrors electron/game-art.ts and the preload. */
export const GAME_ICON_MAX_CHARS = 100_000;
const DATA_PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
export const isGameIcon = (v: unknown): v is string => typeof v === 'string' && v.length <= GAME_ICON_MAX_CHARS && DATA_PNG_RE.test(v);
const isAppId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 0x7fffffff;

/** The trust boundary for the main-process answer: every field checked, anything else becomes null. */
export function readOwnGameArt(raw: unknown): OwnGameArt | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 200) return null;
    return {
        name: r.name,
        icon: isGameIcon(r.icon) ? r.icon : null,
        store: isStoreId(r.store) ? r.store : null,
        appId: isAppId(r.appId) ? r.appId : null,
    };
}

// ── The per-device cache ─────────────────────────────────────────────────

export const GAME_ART_KEY = 'cipherline_game_art_v1';
export const GAME_ART_MAX = 16;

export interface GameArtRecord {
    /** The game's name as last seen (for display only; the map key is normalised). */
    name: string;
    icon?: string;
    /** A store picture (data URL) - the better one. */
    cover?: string;
    store?: StoreId;
    appId?: number;
    at: number;
}

interface KvLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

const isRecord = (v: unknown): v is GameArtRecord => {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return typeof r.name === 'string' && typeof r.at === 'number'
        && (r.icon === undefined || isGameIcon(r.icon))
        && (r.cover === undefined || (typeof r.cover === 'string' && r.cover.length <= GAME_ICON_MAX_CHARS && /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(r.cover)))
        && (r.store === undefined || isStoreId(r.store))
        && (r.appId === undefined || isAppId(r.appId));
};

export class GameArtCache {
    private map = new Map<string, GameArtRecord>();
    private loaded = false;
    private version = 0;
    private subs = new Set<() => void>();
    private readonly kv: KvLike;
    private readonly now: () => number;

    constructor(kv: KvLike, now: () => number = Date.now) {
        this.kv = kv;
        this.now = now;
    }

    private load(): void {
        if (this.loaded) return;
        let raw: string | null;
        // Not hydrated yet (a surface rendered before boot finished, a test): read again next time.
        try { raw = this.kv.getItem(GAME_ART_KEY); } catch { return; }
        this.loaded = true;
        try {
            const parsed: unknown = raw ? JSON.parse(raw) : null;
            if (!parsed || typeof parsed !== 'object') return;
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                if (isRecord(v) && k === normGameName(v.name)) this.map.set(k, v);
            }
        } catch { /* a damaged record is just an empty cache */ }
    }

    get(name: string): GameArtRecord | null {
        this.load();
        return this.map.get(normGameName(name)) ?? null;
    }

    /** Merge new facts about a game; persists, and tells subscribers only if something changed. */
    put(name: string, patch: Partial<Omit<GameArtRecord, 'name' | 'at'>>): void {
        this.load();
        const key = normGameName(name);
        if (!key) return;
        const prev = this.map.get(key);
        const next: GameArtRecord = { ...(prev ?? { name, at: 0 }), name: prev?.name ?? name, at: this.now() };
        let changed = !prev;
        for (const f of ['icon', 'cover', 'store', 'appId'] as const) {
            const v = patch[f];
            if (v === undefined || v === null || next[f] === v) continue;
            if ((f === 'icon' || f === 'cover') && !(typeof v === 'string' && v.length <= GAME_ICON_MAX_CHARS)) continue;
            (next as unknown as Record<string, unknown>)[f] = v;
            changed = true;
        }
        this.map.delete(key);
        this.map.set(key, next);
        while (this.map.size > GAME_ART_MAX) this.map.delete(this.map.keys().next().value as string);
        if (changed) { this.persist(); this.version += 1; for (const s of this.subs) s(); }
    }

    /** Forget every game (tests; a future "clear cache"). */
    clear(): void {
        this.map.clear();
        this.loaded = true;
        this.persist();
        this.version += 1;
        for (const s of this.subs) s();
    }

    private persist(): void {
        try { this.kv.setItem(GAME_ART_KEY, JSON.stringify(Object.fromEntries(this.map))); } catch { /* best effort */ }
    }

    subscribe = (cb: () => void): (() => void) => { this.subs.add(cb); return () => { this.subs.delete(cb); }; };
    getVersion = (): number => this.version;
}

export const gameArtCache = new GameArtCache(secureLocalStore);

// ── Your own game: ask the main process once per game ────────────────────

type Bridge = { getCurrentGameArt?: () => Promise<unknown> };
const asked = new Map<string, Promise<void>>();

/**
 * Ask main for the picture of the game it has detected and file it. Called the
 * moment a game is detected (hooks/useUserStatus.ts) so it is usually in the
 * cache before anyone opens a profile, and again by the profile row (a no-op
 * when already asked). The answer must name the game we expect.
 */
export function loadOwnGameArt(name: string | null, cache: GameArtCache = gameArtCache, api?: Bridge): Promise<void> {
    if (!name) return Promise.resolve();
    const bridge = api ?? (typeof window !== 'undefined' ? (window as unknown as { electronAPI?: Bridge }).electronAPI : undefined);
    if (!bridge?.getCurrentGameArt) return Promise.resolve();
    const key = normGameName(name);
    const prev = asked.get(key);
    if (prev) return prev;
    const p = bridge.getCurrentGameArt().then((raw) => {
        const art = readOwnGameArt(raw);
        if (!art || normGameName(art.name) !== key) { asked.delete(key); return; }
        cache.put(name, { icon: art.icon ?? undefined, store: art.store ?? undefined, appId: art.appId ?? undefined });
    }).catch(() => { asked.delete(key); });
    asked.set(key, p);
    return p;
}

/** A game ended: ask again next time it starts (it may have moved, or main may have a better answer). */
export function forgetOwnGameArt(name: string | null): void {
    if (name) asked.delete(normGameName(name));
}
