/**
 * X / Twitter tweets for the sender-side unfurler (pure parsing).
 *
 * Checked LIVE on 2026-11-23 (fixtures __fixtures__/providers/x-*.json):
 *   - cdn.syndication.twimg.com/tweet-result?id=<id>&token=<t>  (the endpoint
 *     X's own embed widget uses; no key, no cookie). JSON with the author
 *     (name, screen_name, profile_image_url_https), text + entities,
 *     created_at, possibly_sensitive and `mediaDetails`: photos
 *     (pbs.twimg.com), videos and GIFs with mp4 variants on video.twimg.com
 *     (unsigned, Range OK, no referrer check; a GIF is one silent mp4).
 *     `token` is derived from the id the way the widget does it. A deleted /
 *     protected tweet answers `{"__typename":"TweetTombstone"}`; an unknown id
 *     answers an HTML 404.
 *   - publish.x.com/oembed?url=…  the fallback: author name + url and the
 *     text inside a blockquote (no media, no avatar).
 * The x.com page itself returns no tweet metadata to a non-logged-in client,
 * so it is never fetched.
 */
import { cleanText } from '../media-embed/youtube-oembed';

export interface TweetMedia { url: string; width?: number; height?: number }
export interface TweetVideo { url: string; width?: number; height?: number; durationS?: number; poster?: string; loop: boolean }

export interface TweetFacts {
    id: string;
    name: string;
    handle: string;
    avatarUrl?: string;
    /** Plain text: t.co links expanded, the trailing media link removed. */
    text: string;
    createdAt?: string;
    photos: TweetMedia[];
    video?: TweetVideo;
    sensitive: boolean;
}

/** The `token` X's embed widget sends with tweet-result (derived from the id). */
export function syndicationToken(id: string): string {
    return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export function syndicationUrl(id: string): string {
    return `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=${syndicationToken(id)}&lang=en`;
}

export function xOEmbedUrl(id: string, handle: string | null): string {
    const status = `https://x.com/${handle ?? 'i'}/status/${id}`;
    return `https://publish.x.com/oembed?url=${encodeURIComponent(status)}&omit_script=1&dnt=true`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const https = (v: unknown, hosts: (h: string) => boolean): string | undefined => {
    if (typeof v !== 'string' || v.length > 2048) return undefined;
    try {
        const u = new URL(v);
        return u.protocol === 'https:' && !u.username && !u.port && hosts(u.hostname.toLowerCase()) ? u.href : undefined;
    } catch { return undefined; }
};
const PBS = (h: string) => h === 'pbs.twimg.com';
const VIDEO = (h: string) => h === 'video.twimg.com';

/** A bigger avatar than the 48 px `_normal` one (X serves _200x200 for the same picture). */
function avatarOf(v: unknown): string | undefined {
    const u = https(v, PBS);
    return u ? u.replace(/_normal(\.[a-z]{3,4})$/i, '_200x200$1') : undefined;
}

/** A photo's URL at a card-sized rendition. */
function photoUrl(v: unknown): string | undefined {
    const u = https(v, PBS);
    if (!u) return undefined;
    const p = new URL(u);
    const m = /\.(jpg|jpeg|png|webp)$/i.exec(p.pathname);
    if (m) {
        p.pathname = p.pathname.slice(0, -m[0].length);
        p.search = `?format=${m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()}&name=medium`;
    }
    return p.href;
}

/** Text as shown: within display_text_range, t.co links expanded, &amp; etc. decoded. */
function tweetText(j: Record<string, unknown>): string {
    let text = str(j.text) ?? '';
    const range = Array.isArray(j.display_text_range) ? j.display_text_range : null;
    const chars = Array.from(text);
    if (range && typeof range[1] === 'number' && range[1] >= 0 && range[1] <= chars.length) {
        text = chars.slice(typeof range[0] === 'number' && range[0] > 0 ? range[0] : 0, range[1]).join('');
    }
    const ents = isObj(j.entities) ? j.entities : {};
    for (const e of Array.isArray(ents.urls) ? ents.urls : []) {
        if (!isObj(e)) continue;
        const short = str(e.url);
        const full = str(e.expanded_url);
        if (short && full && /^https?:\/\//.test(full)) text = text.split(short).join(full);
    }
    // Any remaining t.co link is the media link (or a quoted tweet's): it says nothing a reader can use.
    text = text.replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, '');
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return text.trim();
}

/** The best mp4 for an inline player: the highest bitrate up to ~2.5 Mb/s (720p), else the smallest. */
function pickMp4(variants: unknown): string | undefined {
    const mp4s = (Array.isArray(variants) ? variants : [])
        .filter(isObj)
        .map((v) => ({ url: https(v.url ?? v.src, VIDEO), type: str(v.content_type ?? v.type), bitrate: typeof v.bitrate === 'number' ? v.bitrate : 0 }))
        .filter((v): v is { url: string; type: string; bitrate: number } => !!v.url && v.type === 'video/mp4');
    if (!mp4s.length) return undefined;
    const ok = mp4s.filter((v) => v.bitrate <= 2_600_000).sort((a, b) => b.bitrate - a.bitrate);
    return (ok[0] ?? mp4s.sort((a, b) => a.bitrate - b.bitrate)[0]).url;
}

const ISO = (v: unknown): string | undefined => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.000Z$/, 'Z') : undefined;
};

