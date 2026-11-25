/**
 * Reddit posts for the sender-side unfurler (pure parsing).
 *
 * Checked LIVE on 2026-11-23 from the dev box:
 *   - www.reddit.com/oembed?url=<post>  works without auth: author_name,
 *     title, and an html blockquote whose links name the subreddit
 *     (fixture __fixtures__/providers/reddit-oembed.json). No picture, score
 *     or flags. This is what every Reddit card has.
 *   - The post's `.json` (www.reddit.com/comments/<id>/.json), old.reddit,
 *     api.reddit.com, embed.reddit.com and the HTML page all answered 403
 *     "You've been blocked by network security" from this network (also from a
 *     real headless Chromium and a TLS-impersonating client, so it is an
 *     address block, not a client fingerprint), and .rss answered 429. The
 *     .json is still tried (a sender on another network gets the picture,
 *     gallery, video, score, comments and the NSFW / spoiler flags), and
 *     a refusal falls back to the oEmbed card. Its parser
 *     (parseRedditPostJson) is tested against a fixture SHAPED from Reddit's
 *     documented listing format (reddit-post-*.json), NOT a live capture —
 *     the live format could not be fetched to save.
 *   - RECHECKED 2026-11-23 (embeds fixes): with the link-preview UA
 *     ("WhatsApp/2", pinned-fetch.ts EMBED_PREVIEW_UA) old.reddit.com answers
 *     the post .json (200, the full listing; fixtures reddit-live-*.json are
 *     live captures), and the post PAGE answers with its og:title / og:image
 *     (share.redd.it/preview/post/<id>: a picture of the post) /
 *     description. www's .json still answers 403 to both UAs. So: www .json →
 *     old.reddit .json (preview UA) → oEmbed words, and after that the shared
 *     page fallback (unfurl.ts withPageFallback) adds the page's picture to a
 *     card that still has none.
 *   - Video: v.redd.it's `fallback_url` (DASH_<n>.mp4) is video-only; the
 *     sound is a separate DASH_AUDIO file and the HLS playlist is the only
 *     muxed rendition. Readers play the mp4 muted with an "Open on Reddit for
 *     sound" note (media.no_audio); nothing on Reddit could be played live
 *     from this network.
 */
import { cleanText } from '../media-embed/youtube-oembed';

export function redditOEmbedUrl(postUrl: string): string {
    return `https://www.reddit.com/oembed?url=${encodeURIComponent(postUrl)}`;
}
export function redditJsonUrl(id: string): string {
    return `https://www.reddit.com/comments/${encodeURIComponent(id)}/.json?raw_json=1&limit=1`;
}
/** The same post's .json on old.reddit.com (answers where www's is blocked; see the note above). */
export function redditOldJsonUrl(id: string): string {
    return `https://old.reddit.com/comments/${encodeURIComponent(id)}/.json?raw_json=1&limit=1`;
}
export function redditApiHostAllowed(h: string): boolean {
    return h === 'www.reddit.com' || h === 'reddit.com' || h === 'old.reddit.com';
}
export function redditImageHostAllowed(h: string): boolean {
    return h === 'i.redd.it' || h === 'preview.redd.it' || h === 'external-preview.redd.it' || h === 'b.thumbs.redditmedia.com' || h === 'a.thumbs.redditmedia.com'
        // The post page's own og:image (a picture of the post: its image, subreddit, votes).
        || h === 'share.redd.it';
}
export function redditVideoHostAllowed(h: string): boolean {
    return h === 'v.redd.it';
}

export interface RedditImage { url: string; width?: number; height?: number }

export interface RedditFacts {
    title?: string;
    author?: string;
    sub?: string;
    selftext?: string;
    score?: number;
    comments?: number;
    nsfw?: boolean;
    spoiler?: boolean;
    createdAt?: string;
    images: RedditImage[];
    video?: { url: string; width?: number; height?: number; durationS?: number; hasAudio: boolean };
    /** A link post: the page it links to. */
    linkUrl?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const hostUrl = (v: unknown, ok: (h: string) => boolean): string | undefined => {
    if (typeof v !== 'string' || v.length > 2048) return undefined;
    try {
        const u = new URL(v.replace(/&amp;/g, '&'));
        return u.protocol === 'https:' && !u.username && !u.port && ok(u.hostname.toLowerCase()) ? u.href : undefined;
    } catch { return undefined; }
};
const user = (v: unknown) => { const s = str(v); return s && /^[A-Za-z0-9_-]{3,20}$/.test(s) && s !== '[deleted]' ? s : undefined; };
const sub = (v: unknown) => { const s = str(v); return s && /^[A-Za-z0-9_]{2,21}$/.test(s) ? s : undefined; };

/** oEmbed → title, author, subreddit. */
export function parseRedditOEmbed(body: string): Pick<RedditFacts, 'title' | 'author' | 'sub'> | null {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return null; }
    if (!isObj(j)) return null;
    const title = cleanText(str(j.title) ?? '', 300) || undefined;
    const author = user(j.author_name);
    const s = sub(/href="https:\/\/www\.reddit\.com\/r\/([A-Za-z0-9_]{2,21})\/"/.exec(str(j.html) ?? '')?.[1]);
    if (!title && !author) return null;
    return { ...(title ? { title } : {}), ...(author ? { author } : {}), ...(s ? { sub: s } : {}) };
}

