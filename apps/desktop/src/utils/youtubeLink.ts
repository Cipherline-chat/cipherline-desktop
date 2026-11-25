/**
 * The YouTube video a message link points at, or null.
 *
 * A link only produces an inline player when it is really a YouTube link: the
 * host must be one of YouTube's own (youtube.com, www.youtube.com,
 * m.youtube.com, music.youtube.com, youtu.be) over http(s). The patterns this
 * replaced matched anywhere in the URL, so a link to any site carrying
 * `?v=<11 chars>` (or a `/embed/…` path) rendered as a YouTube embed,
 * presenting another site's link as a YouTube video.
 *
 * Shared by the chat (components/embeds/YouTubeEmbed) and the pinned-messages panel.
 */

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** A start offset past this is not a real timestamp; ignore it. */
const MAX_START_S = 48 * 3600;

export interface YouTubeLink {
    id: string;
    /** Seconds from `?t=` / `&start=` / `#t=`, or 0. */
    start: number;
    /** A /shorts/ link: a vertical 9:16 player. */
    short: boolean;
}

/** `t` / `start` value → whole seconds: `90`, `90s`, `1m30s`, `1h2m3s`. 0 when malformed. */
export function parseYouTubeTime(raw: string | null | undefined): number {
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

export function parseYouTubeLink(raw: string): YouTubeLink | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean);
    let id: string | null = null;
    let short = false;
    if (host === 'youtu.be') {
        id = segs[0] ?? null;
    } else if (YT_HOSTS.has(host)) {
        if (segs[0] === 'watch') id = u.searchParams.get('v');
        else if ((segs[0] === 'embed' || segs[0] === 'shorts' || segs[0] === 'live') && segs[1]) {
            id = segs[1];
            short = segs[0] === 'shorts';
        }
    }
    if (!id || !ID_RE.test(id)) return null;
    const hashT = new URLSearchParams(u.hash.replace(/^#/, '')).get('t');
    const start = parseYouTubeTime(u.searchParams.get('t') ?? u.searchParams.get('start') ?? hashT);
    return { id, start, short };
}

export function extractYouTubeId(raw: string): string | null {
    return parseYouTubeLink(raw)?.id ?? null;
}

/**
 * The privacy-enhanced player URL, built from the parsed id only (never from
 * the message's own URL). Mounted only after the user clicks play, so it
 * autoplays.
 */
export function youTubeEmbedSrc(link: YouTubeLink, origin: string): string {
    const q = new URLSearchParams({ autoplay: '1', origin });
    if (link.start > 0) q.set('start', String(link.start));
    return `https://www.youtube-nocookie.com/embed/${link.id}?${q.toString()}`;
}

/** Thumbnail candidates, best first: hqdefault (480×360), then mqdefault (320×180). */
export function youTubeThumbUrls(id: string): string[] {
    return [`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, `https://i.ytimg.com/vi/${id}/mqdefault.jpg`];
}
