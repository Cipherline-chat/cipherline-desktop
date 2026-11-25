/**
 * Reads a web page's preview metadata (pure; fixture-tested against pages
 * saved live, __fixtures__/). docs/plans/embeds.md §5.
 *
 * Sources, best first for each field:
 *   title        og:title, twitter:title, JSON-LD headline/name, <title>
 *   description  og:description, twitter:description, <meta name=description>, JSON-LD description
 *   site         og:site_name, application-name, JSON-LD publisher.name
 *   author       article:author / author meta (not a URL), JSON-LD author.name
 *   image        og:image:secure_url, og:image(:url), twitter:image(:src), JSON-LD image / thumbnailUrl
 *   colour       theme-color (the first one; #rgb or #rrggbb only)
 *   oEmbed       <link rel=alternate type=application/json+oembed href=…>
 *   duration     JSON-LD VideoObject duration (ISO 8601)
 *
 * The page is only SCANNED for these tags with bounded regular expressions.
 * Nothing is ever rendered as HTML, no script runs, and every value that
 * leaves here is plain text (cleanText) or a checked https URL.
 */
import { decodeEntities, metaTags } from '../media-embed/clip-page';
import { cleanText } from '../media-embed/youtube-oembed';

export interface PageImage {
    url: string;
    width?: number;
    height?: number;
}

export interface PageMeta {
    title?: string;
    description?: string;
    site?: string;
    author?: string;
    color?: string;
    image?: PageImage;
    /** twitter:card = summary_large_image (a hint: wide picture under the text). */
    largeImage: boolean;
    oembedUrl?: string;
    durationS?: number;
    /** og:type (lower-case), e.g. article, video.other. */
    type?: string;
}

const FIELD = { title: 256, description: 350, site: 80, author: 120 } as const;

/** An https URL (relative ones resolved against the page) without credentials or a port. */
export function absHttps(raw: string | undefined, base: string): string | undefined {
    if (!raw) return undefined;
    const v = raw.trim();
    if (!v || v.length > 2048) return undefined;
    let u: URL;
    try { u = new URL(v, base); } catch { return undefined; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return undefined;
    return u.href.length > 2048 ? undefined : u.href;
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

/** `<link …>` attributes in document order (bounded). */
export function linkTags(html: string): Record<string, string>[] {
    const out: Record<string, string>[] = [];
    const re = /<link\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < 400) out.push(attrsOf(m[0]));
    return out;
}

/** `<title>` text, entity-decoded. */
export function htmlTitle(html: string): string | undefined {
    const m = /<title\b[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(html);
    return m ? decodeEntities(m[1]) : undefined;
}

/** ISO 8601 duration (PT1H2M3.5S, P0DT…) → seconds, or undefined. */
export function isoDurationSeconds(v: unknown): number | undefined {
    if (typeof v !== 'string') return undefined;
    const m = /^P(?:(\d{1,3})D)?(?:T(?:(\d{1,3})H)?(?:(\d{1,4})M)?(?:(\d{1,6}(?:\.\d{1,3})?)S)?)?$/i.exec(v.trim());
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
    const s = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
    return Number.isFinite(s) && s > 0 && s <= 86400 ? Math.round(s * 100) / 100 : undefined;
}

function int(v: unknown): number | undefined {
    const s = typeof v === 'number' ? String(v) : v;
    if (typeof s !== 'string' || !/^\d{1,5}$/.test(s.trim())) return undefined;
    const n = Number(s);
    return n > 0 ? n : undefined;
}

export function normalizeThemeColor(v: string | undefined): string | undefined {
    if (!v) return undefined;
    const s = v.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
    return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : undefined;
}

interface LdFacts {
    title?: string;
    description?: string;
    author?: string;
    publisher?: string;
    image?: PageImage;
    durationS?: number;
}

const ARTICLE_TYPES = new Set(['article', 'newsarticle', 'reportagenewsarticle', 'blogposting', 'techarticle', 'scholarlyarticle',
    'analysisnewsarticle', 'opinionnewsarticle', 'reviewnewsarticle', 'report', 'webpage', 'videoobject', 'product', 'softwareapplication', 'recipe']);

function typesOf(o: Record<string, unknown>): string[] {
    const t = o['@type'];
    const list = Array.isArray(t) ? t : [t];
    return list.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
}

function nameOf(v: unknown): string | undefined {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return nameOf(v[0]);
    if (v && typeof v === 'object') { const n = (v as Record<string, unknown>).name; return typeof n === 'string' ? n : undefined; }
    return undefined;
}

function imageOf(v: unknown, base: string): PageImage | undefined {
    if (typeof v === 'string') { const url = absHttps(v, base); return url ? { url } : undefined; }
    if (Array.isArray(v)) { for (const x of v.slice(0, 4)) { const i = imageOf(x, base); if (i) return i; } return undefined; }
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const url = absHttps(typeof o.url === 'string' ? o.url : typeof o.contentUrl === 'string' ? o.contentUrl : undefined, base);
        return url ? { url, width: int(o.width), height: int(o.height) } : undefined;
    }
    return undefined;
}

/** The first article-like / video JSON-LD node's facts (bounded walk). */
export function jsonLdFacts(html: string, base: string): LdFacts {
    const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    let blocks = 0;
    const facts: LdFacts = {};
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
            const types = typesOf(o);
            if (types.some((t) => ARTICLE_TYPES.has(t))) {
                const isVideo = types.includes('videoobject');
                // An article's own facts win; a VideoObject only fills gaps (and gives the duration).
                facts.title ??= typeof o.headline === 'string' ? o.headline : (!isVideo && typeof o.name === 'string' ? o.name : undefined);
                facts.description ??= !isVideo && typeof o.description === 'string' ? o.description : undefined;
                facts.author ??= nameOf(o.author);
                facts.publisher ??= nameOf(o.publisher);
                facts.image ??= imageOf(o.image, base) ?? imageOf(o.thumbnailUrl, base);
                if (isVideo) facts.durationS ??= isoDurationSeconds(o.duration);
            }
            for (const v of Object.values(o)) if (v && typeof v === 'object') queue.push(v);
        }
    }
    return facts;
}

