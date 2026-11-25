/**
 * Reads the playable video a clip PAGE publishes (pure; fixture-tested against
 * pages saved live, __fixtures__/).
 *
 * Sources, in order of trust:
 *   1. JSON-LD `VideoObject.contentUrl` (Medal's is the real file, smaller than
 *      its og:video "social" render);
 *   2. `og:video:secure_url`, `og:video`, `og:video:url`;
 *   3. `twitter:player:stream`.
 * A candidate must be https, on the provider's media hosts (clip-links.ts),
 * and look like a video: a .mp4/.webm/.mov path, or a declared video type on
 * an extension-less path (Medal's redirecting API URL). A path with an image
 * extension never counts (Imgur's page labels a .gif as video/mp4). File-
 * extension candidates rank before extension-less ones.
 *
 * Nothing here is rendered as HTML: the page is only scanned for these tags.
 */
import { mediaHostAllowed, type ClipProvider } from './clip-links';
import { cleanText } from './youtube-oembed';

export interface ClipMedia {
    url: string;
    width?: number;
    height?: number;
    /** The page's own title, cleaned for display (plain text, bounded). */
    title?: string;
}

/** og:title / twitter:title without the provider's boilerplate, or undefined. */
export function clipTitle(raw: string | undefined, provider: ClipProvider): string | undefined {
    let t = cleanText(raw ?? '', 300);
    if (provider === 'medal') t = t.replace(/\s+-\s+Clipped .{1,80} with Medal\.tv$/i, '');
    if (provider === 'streamable') t = t.replace(/^Watch "(.*)" \| Streamable$/i, '$1');
    if (provider === 'tenor') t = t.replace(/\s+-\s+Discover & Share GIFs$/i, '');
    t = cleanText(t, 120);
    return t || undefined;
}

const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov)$/i;
const IMAGE_EXT_RE = /\.(gif|gifv|jpe?g|png|webp|avif|bmp)$/i;
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (all, body: string) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
        }
        return ENTITIES[body.toLowerCase()] ?? all;
    });
}

function attrsOf(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag)) !== null) {
        const k = m[1].toLowerCase();
        if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    return out;
}

/** Every `<meta property|name=… content=…>` in document order, keys lower-cased. */
export function metaTags(html: string): { key: string; content: string }[] {
    const out: { key: string; content: string }[] = [];
    const re = /<meta\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const a = attrsOf(m[0]);
        const key = (a.property ?? a.name ?? a.itemprop ?? '').trim().toLowerCase();
        if (key && typeof a.content === 'string') out.push({ key, content: a.content.trim() });
    }
    return out;
}

/** `contentUrl` of every VideoObject in the page's JSON-LD blocks. */
export function jsonLdVideoUrls(html: string): string[] {
    const out: string[] = [];
    const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    let blocks = 0;
    while ((m = re.exec(html)) !== null && blocks++ < 16) {
        let data: unknown;
        try { data = JSON.parse(m[1]); } catch { continue; }
        // Breadth-first, bounded, in document order.
        const queue: unknown[] = [data];
        for (let i = 0; i < queue.length && i < 500; i++) {
            const node = queue[i];
            if (Array.isArray(node)) { queue.push(...node); continue; }
            if (!node || typeof node !== 'object') continue;
            const o = node as Record<string, unknown>;
            const type = o['@type'];
            const isVideo = type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'));
            if (isVideo && typeof o.contentUrl === 'string') out.push(o.contentUrl);
            for (const v of Object.values(o)) if (v && typeof v === 'object') queue.push(v);
        }
    }
    return out;
}

function int(v: string | undefined): number | undefined {
    if (!v || !/^\d{1,5}$/.test(v)) return undefined;
    const n = Number(v);
    return n > 0 ? n : undefined;
}

/** The video to play for `provider`'s page, or null when it publishes none we accept. */
export function parseClipPage(html: string, provider: ClipProvider): ClipMedia | null {
    const metas = metaTags(html);
    const typeFor = new Map<string, string>();
    const candidates: { url: string; declared?: string }[] = [];
    for (const u of jsonLdVideoUrls(html)) candidates.push({ url: u });
    // og:video* in order, pairing each URL with the og:video:type that follows it.
    let lastOg: string | null = null;
    for (const { key, content } of metas) {
        if (key === 'og:video' || key === 'og:video:url' || key === 'og:video:secure_url') {
            candidates.push({ url: content });
            lastOg = content;
        } else if (key === 'og:video:type' && lastOg) {
            typeFor.set(lastOg, content.toLowerCase());
        }
    }
    for (const { key, content } of metas) if (key === 'twitter:player:stream') candidates.push({ url: content });
    for (const { key, content } of metas) {
        if (key === 'twitter:player:stream:content_type') {
            for (const c of candidates) if (!typeFor.has(c.url)) typeFor.set(c.url, content.toLowerCase());
        }
    }

    const ok: { url: string; ext: boolean }[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
        let u: URL;
        try { u = new URL(c.url); } catch { continue; }
        if (u.protocol !== 'https:' || u.username || u.password || u.port) continue;
        if (!mediaHostAllowed(provider, u.hostname)) continue;
        if (u.href.length > 2048 || seen.has(u.href)) continue;
        if (IMAGE_EXT_RE.test(u.pathname)) continue;
        const ext = VIDEO_EXT_RE.test(u.pathname);
        const declared = typeFor.get(c.url);
        if (!ext && !(declared && VIDEO_TYPES.has(declared.split(';')[0].trim()))) continue;
        seen.add(u.href);
        ok.push({ url: u.href, ext });
    }
    const best = ok.find((c) => c.ext) ?? ok[0];
    if (!best) return null;
    const get = (k: string) => metas.find((m) => m.key === k)?.content;
    return {
        url: best.url,
        width: int(get('og:video:width')),
        height: int(get('og:video:height')),
        title: clipTitle(get('og:title') ?? get('twitter:title'), provider),
    };
}
