/**
 * TikTok videos for the sender-side unfurler (pure parsing).
 *
 * Checked LIVE on 2026-11-23 (fixtures __fixtures__/providers/tiktok-*):
 *   - www.tiktok.com/oembed?url=…  answers 200 JSON, but TODAY without
 *     title, author_name or thumbnail_url (only type, size, provider and the
 *     embed html naming www.tiktok.com/player/v1/<id>), for every video tried
 *     and with several user agents. The adapter still reads those fields
 *     first, in case TikTok puts them back.
 *   - The video page (www.tiktok.com/@<user>/video/<id>, ~400 KB) carries a
 *     `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON script with
 *     webapp.video-detail.itemInfo.itemStruct: desc (the caption), author
 *     (uniqueId, nickname, avatar), createTime, video width / height /
 *     duration / cover (a signed p16/p19-*.tiktokcdn-us.com image). That is
 *     what fills the card when oEmbed is bare. The script ends ~395 KB in,
 *     inside the 512 KB HTML cap; a page past it gets the bare card.
 *   - Playback: the TikTok player frame (www.tiktok.com/player/v1/<id>), on
 *     click; the video file itself is never fetched.
 */
import { cleanText } from '../media-embed/youtube-oembed';

export function tikTokOEmbedUrl(pageUrl: string): string {
    return `https://www.tiktok.com/oembed?url=${encodeURIComponent(pageUrl)}`;
}

export function tikTokPageHostAllowed(h: string): boolean {
    return h === 'www.tiktok.com' || h === 'tiktok.com' || h === 'm.tiktok.com' || h === 'vm.tiktok.com' || h === 'vt.tiktok.com';
}
/** TikTok's image CDNs (covers, avatars). */
export function tikTokImageHostAllowed(h: string): boolean {
    return /^[a-z0-9-]+\.tiktokcdn(?:-us|-eu)?\.com$/.test(h);
}

export interface TikTokFacts {
    id?: string;
    caption?: string;
    author?: string;
    handle?: string;
    coverUrl?: string;
    avatarUrl?: string;
    width?: number;
    height?: number;
    durationS?: number;
    createdAt?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : undefined);
const img = (v: unknown): string | undefined => {
    if (typeof v !== 'string' || v.length > 2048) return undefined;
    try {
        const u = new URL(v);
        return u.protocol === 'https:' && tikTokImageHostAllowed(u.hostname.toLowerCase()) ? u.href : undefined;
    } catch { return undefined; }
};

/** oEmbed JSON → whatever it still says (title, author, thumbnail, the video id). */
export function parseTikTokOEmbed(body: string): TikTokFacts | null {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return null; }
    if (!isObj(j)) return null;
    const id = str(j.embed_product_id);
    const handle = /^https:\/\/www\.tiktok\.com\/@([A-Za-z0-9_.]{1,30})$/.exec(str(j.author_url) ?? '')?.[1];
    return {
        ...(id && /^\d{10,25}$/.test(id) ? { id } : {}),
        ...(str(j.title) ? { caption: cleanText(j.title, 700) || undefined } : {}),
        ...(str(j.author_name) ? { author: cleanText(j.author_name, 120) || undefined } : {}),
        ...(handle ? { handle } : {}),
        ...(img(j.thumbnail_url) ? { coverUrl: img(j.thumbnail_url) } : {}),
    };
}

/** The video page's rehydration JSON → the card's facts; null when it is not there (or not a video). */
export function parseTikTokPage(html: string): TikTokFacts | null {
    const m = /<script\b[^>]*id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (!m || m[1].length > 1_000_000) return null;
    let j: unknown;
    try { j = JSON.parse(m[1]); } catch { return null; }
    const scope = isObj(j) && isObj(j.__DEFAULT_SCOPE__) ? j.__DEFAULT_SCOPE__ : null;
    const detail = scope && isObj(scope['webapp.video-detail']) ? scope['webapp.video-detail'] : null;
    const item = detail && isObj(detail.itemInfo) && isObj(detail.itemInfo.itemStruct) ? detail.itemInfo.itemStruct : null;
    if (!item) return null;
    const video = isObj(item.video) ? item.video : {};
    const author = isObj(item.author) ? item.author : {};
    const id = str(item.id);
    const handle = str(author.uniqueId);
    const created = num(item.createTime);
    return {
        ...(id && /^\d{10,25}$/.test(id) ? { id } : {}),
        ...(str(item.desc) ? { caption: cleanText(item.desc, 700) || undefined } : {}),
        ...(str(author.nickname) ? { author: cleanText(author.nickname, 120) || undefined } : {}),
        ...(handle && /^[A-Za-z0-9_.]{1,30}$/.test(handle) ? { handle } : {}),
        ...(img(video.cover) ?? img(video.originCover) ? { coverUrl: img(video.cover) ?? img(video.originCover) } : {}),
        ...(img(author.avatarMedium) ?? img(author.avatarThumb) ? { avatarUrl: img(author.avatarMedium) ?? img(author.avatarThumb) } : {}),
        ...(num(video.width) && num(video.height) ? { width: num(video.width), height: num(video.height) } : {}),
        ...(num(video.duration) ? { durationS: num(video.duration) } : {}),
        ...(created && created > 1.1e9 && created < 4e9 ? { createdAt: new Date(created * 1000).toISOString().replace(/\.000Z$/, 'Z') } : {}),
    };
}

/** "Scramble up ur name & I'll try… #foryoupage #aesthetic" → a title without the trailing hashtag run. */
export function tikTokTitle(caption: string | undefined): string | undefined {
    if (!caption) return undefined;
    const t = caption.replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, '').trim();
    return (t || caption).slice(0, 256);
}