const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** Everything this page says about itself, for a preview. */
export function parsePageMeta(html: string, pageUrl: string): PageMeta {
    const metas = metaTags(html);
    const get = (...keys: string[]): string | undefined => {
        for (const k of keys) { const hit = metas.find((x) => x.key === k && x.content); if (hit) return hit.content; }
        return undefined;
    };
    const ld = jsonLdFacts(html, pageUrl);
    const links = linkTags(html);

    let image: PageImage | undefined;
    for (const key of ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']) {
        const url = absHttps(get(key), pageUrl);
        if (url) { image = { url, width: int(get('og:image:width')), height: int(get('og:image:height')) }; break; }
    }
    image ??= ld.image;

    const oembed = links.find((l) => (l.rel ?? '').toLowerCase().split(/\s+/).includes('alternate') && (l.type ?? '').toLowerCase() === 'application/json+oembed');
    const rawAuthor = get('author', 'article:author', 'parsely-author', 'sailthru.author', 'cxenseparse:author') ;
    const author = rawAuthor && !looksLikeUrl(rawAuthor) ? rawAuthor : ld.author;

    const t = (v: string | undefined, max: number) => (v ? cleanText(v, max) || undefined : undefined);
    return {
        title: t(get('og:title', 'twitter:title') ?? ld.title ?? htmlTitle(html), FIELD.title),
        description: t(get('og:description', 'twitter:description', 'description') ?? ld.description, FIELD.description),
        site: t(get('og:site_name', 'application-name') ?? ld.publisher, FIELD.site),
        author: t(author, FIELD.author),
        color: normalizeThemeColor(get('theme-color')),
        image,
        largeImage: (get('twitter:card') ?? '').toLowerCase() === 'summary_large_image',
        oembedUrl: absHttps(oembed?.href, pageUrl),
        durationS: ld.durationS,
        type: get('og:type')?.toLowerCase(),
    };
}

export interface OEmbedFacts { title?: string; author?: string; site?: string; thumbnail?: PageImage }

/** A provider's oEmbed JSON → the few fields a card uses. Null when it is not oEmbed JSON. */
export function parseOEmbedJson(body: string, base: string): OEmbedFacts | null {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const o = j as Record<string, unknown>;
    const s = (v: unknown, max: number) => (typeof v === 'string' ? cleanText(v, max) || undefined : undefined);
    const thumbUrl = absHttps(typeof o.thumbnail_url === 'string' ? o.thumbnail_url : undefined, base);
    return {
        title: s(o.title, FIELD.title),
        author: s(o.author_name, FIELD.author),
        site: s(o.provider_name, FIELD.site),
        thumbnail: thumbUrl ? { url: thumbUrl, width: int(o.thumbnail_width), height: int(o.thumbnail_height) } : undefined,
    };
}

