/**
 * Per-provider adapters for the sender-side unfurler (pure).
 *
 *   YouTube  the video id / start offset from the link (main's copy of the
 *            renderer's parseYouTubeLink; providers.parity.test.ts keeps them
 *            in step). Title + channel come from YouTube's public oEmbed, the
 *            thumbnail from i.ytimg.com. The page itself is never fetched.
 *   Medal    title without the "Clipped <game> with Medal.tv" boilerplate, the
 *            game (from that boilerplate, else the URL's /games/<slug>/), the
 *            duration (JSON-LD), the author (JSON-LD), the video file
 *            (clip-page.ts) and the thumbnail (og:image).
 *   Streamable / Imgur / Tenor   the phase-2 clip adapters (clip-links.ts,
 *            clip-page.ts) for the video, plus the page's own card metadata.
 */
import { cleanText } from '../media-embed/youtube-oembed';

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_START_S = 48 * 3600;

export interface YouTubeRef { id: string; start: number; short: boolean }

function ytTime(raw: string | null | undefined): number {
    if (!raw) return 0;
    const v = raw.trim().toLowerCase();
    let s = 0;
    if (/^\d{1,6}$/.test(v)) s = Number(v);
    else {
        const m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(v);
        if (!m || (!m[1] && !m[2] && !m[3])) return 0;
        s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
    }
    return Number.isFinite(s) && s > 0 && s <= MAX_START_S ? Math.floor(s) : 0;
}

/** The YouTube video a link names, or null (same rules as src/utils/youtubeLink.ts). */
export function youTubeRefOf(raw: unknown): YouTubeRef | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean);
    let id: string | null = null;
    let short = false;
    if (host === 'youtu.be') id = segs[0] ?? null;
    else if (YT_HOSTS.has(host)) {
        if (segs[0] === 'watch') id = u.searchParams.get('v');
        else if ((segs[0] === 'embed' || segs[0] === 'shorts' || segs[0] === 'live') && segs[1]) {
            id = segs[1];
            short = segs[0] === 'shorts';
        }
    }
    if (!id || !YT_ID_RE.test(id)) return null;
    const hashT = new URLSearchParams(u.hash.replace(/^#/, '')).get('t');
    return { id, start: ytTime(u.searchParams.get('t') ?? u.searchParams.get('start') ?? hashT), short };
}

/** Thumbnails to try for a YouTube video, best first: 1280x720 (no letterbox), then 320x180. */
export function youTubeThumbCandidates(id: string): string[] {
    if (!YT_ID_RE.test(id)) return [];
    return [`https://i.ytimg.com/vi/${id}/hq720.jpg`, `https://i.ytimg.com/vi/${id}/mqdefault.jpg`];
}

/** A game slug → display name: "valorant" → "Valorant", "rocket-league" → "Rocket League". */
export function gameFromSlug(slug: string): string | undefined {
    if (!/^[a-z0-9-]{2,64}$/i.test(slug)) return undefined;
    const name = slug.split('-').filter(Boolean).map((w) => (w.length <= 3 && /\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
    return cleanText(name, 40) || undefined;
}

export interface MedalFacts { title?: string; game?: string }

/** Medal's og:title is "<title> - Clipped <Game> with Medal.tv". */
export function medalFacts(ogTitle: string | undefined, pageUrl: string): MedalFacts {
    const raw = cleanText(ogTitle ?? '', 400);
    let title: string | undefined;
    let game: string | undefined;
    // The /clip/<id> page says "<title> - Clipped with Medal.tv" (no game).
    const m = /^(.*?)\s+-\s+Clipped\s+(?:(.{1,80}?)\s+)?with\s+Medal\.tv$/i.exec(raw);
    if (m) { title = m[1]; game = m[2] ? cleanText(m[2], 40) || undefined : undefined; } else if (raw) title = raw;
    if (!game) {
        try {
            const slug = /\/games\/([a-z0-9-]{2,64})\//i.exec(new URL(pageUrl).pathname)?.[1];
            if (slug) game = gameFromSlug(slug);
        } catch { /* no game */ }
    }
    return { title: title ? cleanText(title, 256) || undefined : undefined, game };
}