/** A gallery's pictures in the post's order (media_metadata + gallery_data). */
function galleryImages(post: Record<string, unknown>): RedditImage[] {
    const meta = isObj(post.media_metadata) ? post.media_metadata : null;
    const order = isObj(post.gallery_data) && Array.isArray(post.gallery_data.items) ? post.gallery_data.items : [];
    if (!meta) return [];
    const out: RedditImage[] = [];
    for (const it of order.slice(0, 20)) {
        const id = isObj(it) ? str(it.media_id) : undefined;
        const m = id && isObj(meta[id]) ? meta[id] as Record<string, unknown> : null;
        if (!m || m.status !== 'valid' || !(str(m.e) === 'Image' || str(m.e) === 'AnimatedImage')) continue;
        const previews = Array.isArray(m.p) ? m.p.filter(isObj) : [];
        // A ~640 px rendition is plenty for a card (the sender re-encodes to 920 px at most).
        const pick = previews.find((p) => (int(p.x) ?? 0) >= 640) ?? previews[previews.length - 1] ?? (isObj(m.s) ? m.s : null);
        const url = pick ? hostUrl(pick.u ?? pick.gif, redditImageHostAllowed) : undefined;
        if (url) out.push({ url, width: int(pick?.x), height: int(pick?.y) });
        if (out.length >= 4) break;
    }
    return out;
}

/** The post object out of `/comments/<id>/.json` (a two-listing array). */
function postOf(j: unknown): Record<string, unknown> | null {
    const first = Array.isArray(j) ? j[0] : j;
    const children = isObj(first) && isObj(first.data) && Array.isArray(first.data.children) ? first.data.children : [];
    const c = children.find((x) => isObj(x) && x.kind === 't3');
    return isObj(c) && isObj(c.data) ? c.data : null;
}

export function parseRedditPostJson(body: string): RedditFacts | null {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return null; }
    const p = postOf(j);
    if (!p) return null;
    const images: RedditImage[] = [];
    let video: RedditFacts['video'];
    const rv = isObj(p.secure_media) && isObj(p.secure_media.reddit_video) ? p.secure_media.reddit_video
        : isObj(p.media) && isObj(p.media.reddit_video) ? p.media.reddit_video : null;
    if (p.is_video === true && rv) {
        const url = hostUrl(rv.fallback_url, redditVideoHostAllowed);
        if (url) {
            const d = int(rv.duration);
            video = { url, width: int(rv.width), height: int(rv.height), ...(d && d > 0 ? { durationS: d } : {}), hasAudio: rv.has_audio === true };
        }
    }
    if (p.is_gallery === true) images.push(...galleryImages(p));
    const preview = isObj(p.preview) && Array.isArray(p.preview.images) && isObj(p.preview.images[0]) ? p.preview.images[0] : null;
    if (!images.length) {
        const direct = hostUrl(p.url_overridden_by_dest ?? p.url, (h) => h === 'i.redd.it');
        const src = preview && isObj(preview.source) ? preview.source : null;
        const res = preview && Array.isArray(preview.resolutions) ? preview.resolutions.filter(isObj) : [];
        const mid = res.find((r) => (int(r.width) ?? 0) >= 640) ?? src;
        if (direct && /\.(jpe?g|png|webp|gif)$/i.test(new URL(direct).pathname) && !video) {
            images.push({ url: direct, width: int(src?.width), height: int(src?.height) });
        } else if (mid) {
            const url = hostUrl(mid.url, redditImageHostAllowed);
            if (url) images.push({ url, width: int(mid.width), height: int(mid.height) });
        }
    }
    const created = typeof p.created_utc === 'number' ? p.created_utc : NaN;
    const linkUrl = p.is_self !== true && !video && !images.length ? hostUrl(p.url_overridden_by_dest ?? p.url, () => true) : undefined;
    const selftext = str(p.selftext);
    return {
        ...(cleanText(str(p.title) ?? '', 300) ? { title: cleanText(str(p.title), 300) } : {}),
        ...(user(p.author) ? { author: user(p.author) } : {}),
        ...(sub(p.subreddit) ? { sub: sub(p.subreddit) } : {}),
        ...(selftext && p.is_self === true ? { selftext: cleanText(selftext, 700) || undefined } : {}),
        ...(int(p.score) !== undefined ? { score: int(p.score) } : {}),
        ...(int(p.num_comments) !== undefined ? { comments: int(p.num_comments) } : {}),
        ...(p.over_18 === true ? { nsfw: true } : {}),
        ...(p.spoiler === true ? { spoiler: true } : {}),
        ...(Number.isFinite(created) && created > 1.1e9 ? { createdAt: new Date(Math.floor(created) * 1000).toISOString().replace(/\.000Z$/, 'Z') } : {}),
        images,
        ...(video ? { video } : {}),
        ...(linkUrl ? { linkUrl } : {}),
    };
}