// ── Site icon (favicon) ─────────────────────────────────────────────────────

export interface IconCandidate { url: string; size?: number }

/** The largest edge a `sizes` attribute names ("32x32 16x16" → 32; "any" → undefined). */
function sizesEdge(v: string | undefined): number | undefined {
    if (!v) return undefined;
    let best: number | undefined;
    const re = /(\d{1,4})\s*[x×]\s*(\d{1,4})/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v)) !== null) {
        const n = Math.max(Number(m[1]), Number(m[2]));
        if (n > 0 && (best === undefined || n > best)) best = n;
    }
    return best;
}

/** What a card wants: about 64-96 px (drawn at 16-32 px, 2x for HiDPI). Lower = better. */
function iconRank(c: IconCandidate): number {
    const s = c.size;
    if (s === undefined) return 3; // unknown: after every sensible known size
    if (s >= 48 && s <= 256) return Math.abs(s - 96) / 1000; // the closest to ~96 px wins
    if (s > 256) return 2 + s / 100000;
    return 1 + (64 - Math.min(s, 63)) / 100; // smaller than 48: the larger the better
}

/**
 * The page's own icons, best first, then `/favicon.ico` at the page's origin:
 * `<link rel="icon" | "shortcut icon" | "alternate icon" | "apple-touch-icon"
 * | "apple-touch-icon-precomposed">`, https only (relative ones resolved).
 * SVG icons are skipped (never decoded: the re-encode needs pixels, and an
 * SVG is a document). `mask-icon` (a one-colour SVG) is not an icon for this.
 */
export function iconCandidates(html: string, pageUrl: string): IconCandidate[] {
    const out: IconCandidate[] = [];
    const seen = new Set<string>();
    for (const l of linkTags(html)) {
        const rel = (l.rel ?? '').toLowerCase().split(/\s+/);
        const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
        if (!touch && !rel.includes('icon')) continue;
        if ((l.type ?? '').toLowerCase().includes('svg')) continue;
        const url = absHttps(l.href, pageUrl);
        if (!url || seen.has(url)) continue;
        try { if (/\.svgz?$/i.test(new URL(url).pathname)) continue; } catch { continue; }
        seen.add(url);
        // An apple-touch-icon without sizes is 180 px by Apple's convention.
        out.push({ url, size: sizesEdge(l.sizes) ?? (touch ? 180 : undefined) });
        if (out.length >= 12) break;
    }
    out.sort((a, b) => iconRank(a) - iconRank(b));
    const fallback = defaultFaviconUrl(pageUrl);
    if (fallback && !seen.has(fallback)) out.push({ url: fallback });
    return out;
}

/** `https://<host>/favicon.ico` for a page, or undefined. */
export function defaultFaviconUrl(pageUrl: string): string | undefined {
    try {
        const u = new URL(pageUrl);
        return u.protocol === 'https:' && !u.port ? `${u.origin}/favicon.ico` : undefined;
    } catch { return undefined; }
}

// ── Bot walls ───────────────────────────────────────────────────────────────

