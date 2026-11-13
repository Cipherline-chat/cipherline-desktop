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
export interface SteamTopGame { appId: number; name: string; minutesTotal: number; art: SteamGameArt }
export interface SteamNowPlaying { appId: number | null; name: string; art: SteamGameArt | null }
export interface SteamXp { intoLevel: number; levelSpan: number; toNext: number }
export interface SteamAchievement { name: string; description: string | null; unlockedOn: string | null; icon: string | null }
export interface SteamGameAchievements { appId: number; game: string; unlocked: number; total: number; recent: SteamAchievement[] }
export interface SteamActivity {
    /** The Steam PROFILE is private. */
    private: boolean;
    /** The profile is public, but its "Game details" are not: no games, hours or achievements. */
    gamesPrivate: boolean;
    level: number | null;
    xp: SteamXp | null;
    badgeCount: number | null;
    /** 'YYYY-MM' the Steam account was created. */
    memberSince: string | null;
    gameCount: number | null;
    /** All-time minutes over the library (0 with games = Steam keeps the playtime private). */
    totalMinutes: number | null;
    topGames: SteamTopGame[];
    nowPlaying: SteamNowPlaying | null;
    recent: SteamRecentGame[];
    achievements: SteamGameAchievements | null;
}

const text = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max);
    return s || null;
};
const count = (v: unknown, max = 1e9): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const appId = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 0xffffffff ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const NO_ART: SteamGameArt = { capsule: null, header: null, portrait: null, icon: null };

function readArt(v: unknown, id: number | null): SteamGameArt | null {
    const o = obj(v);
    if (!o || id === null) return null;
    // A ref must name THIS game: a capsule for app 570 cannot be another app's.
    const mine = (r: unknown) => (isArtRef(r) && r.startsWith(`steam:${id}:`) ? r : null);
    return { capsule: mine(o.capsule), header: mine(o.header), portrait: mine(o.portrait), icon: mine(o.icon) };
}

const month = (v: unknown): string | null => (typeof v === 'string' && /^(20\d\d)-(0[1-9]|1[0-2])$/.test(v) ? v : null);
const day = (v: unknown): string | null => (typeof v === 'string' && /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) ? v : null);

function readXp(v: unknown): SteamXp | null {
    const o = obj(v);
    const into = count(o?.into_level, 1_000_000);
    const span = count(o?.level_span, 1_000_000);
    const next = count(o?.to_next, 1_000_000);
    return into !== null && span !== null && next !== null && span > 0 && into <= span ? { intoLevel: into, levelSpan: span, toNext: next } : null;
}

function readAchievements(v: unknown): SteamGameAchievements | null {
    const o = obj(v);
    const id = appId(o?.app_id);
    const game = text(o?.game, 100);
    const unlocked = count(o?.unlocked, 100_000);
    const total = count(o?.total, 100_000);
    if (!o || id === null || !game || unlocked === null || total === null || total === 0 || unlocked > total) return null;
    const recent: SteamAchievement[] = [];
    for (const a of Array.isArray(o.recent) ? o.recent : []) {
        const r = obj(a);
        const name = text(r?.name, 120);
        if (!r || !name) continue;
        const icon = isArtRef(r.icon) && r.icon.startsWith(`steam:${id}:icon:`) ? r.icon : null;
        recent.push({ name, description: text(r.description, 200), unlockedOn: day(r.unlocked_on), icon });
        if (recent.length >= 3) break;
    }
    return { appId: id, game, unlocked, total, recent };
}

export function readSteamActivity(raw: unknown): SteamActivity | null {
    const o = obj(raw);
    if (!o) return null;
    const isPrivate = o.private === true;
    const gamesPrivate = !isPrivate && o.games_private === true;
    const hidden = isPrivate || gamesPrivate;
    const np = obj(o.now_playing);
    const npName = text(np?.name, 100);
    const npId = appId(np?.app_id);
    const recent: SteamRecentGame[] = [];
    if (!hidden && Array.isArray(o.recent)) {
        for (const g of o.recent) {
            const r = obj(g);
            const id = appId(r?.app_id);
            const name = text(r?.name, 100);
            if (!r || id === null || !name) continue;
            recent.push({
                appId: id, name,
                minutes2w: count(r.minutes_2w, 20_160) ?? 0,
                minutesTotal: count(r.minutes_total) ?? 0,
                art: readArt(r.art, id) ?? NO_ART,
            });
            if (recent.length >= 5) break;
        }
    }
    const topGames: SteamTopGame[] = [];
    if (!hidden && Array.isArray(o.top_games)) {
        for (const g of o.top_games) {
            const r = obj(g);
            const id = appId(r?.app_id);
            const name = text(r?.name, 100);
            const mins = count(r?.minutes_total);
            if (!r || id === null || !name || mins === null) continue;
            topGames.push({ appId: id, name, minutesTotal: mins, art: readArt(r.art, id) ?? NO_ART });
            if (topGames.length >= 3) break;
        }
    }
    return {
        private: isPrivate,
        gamesPrivate,
        level: count(o.level, 10_000),
        xp: isPrivate ? null : readXp(o.xp),
        badgeCount: isPrivate ? null : count(o.badge_count, 100_000),
        memberSince: month(o.member_since),
        gameCount: hidden ? null : count(o.game_count, 1_000_000),
        totalMinutes: hidden ? null : count(o.total_minutes, 1e9),
        topGames,
        nowPlaying: !isPrivate && npName ? { appId: npId, name: npName, art: readArt(np!.art, npId) } : null,
        recent,
        achievements: hidden ? null : readAchievements(o.achievements),
    };
}

/** Whole years since a 'YYYY-MM' month (0 in the first year). */
export function yearsSince(memberSince: string | null, now: Date = new Date()): number | null {
    if (!memberSince) return null;
    const [y, m] = memberSince.split('-').map(Number);
    const months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
    return months >= 0 ? Math.floor(months / 12) : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM' -> "Mar 2012". */
export const formatMonth = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ''} ${ym.slice(0, 4)}`.trim();
/** 'YYYY-MM-DD' -> "Oct 21". */
export const formatDay = (d: string): string => `${MONTHS[Number(d.slice(5, 7)) - 1] ?? ''} ${Number(d.slice(8, 10))}`;

/** What Steam is hiding, as one line; null when nothing is. */
export function steamPrivacyText(a: SteamActivity, isSelf: boolean): string | null {
    if (a.private) {
        return isSelf
            ? 'Your Steam profile is private, so only your level can show. In Steam, open your profile, Edit Profile > Privacy Settings, and set My profile to Public and Game details to Public.'
            : 'Their Steam profile is private.';
    }
    if (a.gamesPrivate) {
        return isSelf
            ? 'Your Steam game details are private, so games, hours and achievements cannot show. In Steam: Edit Profile > Privacy Settings > Game details: Public.'
            : 'Their Steam game details are private.';
    }
    if (isSelf && a.totalMinutes === 0 && (a.gameCount ?? 0) > 0) {
        return 'Steam hides your playtime. In Steam: Edit Profile > Privacy Settings, untick "Always keep my total playtime private".';
    }
    return null;
}

/** "1,840 h" for all-time totals (whole hours; under an hour reads in minutes). */
export function formatHours(minutes: number): string {
    return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60).toLocaleString('en-US')} h`;
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
