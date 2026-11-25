/**
 * The playable media a web PAGE publishes about itself (pure; 2026-11-24,
 * embeds-media-everywhere). Any host, not only the known clip providers:
 *
 *   video    og:video:secure_url / og:video / og:video:url (each paired with
 *            the og:video:type / :width / :height that follow it),
 *            twitter:player:stream (+ :content_type), JSON-LD VideoObject
 *            contentUrl. Only a real FILE counts: video/mp4 | webm | quicktime
 *            by its declared type or by its extension; an og:video that is an
 *            HTML player page (YouTube's /embed/, text/html) is not one.
 *   animated an og:image / twitter:image that is a GIF (image/gif, or .gif),
 *            paired with its own width / height; JSON-LD ImageObject contentUrl
 *            ending in .gif.
 *
 * GIF pages (KLIPY, Tenor, Giphy, Imgur, …) publish both a GIF and an mp4 of
 * it; the unfurler decides which one to use (unfurl.ts). Every URL leaving
 * here is a checked https URL.
 */
import { metaTags, jsonLdVideoUrls } from '../media-embed/clip-page';
import { absHttps } from './parse-page';

export interface PageMediaFile {
    url: string;
    mime?: 'video/mp4' | 'video/webm' | 'video/quicktime' | 'image/gif';
    width?: number;
    height?: number;
}

export interface PageMedia {
    video?: PageMediaFile;
    gif?: PageMediaFile;
}

const VIDEO_EXT: Record<string, PageMediaFile['mime']> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);

const int = (v: string | undefined): number | undefined => (v && /^\d{1,5}$/.test(v.trim()) && Number(v) > 0 ? Number(v) : undefined);
const extOf = (u: string): string => { try { return (/\.([a-z0-9]{2,4})$/i.exec(new URL(u).pathname)?.[1] ?? '').toLowerCase(); } catch { return ''; } };

function videoMime(url: string, declared: string | undefined): PageMediaFile['mime'] | undefined {
    const t = (declared ?? '').split(';')[0].trim().toLowerCase();
    if (t) {
        if (!VIDEO_TYPES.has(t)) return undefined; // text/html, application/x-shockwave-flash, …
        return t === 'video/x-m4v' ? 'video/mp4' : (t as PageMediaFile['mime']);
    }
    return VIDEO_EXT[extOf(url)];
}

/** `contentUrl` of every ImageObject in the page's JSON-LD that is a .gif (bounded). */
function jsonLdGifUrls(html: string): string[] {
    const out: string[] = [];
    const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    let blocks = 0;
    while ((m = re.exec(html)) !== null && blocks++ < 16) {
        if (m[1].length > 200_000) continue;
        let data: unknown;
        try { data = JSON.parse(m[1]); } catch { continue; }
        const queue: unknown[] = [data];
        for (let i = 0; i < queue.length && i < 500; i++) {
            const node = queue[i];
            if (Array.isArray(node)) { queue.push(...node.slice(0, 50)); continue; }
            if (!node || typeof node !== 'object') continue;
            const o = node as Record<string, unknown>;
            const t = o['@type'];
            const isImage = t === 'ImageObject' || (Array.isArray(t) && t.includes('ImageObject'));
            if (isImage && typeof o.contentUrl === 'string' && extOf(o.contentUrl) === 'gif') out.push(o.contentUrl);
            for (const v of Object.values(o)) if (v && typeof v === 'object') queue.push(v);
        }
    }
    return out;
}

export function pageMedia(html: string, pageUrl: string): PageMedia {
    const metas = metaTags(html);
    const out: PageMedia = {};

    // ── video: og:video* groups in order (a URL key starts a group) ──
    type Group = { url: string; type?: string; width?: string; height?: string };
    const vids: Group[] = [];
    for (const { key, content } of metas) {
        if (key === 'og:video' || key === 'og:video:url' || key === 'og:video:secure_url') {
            const last = vids.at(-1);
            // og:video then og:video:secure_url for the same file are one group.
            if (last && (last.url === content || (key === 'og:video:secure_url' && !last.type))) { last.url = content; continue; }
            vids.push({ url: content });
        } else if (vids.length) {
            const g = vids.at(-1)!;
            if (key === 'og:video:type') g.type ??= content;
            else if (key === 'og:video:width') g.width ??= content;
            else if (key === 'og:video:height') g.height ??= content;
        }
    }
    const streamType = metas.find((x) => x.key === 'twitter:player:stream:content_type')?.content;
    for (const { key, content } of metas) if (key === 'twitter:player:stream') vids.push({ url: content, type: streamType });
    for (const u of jsonLdVideoUrls(html)) vids.push({ url: u });
    for (const g of vids) {
        const url = absHttps(g.url, pageUrl);
        if (!url) continue;
        const mime = videoMime(url, g.type);
        if (!mime) continue;
        out.video = { url, mime, ...(int(g.width) && int(g.height) ? { width: int(g.width), height: int(g.height) } : {}) };
        break;
    }

    // ── animated picture: an og:image / twitter:image that is a GIF ──
    type Img = { url: string; type?: string; width?: string; height?: string };
    const imgs: Img[] = [];
    for (const { key, content } of metas) {
        const base = key.startsWith('og:image') ? 'og:image' : key.startsWith('twitter:image') ? 'twitter:image' : null;
        if (!base) continue;
        const sub = key.slice(base.length);
        if (sub === '' || sub === ':url' || sub === ':secure_url' || sub === ':src') {
            const last = imgs.at(-1);
            if (last && sub === ':secure_url' && !last.type) { last.url = content; continue; }
            imgs.push({ url: content });
        } else if (imgs.length) {
            const g = imgs.at(-1)!;
            if (sub === ':type') g.type ??= content;
            else if (sub === ':width') g.width ??= content;
            else if (sub === ':height') g.height ??= content;
        }
    }
    for (const u of jsonLdGifUrls(html)) imgs.push({ url: u });
    for (const g of imgs) {
        const url = absHttps(g.url, pageUrl);
        if (!url) continue;
        const t = (g.type ?? '').toLowerCase();
        if (t ? t !== 'image/gif' : extOf(url) !== 'gif') continue;
        out.gif = { url, mime: 'image/gif', ...(int(g.width) && int(g.height) ? { width: int(g.width), height: int(g.height) } : {}) };
        break;
    }
    return out;
}

/** Sites whose pages ARE one GIF: their page link is drawn as that GIF, not as a web card. */
const GIF_PAGE_HOSTS = ['klipy.com', 'tenor.com', 'giphy.com', 'imgur.com', 'gfycat.com', 'redgifs.com', 'gifer.com', 'gifdb.com', 'imgflip.com', 'makeagif.com', 'reactiongifs.com', 'gyazo.com'];

export function isGifPageHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^www\./, '');
    return GIF_PAGE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** A KLIPY web page (klipy.com/gifs/<slug>, /stickers/<slug>, /clips/<slug>, /memes/<slug>, …). */
export function isKlipyPageUrl(raw: string): boolean {
    try {
        const u = new URL(raw);
        const h = u.hostname.toLowerCase();
        return u.protocol === 'https:' && (h === 'klipy.com' || h === 'www.klipy.com') && /^\/[a-z-]+\/[^/]+/i.test(u.pathname);
    } catch { return false; }
}
