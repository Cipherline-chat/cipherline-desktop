/**
 * Readers for the integrations API (apps/api/src/integrations/). The wire is
 * untrusted: every field is re-validated here, and anything odd is dropped
 * rather than rendered. No third-party URL is ever followed from here: images
 * arrive as art REFS and are fetched through our API (/v1/integrations/art).
 */

// ── Art refs (mirrors apps/api/src/integrations/art.ts; artRef.test.ts reads it) ─

export const ART_REF_RE = /^(?:steam:([1-9]\d{0,9}):(?:capsule|header|portrait|icon:[0-9a-f]{40})|spotify:[iaf]:[0-9a-f]{40}|spotify:m:[0-9a-f]{160})$/;
export const isArtRef = (v: unknown): v is string => typeof v === 'string' && v.length <= 180 && ART_REF_RE.test(v);

// ── Steam showcase (the `activity` block of GET /v1/users/:id/steam) ────────

export interface SteamGameArt { capsule: string | null; header: string | null; portrait: string | null; icon: string | null }
export interface SteamRecentGame { appId: number; name: string; minutes2w: number; minutesTotal: number; art: SteamGameArt }
export interface SteamNowPlaying { appId: number | null; name: string; art: SteamGameArt | null }
export interface SteamActivity {
    private: boolean;
    level: number | null;
    gameCount: number | null;
    nowPlaying: SteamNowPlaying | null;
    recent: SteamRecentGame[];
}

const text = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max);
    return s || null;
};
const count = (v: unknown, max = 1e9): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const appId = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 0xffffffff ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function readArt(v: unknown, id: number | null): SteamGameArt | null {
    const o = obj(v);
    if (!o || id === null) return null;
    // A ref must name THIS game: a capsule for app 570 cannot be another app's.
    const mine = (r: unknown) => (isArtRef(r) && r.startsWith(`steam:${id}:`) ? r : null);
    return { capsule: mine(o.capsule), header: mine(o.header), portrait: mine(o.portrait), icon: mine(o.icon) };
}

export function readSteamActivity(raw: unknown): SteamActivity | null {
    const o = obj(raw);
    if (!o) return null;
    const isPrivate = o.private === true;
    const np = obj(o.now_playing);
    const npName = text(np?.name, 100);
    const npId = appId(np?.app_id);
    const recent: SteamRecentGame[] = [];
    if (!isPrivate && Array.isArray(o.recent)) {
        for (const g of o.recent) {
            const r = obj(g);
            const id = appId(r?.app_id);
            const name = text(r?.name, 100);
            if (!r || id === null || !name) continue;
            recent.push({
                appId: id, name,
                minutes2w: count(r.minutes_2w, 20_160) ?? 0,
                minutesTotal: count(r.minutes_total) ?? 0,
                art: readArt(r.art, id) ?? { capsule: null, header: null, portrait: null, icon: null },
            });
            if (recent.length >= 5) break;
        }
    }
    return {
        private: isPrivate,
        level: count(o.level, 10_000),
        gameCount: isPrivate ? null : count(o.game_count, 1_000_000),
        nowPlaying: !isPrivate && npName ? { appId: npId, name: npName, art: readArt(np!.art, npId) } : null,
        recent,
    };
}

/** Steam's level ring colour bands (by tens; the hundreds repeat the cycle). Same order as Steam's own badges. */
export const STEAM_LEVEL_BANDS = [
    '#9B9B9B', '#C02942', '#D95B43', '#FECC23', '#467A3C', '#4E8DDA', '#7652C9', '#C252C9', '#542437', '#997C52',
] as const;
export const steamLevelColor = (level: number): string => STEAM_LEVEL_BANDS[Math.floor(Math.max(0, level) / 10) % 10];

/** "12.5 h", "45 min", "1,204 h". */
export function formatPlaytime(minutes: number): string {
    if (minutes < 60) return `${minutes} min`;
    const h = minutes / 60;
    return `${h < 10 ? (Math.round(h * 10) / 10).toLocaleString('en-US') : Math.round(h).toLocaleString('en-US')} h`;
}

// ── Spotify showcase ─────────────────────────────────────────────────────────

export type SpotifyKind = 'playlist' | 'album';
export interface SpotifyItem { kind: SpotifyKind; id: string; title: string; cover: string | null }
export const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
export const SPOTIFY_SHOWCASE_MAX = 3;

export function readSpotifyItems(raw: unknown): SpotifyItem[] {
    if (!Array.isArray(raw)) return [];
    const out: SpotifyItem[] = [];
    for (const v of raw) {
        const o = obj(v);
        const kind = o?.kind === 'playlist' || o?.kind === 'album' ? o.kind : null;
        const id = typeof o?.id === 'string' && SPOTIFY_ID_RE.test(o.id) ? o.id : null;
        const title = text(o?.title, 120);
        if (!kind || !id || !title) continue;
        out.push({ kind, id, title, cover: isArtRef(o!.cover) && (o!.cover as string).startsWith('spotify:') ? (o!.cover as string) : null });
        if (out.length >= SPOTIFY_SHOWCASE_MAX) break;
    }
    return out;
}

/** The public page for an item - built here from a validated id, never taken from the wire. */
export const spotifyItemUrl = (i: Pick<SpotifyItem, 'kind' | 'id'>): string => `https://open.spotify.com/${i.kind}/${i.id}`;

/**
 * A pasted link -> { kind, id } (mirror of parseSpotifyLink in
 * apps/api/src/integrations/spotify.ts, for instant feedback; the server
 * decides). null = not a playlist / album link.
 */
export function parseSpotifyLink(raw: string): { kind: SpotifyKind; id: string } | null {
    const s = raw.trim();
    if (!s || s.length > 300) return null;
    const uri = /^spotify:(playlist|album):([A-Za-z0-9]{22})$/.exec(s);
    if (uri) return { kind: uri[1] as SpotifyKind, id: uri[2] };
    let u: URL;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return null;
    if (u.hostname.toLowerCase() !== 'open.spotify.com') return null;
    const m = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(playlist|album)\/([A-Za-z0-9]{22})\/?$/i.exec(u.pathname);
    return m ? { kind: m[1].toLowerCase() as SpotifyKind, id: m[2] } : null;
}

export interface IntegrationsAvailability { steamData: boolean; spotifyShowcase: boolean }
export interface MyIntegrations { available: IntegrationsAvailability; spotify: SpotifyItem[] }

export function readMyIntegrations(raw: unknown): MyIntegrations {
    const o = obj(raw);
    const a = obj(o?.available);
    return {
        available: { steamData: a?.steam_data === true, spotifyShowcase: a?.spotify_showcase === true },
        spotify: readSpotifyItems(o?.spotify),
    };
}