/** tweet-result JSON → facts; null for a tombstone, an error page, or anything unexpected. */
export function parseTweetResult(body: string): TweetFacts | null {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return null; }
    if (!isObj(j) || j.__typename !== 'Tweet') return null;
    const user = isObj(j.user) ? j.user : null;
    const id = str(j.id_str);
    const handle = str(user?.screen_name);
    if (!id || !/^\d{1,20}$/.test(id) || !handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
    const photos: TweetMedia[] = [];
    let video: TweetVideo | undefined;
    for (const m of Array.isArray(j.mediaDetails) ? j.mediaDetails.slice(0, 4) : []) {
        if (!isObj(m)) continue;
        const info = isObj(m.original_info) ? m.original_info : {};
        const width = typeof info.width === 'number' ? info.width : undefined;
        const height = typeof info.height === 'number' ? info.height : undefined;
        if (m.type === 'photo') {
            const url = photoUrl(m.media_url_https);
            if (url) photos.push({ url, width, height });
        } else if ((m.type === 'video' || m.type === 'animated_gif') && !video) {
            const vi = isObj(m.video_info) ? m.video_info : {};
            const url = pickMp4(vi.variants);
            if (!url) continue;
            const ms = typeof vi.duration_millis === 'number' ? vi.duration_millis : 0;
            video = {
                url, width, height, loop: m.type === 'animated_gif',
                ...(ms > 0 ? { durationS: Math.round(ms / 10) / 100 } : {}),
                ...(https(m.media_url_https, PBS) ? { poster: https(m.media_url_https, PBS) } : {}),
            };
        }
    }
    return {
        id,
        name: cleanText(str(user?.name) ?? handle, 120) || handle,
        handle,
        ...(avatarOf(user?.profile_image_url_https) ? { avatarUrl: avatarOf(user?.profile_image_url_https) } : {}),
        text: tweetText(j),
        ...(ISO(j.created_at) ? { createdAt: ISO(j.created_at) } : {}),
        photos,
        ...(video ? { video } : {}),
        sensitive: j.possibly_sensitive === true,
    };
}

const decodeEntities = (s: string) => s
    .replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d{1,6});/g, (_, n) => {
        const c = Number(n);
        return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '';
    });

/**
 * publish.x.com oEmbed → name, handle and text (the first <p> of the
 * blockquote, tags dropped). Only ever turned into plain text here.
 */
export function parseXOEmbed(body: string): { name: string; handle: string; text: string } | null {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return null; }
    if (!isObj(j)) return null;
    const name = cleanText(str(j.author_name) ?? '', 120);
    let handle: string | undefined;
    try { handle = new URL(str(j.author_url) ?? '').pathname.split('/').filter(Boolean)[0]; } catch { /* none */ }
    if (!name || !handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(str(j.html) ?? '')?.[1] ?? '';
    const text = decodeEntities(p.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, '').trim();
    return { name, handle, text };
}