export const CHALLENGE_TITLE_RE = /^(?:just a moment\.*|attention required!?.*|access denied\.?|robot check|are you a (?:human|robot)\??|security check|verify(?:ing)? (?:you are|that you are) (?:a )?human.*|please wait\.*|one more step|captcha.*|error page.*|sorry! something went wrong!?|you've been blocked.*|blocked|request rejected)$/i;
const CHALLENGE_BODY_RE = /awsWafIntegration|challenge-platform|cf-chl-|_cf_chl_opt|captcha-delivery\.com|px-captcha|validateCaptcha|automated access to Amazon data|blocked by network security/i;

/**
 * A bot challenge / block page instead of the page itself (AWS WAF, Cloudflare,
 * DataDome, PerimeterX, Amazon's captcha, Reddit's network block). Its title
 * ("Just a moment...") must never become a card's title.
 */
export function isBotWall(html: string, meta: Pick<PageMeta, 'title' | 'description' | 'image'>): boolean {
    if (meta.title && CHALLENGE_TITLE_RE.test(meta.title.trim())) return true;
    // A real page with real metadata is not a wall even if it loads a captcha script somewhere.
    if (meta.image || meta.description) return false;
    return CHALLENGE_BODY_RE.test(html.slice(0, 200_000));
}

// ── Pictures that live in the body ─────────────────────────────────────────

const AMAZON_HOST_RE = /^(?:www\.|smile\.)?amazon\.(?:com|ca|co\.uk|de|fr|it|es|nl|se|pl|com\.be|com\.mx|com\.br|com\.au|co\.jp|in|sg|ae|sa|com\.tr|eg)$/i;
const AMAZON_PRODUCT_PATH_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}(?:[/?]|$)/;
const AMAZON_IMAGE_HOST_RE = /^(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images-eu\.ssl-images-amazon\.com|images-fe\.ssl-images-amazon\.com)$/i;

/** An Amazon product page (its head has no og:image; the product photo is in the body). */
export function isAmazonProductPage(pageUrl: string): boolean {
    try { const u = new URL(pageUrl); return AMAZON_HOST_RE.test(u.hostname) && AMAZON_PRODUCT_PATH_RE.test(u.pathname); } catch { return false; }
}

/** Where to stop reading a page whose picture lives in the body (else undefined: stop at `</head>`). */
export function bodyPictureStop(pageUrl: string): RegExp | undefined {
    return isAmazonProductPage(pageUrl) ? /data-old-hires="[^"]{8,}"/ : undefined;
}

/** A Google Drive file viewer page (drive.google.com/file/d/<id>/…). */
export function isDriveFilePage(pageUrl: string): boolean {
    try { const u = new URL(pageUrl); return u.hostname === 'drive.google.com' && /^\/file\/d\/[\w-]{10,}(?:\/|$)/.test(u.pathname); } catch { return false; }
}

/**
 * Google Drive's own first-page picture of a file. A Drive file page
 * publishes no og:image (measured 2026-11-23: the same .docx as
 * docs.google.com/document/d/<id> has one, as drive.google.com/file/d/<id>
 * has none), but the viewer preloads its first-page image in the head:
 * `<link id="texmex-thumb" rel="preload" as="image"
 * href="https://drive.google.com/drive-viewer/…">` (served without cookies,
 * image/webp). Only that exact tag, only on Drive's own host and path.
 * A file Drive cannot preview (a .zip) has none.
 */
export function drivePicture(html: string, pageUrl: string): PageImage | undefined {
    if (!isDriveFilePage(pageUrl)) return undefined;
    const link = linkTags(html).find((l) => l.id === 'texmex-thumb' && (l.rel ?? '').toLowerCase() === 'preload' && (l.as ?? '').toLowerCase() === 'image');
    const url = absHttps(link?.href, pageUrl);
    if (!url) return undefined;
    try {
        const u = new URL(url);
        return u.hostname === 'drive.google.com' && u.pathname.startsWith('/drive-viewer/') ? { url } : undefined;
    } catch { return undefined; }
}

/**
 * A page's picture from its body when its head names none: an Amazon product
 * photo (`data-old-hires` / `"hiRes"` on Amazon's own image hosts), Google
 * Drive's first-page picture (drivePicture), else a `<link rel="image_src">`
 * (an old, still common convention).
 */
export function bodyPicture(html: string, pageUrl: string): PageImage | undefined {
    const drive = drivePicture(html, pageUrl);
    if (drive) return drive;
    if (isAmazonProductPage(pageUrl)) {
        const raw = /data-old-hires="([^"]{8,2048})"/.exec(html)?.[1] ?? /"hiRes":"(https:[^"]{8,2048})"/.exec(html)?.[1];
        const url = absHttps(raw ? decodeEntities(raw) : undefined, pageUrl);
        if (url) {
            try { if (AMAZON_IMAGE_HOST_RE.test(new URL(url).hostname)) return { url }; } catch { /* none */ }
        }
    }
    const link = linkTags(html).find((l) => (l.rel ?? '').toLowerCase().split(/\s+/).includes('image_src'));
    const url = absHttps(link?.href, pageUrl);
    return url ? { url } : undefined;
}
