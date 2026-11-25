/**
 * The sender-side unfurler (main process). docs/plans/embeds.md §2, §5.
 *
 * When the person composing a message has a link in it (and "Generate link
 * previews" is on), the renderer asks main to build a preview. Main — on the
 * SENDER's device, never the server and never a receiver — visits the link
 * and returns a draft LinkEmbed (packages/shared/link-embeds.ts) plus the
 * preview image's raw bytes. The renderer re-encodes the image (WebP, EXIF
 * stripped), encrypts it like any attachment and puts the result inside the
 * end-to-end encrypted message.
 *
 * Fetch rules (all in pinned-fetch.ts + net-guard.ts, shared with clmedia://):
 *   - https only, at most 5 redirects, every hop re-checked;
 *   - every DNS answer checked against private / loopback / link-local /
 *     CGNAT / ULA ranges and the connection pinned to the checked address
 *     (a link cannot make the sender's app probe their LAN);
 *   - no cookies, no auth headers, no referrer; a generic UA (below);
 *   - 4 s per request; a page is read only until its `</head>` arrives (the
 *     metadata lives there; a multi-megabyte page is never downloaded) and at
 *     most 1 MB; a provider page is read to 512 KB; oEmbed JSON <= 64 KB;
 *     images <= 5 MB, refused outright when larger, and only
 *     image/{jpeg,png,webp,gif,avif}; site icons <= 1 MB, sniffed by their
 *     bytes (PNG / JPEG / GIF / WebP / ICO; never SVG).
 *   - Pages are read with the link-preview UA first (EMBED_PREVIEW_UA: big
 *     sites serve their OpenGraph head to link-preview crawlers and a
 *     JavaScript bot challenge to a script-less "browser"), then once with the
 *     browser UA when that got nothing. A challenge / block page ("Just a
 *     moment...", AWS WAF, a captcha) is never used as the page.
 *
 * Which links get what:
 *   YouTube      oEmbed (title, channel) + i.ytimg.com thumbnail; the page is
 *                not fetched while those two answer. kind 'player'.
 *   Twitch, X / Twitter, TikTok, Reddit   social.ts (phase 4): a player
 *                (Twitch, TikTok: the reader builds the frame on click) or a
 *                post card (X, Reddit) with the author's picture and the
 *                post's pictures; video files only on X / Reddit media hosts.
 *   Medal, Streamable, Imgur pages, Tenor   the clip page (provider hosts only
 *                on every hop): the video file (clip-page.ts), title, game,
 *                duration, thumbnail. kind 'video'. Tenor is a GIF: its media
 *                is marked `loop` and carries the file's real width / height,
 *                so readers draw it as a GIF at its own shape.
 *   Giphy, Imgur .gifv   the GIF's file from the link's own pattern (no page
 *                read: giphy.com refuses non-browser clients), marked `loop`.
 *   media files (2026-11-24, embeds-media-everywhere)   decided by their
 *                BYTES (media-probe.ts: a ranged GET; media-sniff.ts), never by
 *                the extension alone: a link whose PATH ends in a media
 *                extension (the query is ignored: `a.gif?ex=…&hm=…`), an
 *                expiring / signed link, or a link that answers a page read
 *                with an image / video. kind 'image' (GIF / WebP / PNG / JPEG,
 *                `animated` from the frames) or 'video' (a short silent one is
 *                `loop`: a GIF) at the file's real size. An EXPIRING link
 *                (a Discord CDN attachment) gets a `copy` offer: the sender
 *                attaches the file itself (embed:media-copy, ipc.ts), so
 *                readers never load the link. A dead link (404) gets the
 *                minimal card. KLIPY's media files are never fetched.
 *   pages with their own media   page-media.ts: a KLIPY page → KLIPY's GIF
 *                reference (KLIPY's rules, nothing of KLIPY's fetched); a page
 *                with a video file (og:video …, any host) → a video embed; a
 *                GIF site's page → its GIF.
 *   Anything else   OpenGraph / Twitter / JSON-LD / <title> / meta description,
 *                plus the page's oEmbed when the page itself lacks a title or
 *                image, plus the site's icon. kind 'card'. EVERY such link
 *                gets a card: a page with no metadata, a bot wall, an error
 *                status or an unreachable host still gets the minimal one
 *                (site = the host, plus the site's icon when the site answered).
 *
 * A web page that was read fine but gave no picture comes back with
 * `snapshot: true`: the sender's app then takes a snapshot of the page in a
 * locked-down hidden window (page-snapshot.ts) and uses it as the picture.
 * Google Drive file pages publish no og:image; their viewer's own first-page
 * picture is used instead (parse-page.ts drivePicture), so they need none.
 *
 * "Always a thumbnail" (2026-11-24, embeds-always-thumb): every embed ends with
 * a picture. The chain, in order: (1) the provider's own thumbnail, (2) the
 * page's og:image / twitter:image (withPageFallback, below), (3) a real frame
 * of the video, grabbed on the SENDER's renderer (frameGrab.ts) for any embed
 * with a streamable `media` file, (4) a page snapshot (`snapshotable`), (5) the
 * designed card picture (designedThumb.ts). Steps 1-2 run here; 3-5 in the
 * renderer (utils/linkEmbeds/prepare.ts), which also refuses a provider picture
 * that is one flat colour (Medal's og:image is the clip's FIRST frame, black
 * for every clip that fades in).
 *
 * After a provider adapter (YouTube, Twitch, X, TikTok, Reddit, a clip page),
 * one shared step (withPageFallback) reads the link's own page for whatever the
 * adapter left empty: the picture, title, description, site, colour. It never
 * replaces what the adapter found.
 */
import {
    fetchTextPinned, openPinned, assertHttpsUrlShape, HttpStatusError, UnexpectedContentTypeError, EMBED_FETCH_UA, EMBED_PREVIEW_UA, type FetchDeps,
} from '../media-embed/pinned-fetch';
import { clipLinkOf, pageHostAllowed, type ClipProvider } from '../media-embed/clip-links';
import { clipTitle, parseClipPage } from '../media-embed/clip-page';
import { youTubeMetaFor } from '../media-embed/ipc';
import { bodyPicture, bodyPictureStop, defaultFaviconUrl, iconCandidates, isBotWall, isDriveFilePage, parsePageMeta, parseOEmbedJson, type IconCandidate, type PageImage, type PageMeta } from './parse-page';
import { medalFacts, youTubeRefOf, youTubeThumbCandidates } from './providers';
import { unfurlSocial } from './social';
import { isExpiringMediaUrl, isShortLoop, type MediaFacts } from './media-sniff';
import { probeMedia, type ProbeResult } from './media-probe';
import { isGifPageHost, isKlipyPageUrl, pageMedia } from './page-media';

export const UNFURL_LIMITS = {
    timeoutMs: 4000,
    maxRedirects: 5,
    /** A provider page (Twitch, TikTok, a clip page) read up to here. */
    htmlMaxBytes: 512 * 1024,
    /** A page read for its preview: up to `</head>`, at most this much. */
    headMaxBytes: 1024 * 1024,
    oembedMaxBytes: 64 * 1024,
    imageMaxBytes: 5 * 1024 * 1024,
    /** A site icon (an .ico with a 256 px bitmap is ~270 KB). */
    iconMaxBytes: 1024 * 1024,
    /** Site icons tried per page (its best ones, then /favicon.ico). */
    iconTries: 3,
} as const;

type Ua = typeof EMBED_FETCH_UA | typeof EMBED_PREVIEW_UA;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] as const;
const DIRECT_MEDIA_RE = /\.(png|jpe?g|gif|webp|avif|bmp|mp4|m4v|webm|mov|gifv)$/i;
const DIRECT_VIDEO_RE = /\.(mp4|m4v|webm|mov)$/i;
const CLIP_NOUN: Record<ClipProvider, string> = { medal: 'Medal clip', streamable: 'Streamable video', imgur: 'Imgur video', tenor: 'Tenor GIF', giphy: 'GIPHY GIF' };
const CLIP_SITE: Record<ClipProvider, string> = { medal: 'Medal', streamable: 'Streamable', imgur: 'Imgur', tenor: 'Tenor', giphy: 'GIPHY' };

/** What the renderer gets back: the LinkEmbed minus its pictures, which it builds from `image` / `icon` / `images`. */
export interface UnfurlDraft {
    url: string;
    kind: 'card' | 'video' | 'player' | 'post' | 'image';
    site?: string;
    title?: string;
    description?: string;
    author?: string;
    tag?: string;
    color?: string;
    image_large?: boolean;
    media?: { url: string; mime: DraftMediaMime; width?: number; height?: number; duration_s?: number; loop?: boolean; no_audio?: boolean; animated?: boolean };
    player?: { provider: 'youtube' | 'twitch' | 'tiktok'; id: string; start_s?: number };
    author_handle?: string;
    published_at?: string;
    nsfw?: boolean;
    spoiler?: boolean;
    score?: number;
    comments?: number;
}

export type ImageBytes = { bytes: Uint8Array; mime: string };
export type DraftMediaMime = 'video/mp4' | 'video/webm' | 'video/quicktime' | 'image/gif' | 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * The link's media may be COPIED by the sender (2026-11-24): an expiring /
 * signed media URL (media-sniff.ts isExpiringMediaUrl) whose file is within
 * the cap for its type. The renderer asks main for the file (embed:media-copy,
 * gated on this flag for this URL) and attaches it encrypted, so readers never
 * load the link. `bytes`: the file's length when the server said.
 */
export interface CopyOffer { mediaUrl: string; mime: DraftMediaMime; bytes?: number }

/** The sender attaches copies up to these sizes (packages/shared LINK_EMBED_MEDIA_COPY_MAX_BYTES; kept equal by a test). */
export const COPY_MAX_BYTES = { image: 8 * 1024 * 1024, video: 25 * 1024 * 1024 } as const;
export const copyCapFor = (mime: string): number => (mime.startsWith('image/') ? COPY_MAX_BYTES.image : COPY_MAX_BYTES.video);

export type UnfurlResult =
    | {
        ok: true; embed: UnfurlDraft;
        /** The preview picture (thumbnail / poster). */
        image?: ImageBytes;
        /**
         * The author's picture (phase 4: a tweet's avatar, a TikTok author, a
         * Twitch channel); on a `card`, the SITE's icon (its favicon). May be
         * an .ico: the renderer decodes the container (utils/linkEmbeds/ico.ts).
         */
        icon?: ImageBytes;
        /** A post's pictures in order (phase 4: a tweet's photos, a Reddit gallery), at most 4. */
        images?: ImageBytes[];
        /**
         * A web page that was read fine (a real page: no wall, no error status)
         * but gave no picture: the renderer may ask main for a snapshot of it
         * (page-snapshot.ts, embed:snapshot; main only takes one for a URL that
         * came back with this flag).
         */
        snapshot?: true;
        /**
         * The link is a page (not a wall, an error or a bare file) that the
         * renderer may still ask a snapshot of when every earlier picture
         * failed it (a provider picture that is one flat colour, a frame grab
         * that failed). Main's snapshot gate accepts the URL for either flag.
         */
        snapshotable?: true;
        /** The sender may attach a copy of the media (an expiring link): see CopyOffer. */
        copy?: CopyOffer;
    }
    | { ok: false; reason: 'invalid' | 'local' | 'empty' | 'failed' };

type OkResult = Extract<UnfurlResult, { ok: true }>;

export interface UnfurlDeps {
    fetchDeps?: FetchDeps;
    /** Test seam: the pause before an adapter's retry. */
    sleep?: (ms: number) => Promise<void>;
}

/** A preview image under the rules above; throws on anything else. */
export async function fetchImagePinned(url: string, deps: UnfurlDeps = {}, hostAllowed?: (hostname: string) => boolean, userAgent?: Ua): Promise<ImageBytes> {
    const started = Date.now();
    const { res, req } = await openPinned(url, {
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' },
        maxRedirects: UNFURL_LIMITS.maxRedirects,
        headersTimeoutMs: UNFURL_LIMITS.timeoutMs,
        hostAllowed,
        userAgent,
    }, deps.fetchDeps);
    const status = res.statusCode ?? 0;
    const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (status < 200 || status >= 300 || !(IMAGE_TYPES as readonly string[]).includes(type)) {
        res.resume();
        req.destroy();
        throw new Error(status < 200 || status >= 300 ? `HTTP ${status}` : 'Not an image');
    }
    const declared = Number(res.headers['content-length'] ?? 0);
    if (declared > UNFURL_LIMITS.imageMaxBytes) { req.destroy(); throw new Error('Image too large'); }
    return await new Promise((ok, fail) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const stop = (e: Error) => { if (done) return; done = true; clearTimeout(timer); req.destroy(); fail(e); };
        const timer = setTimeout(() => stop(new Error('Request timed out')), Math.max(0, UNFURL_LIMITS.timeoutMs - (Date.now() - started)));
        res.on('data', (c: Buffer) => {
            if (done) return;
            total += c.length;
            if (total > UNFURL_LIMITS.imageMaxBytes) { stop(new Error('Image too large')); return; }
            chunks.push(c);
        });
        res.on('end', () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const buf = Buffer.concat(chunks);
            ok({ bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), mime: type });
        });
        res.on('error', (e) => stop(e));
    });
}

// ── Site icons ─────────────────────────────────────────────────────────────

/** The real format of icon bytes (servers label .ico every which way, so the bytes decide). Never SVG / HTML. */
export function sniffIconMime(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/x-icon' | null {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    // ICO: reserved 0, type 1, 1..64 pictures.
    const count = b.length >= 6 ? b[4] | (b[5] << 8) : 0;
    if (b.length >= 22 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && count >= 1 && count <= 64) return 'image/x-icon';
    return null;
}

const ICON_TYPES = new Set(['', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/ico', 'image/icon', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/octet-stream', 'binary/octet-stream', 'text/plain']);

/** One site icon under the rules above (its bytes sniffed; SVG / HTML refused); throws on anything else. */
export async function fetchIconPinned(url: string, deps: UnfurlDeps = {}, userAgent?: Ua, timeoutMs: number = UNFURL_LIMITS.timeoutMs): Promise<ImageBytes> {
    const started = Date.now();
    const { res, req } = await openPinned(url, {
        headers: { Accept: 'image/avif,image/webp,image/png,image/x-icon,image/*;q=0.9,*/*;q=0.1' },
        maxRedirects: UNFURL_LIMITS.maxRedirects,
        headersTimeoutMs: timeoutMs,
        userAgent,
    }, deps.fetchDeps);
    const status = res.statusCode ?? 0;
    const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (status < 200 || status >= 300 || !ICON_TYPES.has(type)) {
        res.resume();
        req.destroy();
        throw new Error(status < 200 || status >= 300 ? `HTTP ${status}` : 'Not an icon');
    }
    if (Number(res.headers['content-length'] ?? 0) > UNFURL_LIMITS.iconMaxBytes) { req.destroy(); throw new Error('Icon too large'); }
    const buf = await new Promise<Buffer>((ok, fail) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const stop = (e: Error) => { if (done) return; done = true; clearTimeout(timer); req.destroy(); fail(e); };
        const timer = setTimeout(() => stop(new Error('Request timed out')), Math.max(0, timeoutMs - (Date.now() - started)));
        res.on('data', (c: Buffer) => {
            if (done) return;
            total += c.length;
            if (total > UNFURL_LIMITS.iconMaxBytes) { stop(new Error('Icon too large')); return; }
            chunks.push(c);
        });
        res.on('end', () => { if (done) return; done = true; clearTimeout(timer); ok(Buffer.concat(chunks)); });
        res.on('error', (e) => stop(e));
    });
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const mime = sniffIconMime(bytes);
    if (!mime) throw new Error('Not an icon');
    return { bytes, mime };
}

/** The first of a page's icons that fetches as a raster image, within one overall deadline. */
export async function firstIcon(candidates: readonly IconCandidate[], deps: UnfurlDeps, userAgent?: Ua): Promise<ImageBytes | undefined> {
    const deadline = Date.now() + UNFURL_LIMITS.timeoutMs;
    for (const c of candidates.slice(0, UNFURL_LIMITS.iconTries)) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        try { return await fetchIconPinned(c.url, deps, userAgent, left); } catch { /* next */ }
    }
    return undefined;
}

// ── Reading a page ─────────────────────────────────────────────────────────

/** A page read for its preview. `reachable`: the site answered (any HTTP status, a non-HTML body). */
export type PageRead =
    | { ok: true; html: string; finalUrl: string; page: PageMeta; ua: Ua }
    | { ok: false; reachable: boolean; /** The link answered with an image / video instead of a page. */ media?: true };

const isNetworkError = (e: unknown) => !(e instanceof HttpStatusError) && !(e instanceof Error && /content type/i.test(e.message));

/**
 * The page's head, read with the link-preview UA and, when that got nothing
 * (an error status, a bot wall, a page with no title / description /
 * picture), once more with the browser UA. A bot wall is never returned. An
 * unreachable host (DNS failure, refused by the guard, timeout) is not retried.
 */
export async function readPage(url: string, deps: UnfurlDeps, hostAllowed?: (h: string) => boolean, usable?: (page: PageMeta) => boolean): Promise<PageRead> {
    let reachable = false;
    let media = false;
    let bare: PageRead | null = null;
    for (const ua of [EMBED_PREVIEW_UA, EMBED_FETCH_UA] as const) {
        try {
            const { text, finalUrl, status } = await fetchTextPinned(url, {
                accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
                allowedTypes: ['text/html', 'application/xhtml+xml'],
                maxBytes: UNFURL_LIMITS.headMaxBytes,
                timeoutMs: UNFURL_LIMITS.timeoutMs,
                maxRedirects: UNFURL_LIMITS.maxRedirects,
                truncate: true,
                htmlHead: true,
                stopAt: bodyPictureStop(url),
                userAgent: ua,
                hostAllowed,
            }, deps.fetchDeps);
            reachable = true;
            const page = parsePageMeta(text, finalUrl);
            page.image ??= bodyPicture(text, finalUrl);
            // 202 (AWS WAF's challenge), 204 and friends are not the page.
            if ((status !== 200 && status !== 203) || isBotWall(text, page) || (usable && !usable(page))) continue;
            const read: PageRead = { ok: true, html: text, finalUrl, page, ua };
            if (page.title || page.description || page.image) return read;
            bare ??= read; // a real page with nothing in it: its icons still count
        } catch (e) {
            if (isNetworkError(e)) break;
            reachable = true;
            // An image / video (or a binary) where a page was expected: read it as media, not again as a page.
            if (e instanceof UnexpectedContentTypeError && /^(image|video)\/|^application\/octet-stream$|^binary\//.test(e.contentType)) { media = true; break; }
        }
    }
    return bare ?? { ok: false, reachable, ...(media ? { media: true as const } : {}) };
}

async function fetchHtml(url: string, deps: UnfurlDeps, hostAllowed?: (h: string) => boolean): Promise<{ text: string; finalUrl: string }> {
    const { text, finalUrl } = await fetchTextPinned(url, {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        allowedTypes: ['text/html', 'application/xhtml+xml'],
        maxBytes: UNFURL_LIMITS.htmlMaxBytes,
        timeoutMs: UNFURL_LIMITS.timeoutMs,
        maxRedirects: UNFURL_LIMITS.maxRedirects,
        truncate: true,
        hostAllowed,
    }, deps.fetchDeps);
    return { text, finalUrl };
}

async function firstImage(candidates: (PageImage | string | undefined)[], deps: UnfurlDeps, userAgent?: Ua): Promise<ImageBytes | undefined> {
    for (const c of candidates) {
        const url = typeof c === 'string' ? c : c?.url;
        if (!url) continue;
        try { return await fetchImagePinned(url, deps, undefined, userAgent); } catch { /* next */ }
    }
    return undefined;
}

const videoMime = (u: string): 'video/mp4' | 'video/webm' | 'video/quicktime' => {
    const p = (() => { try { return new URL(u).pathname.toLowerCase(); } catch { return ''; } })();
    return p.endsWith('.webm') ? 'video/webm' : p.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
};

const hostLabel = (u: string): string => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// ── Cards ──────────────────────────────────────────────────────────────────

/** The minimal card: the site (its host) and, when the site answered, its /favicon.ico. */
async function minimalCard(url: string, href: string, reachable: boolean, deps: UnfurlDeps): Promise<OkResult> {
    const embed: UnfurlDraft = { url, kind: 'card', site: hostLabel(href) || href };
    const fav = reachable ? defaultFaviconUrl(href) : undefined;
    const icon = fav ? await firstIcon([{ url: fav }], deps, EMBED_PREVIEW_UA) : undefined;
    return { ok: true, embed, ...(icon ? { icon } : {}) };
}

// ── Media by CONTENT (2026-11-24, embeds-media-everywhere) ─────────────────

const KLIPY_MEDIA_HOSTS = new Set(['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com']);
/** KLIPY's media files: never fetched or copied by the sender (KLIPY's terms; readers follow the KLIPY opt-in). */
export const isKlipyMediaHost = (u: string): boolean => { try { return KLIPY_MEDIA_HOSTS.has(new URL(u).hostname.toLowerCase()); } catch { return false; } };

const EMBEDDABLE_IMAGE: ReadonlySet<string> = new Set(['image/gif', 'image/png', 'image/jpeg', 'image/webp']);

/** May the sender attach a copy of this file (an expiring link, within the cap for its type)? */
function copyOffer(mediaUrl: string, alsoUrl: string | undefined, mime: DraftMediaMime, total: number | undefined): CopyOffer | undefined {
    if (isKlipyMediaHost(mediaUrl)) return undefined;
    if (!isExpiringMediaUrl(mediaUrl) && !(alsoUrl && isExpiringMediaUrl(alsoUrl))) return undefined;
    if (total !== undefined && total > copyCapFor(mime)) return undefined;
    return { mediaUrl, mime, ...(total !== undefined ? { bytes: total } : {}) };
}

/** The media fields for a probed file, or null when it is not a type readers draw. */
function mediaFields(mediaUrl: string, f: MediaFacts): { kind: 'image' | 'video'; media: NonNullable<UnfurlDraft['media']> } | null {
    const size = f.width && f.height ? { width: f.width, height: f.height } : {};
    if (f.mime.startsWith('image/')) {
        if (!EMBEDDABLE_IMAGE.has(f.mime)) return null; // AVIF: the reader's local embed
        return { kind: 'image', media: { url: mediaUrl, mime: f.mime as DraftMediaMime, ...size, ...(f.animated ? { animated: true } : {}) } };
    }
    const loop = isShortLoop(f);
    return {
        kind: 'video',
        media: {
            url: mediaUrl, mime: f.mime as DraftMediaMime, ...size,
            ...(f.durationS ? { duration_s: f.durationS } : {}),
            ...(loop ? { loop: true } : {}),
            ...(f.hasAudio === false ? { no_audio: true } : {}),
        },
    };
}

/**
 * A link that IS a media file (decided by its bytes): an image / GIF embed or
 * a video embed at the file's real size, its picture (a small file's own
 * bytes, else the image fetched under the picture rules; a video's frame is
 * grabbed by the renderer), and the copy offer for an expiring link.
 */
async function directMediaResult(url: string, href: string, probe: Extract<ProbeResult, { ok: true }>, deps: UnfurlDeps): Promise<OkResult | null> {
    const facts = probe.facts;
    if (!facts) return null;
    const fields = mediaFields(href, facts);
    if (!fields) return null;
    const copy = copyOffer(href, probe.finalUrl, fields.media.mime, probe.total);
    const embed: UnfurlDraft = { url, kind: fields.kind, site: hostLabel(href) || href, media: fields.media };
    let image: ImageBytes | undefined;
    if (fields.kind === 'image' && !isKlipyMediaHost(href)) {
        if (probe.whole) image = { bytes: probe.head, mime: facts.mime };
        // A copy brings its own bytes (the picture is made from it); otherwise fetch the picture (<= 5 MB).
        else if (!copy) image = await firstImage([href], deps);
    }
    return { ok: true, embed, ...(image ? { image } : {}), ...(copy ? { copy } : {}) };
}

/**
 * A page that publishes ITS OWN media (page-media.ts): a KLIPY page -> its GIF
 * under the KLIPY rules (no file of KLIPY's fetched, stored or copied by the
 * sender); a page with a video file (og:video / twitter:player:stream /
 * JSON-LD, any host) -> a video embed with the page's title, at the file's real
 * size, a short silent one drawn as a GIF; a GIF site's page with only a GIF ->
 * that GIF. Null: an ordinary page (its card).
 */
async function pageMediaResult(url: string, href: string, read: Extract<PageRead, { ok: true }>, deps: UnfurlDeps): Promise<OkResult | null> {
    const { page, finalUrl, ua } = read;
    const pm = pageMedia(read.html, finalUrl);
    const host = (() => { try { return new URL(finalUrl).hostname; } catch { return ''; } })();
    const text = {
        site: page.site ?? (hostLabel(finalUrl) || hostLabel(href)),
        ...(page.title ? { title: page.title } : {}),
        ...(page.description ? { description: page.description } : {}),
        ...(page.author ? { author: page.author } : {}),
        ...(page.color ? { color: page.color } : {}),
    };
    if (isKlipyPageUrl(href)) {
        // KLIPY (klipy_gif_integration): the sender resolves the page to KLIPY's own
        // GIF reference; readers load it from KLIPY only under the KLIPY opt-in.
        // No picture of KLIPY's media is made or attached.
        const gif = pm.gif && isKlipyMediaHost(pm.gif.url) ? pm.gif : undefined;
        if (!gif) return null;
        return { ok: true, embed: { url, kind: 'image', ...text, site: 'KLIPY', media: { url: gif.url, mime: 'image/gif', animated: true, ...(gif.width && gif.height ? { width: gif.width, height: gif.height } : {}) } } };
    }
    if (pm.video) {
        const probe = await probeMedia(pm.video.url, deps);
        const facts = probe.ok ? probe.facts : null;
        // A dead or non-video file is no video: the page's card.
        if (!probe.ok || (facts && !facts.mime.startsWith('video/'))) return null;
        const loop = facts ? isShortLoop(facts) : isGifPageHost(host);
        const w = facts?.width ?? pm.video.width;
        const h = facts?.height ?? pm.video.height;
        const mime = (facts?.mime ?? pm.video.mime ?? 'video/mp4') as DraftMediaMime;
        const copy = copyOffer(pm.video.url, probe.finalUrl, mime, probe.total);
        const duration = facts?.durationS ?? page.durationS;
        const embed: UnfurlDraft = {
            url, kind: 'video', ...text,
            media: {
                url: pm.video.url, mime, ...(w && h ? { width: w, height: h } : {}),
                ...(duration ? { duration_s: duration } : {}),
                ...(loop ? { loop: true } : {}),
                ...(facts?.hasAudio === false ? { no_audio: true } : {}),
            },
        };
        const image = page.image && !isKlipyMediaHost(page.image.url) ? await firstImage([page.image], deps, ua) : undefined;
        return { ok: true, embed, ...(image ? { image } : {}), ...(copy ? { copy } : {}), snapshotable: true };
    }
    if (pm.gif && isGifPageHost(host)) {
        const probe = await probeMedia(pm.gif.url, deps, { maxBytes: 64 * 1024 });
        if (!probe.ok || !probe.facts || probe.facts.mime !== 'image/gif') return null;
        const f = probe.facts;
        const w = f.width ?? pm.gif.width;
        const h = f.height ?? pm.gif.height;
        const copy = copyOffer(pm.gif.url, probe.finalUrl, 'image/gif', probe.total);
        const image = probe.whole ? { bytes: probe.head, mime: 'image/gif' } : page.image ? await firstImage([page.image], deps, ua) : undefined;
        return {
            ok: true,
            embed: { url, kind: 'image', ...text, media: { url: pm.gif.url, mime: 'image/gif', ...(w && h ? { width: w, height: h } : {}), ...(f.animated !== false ? { animated: true } : {}) } },
            ...(image ? { image } : {}), ...(copy ? { copy } : {}),
        };
    }
    return null;
}

/** Any web page: its card from the page's own metadata, else the minimal card. Never "no card". */
async function pageCard(url: string, href: string, deps: UnfurlDeps): Promise<OkResult> {
    const read = await readPage(href, deps);
    if (!read.ok) {
        // The link answered with an image / video, not a page (an extensionless media URL).
        if (read.media) {
            const probe = await probeMedia(href, deps);
            if (probe.ok) {
                const r = await directMediaResult(url, href, probe, deps);
                if (r) return r;
            }
        }
        return minimalCard(url, href, read.reachable, deps);
    }
    const media = await pageMediaResult(url, href, read, deps);
    if (media) return media;
    const { page, finalUrl, ua } = read;
    let { title, author, site } = page;
    let thumb: PageImage | undefined = page.image;
    if (page.oembedUrl && (!title || !thumb)) {
        try {
            const { text, finalUrl: oUrl } = await fetchTextPinned(page.oembedUrl, {
                accept: 'application/json',
                allowedTypes: ['application/json', 'text/json', 'application/json+oembed'],
                maxBytes: UNFURL_LIMITS.oembedMaxBytes,
                timeoutMs: UNFURL_LIMITS.timeoutMs,
                maxRedirects: UNFURL_LIMITS.maxRedirects,
                truncate: false,
                userAgent: ua,
            }, deps.fetchDeps);
            const o = parseOEmbedJson(text, oUrl);
            if (o) { title ??= o.title; author ??= o.author; site ??= o.site; thumb ??= o.thumbnail; }
        } catch { /* the page's own tags are all we have */ }
    }
    // Google labels a Drive file page "Google Docs" (og:site_name); it is Drive.
    if (isDriveFilePage(finalUrl)) site = 'Google Drive';
    const embed: UnfurlDraft = {
        url, kind: 'card',
        site: site ?? (hostLabel(finalUrl) || hostLabel(href)),
        ...(title ? { title } : {}),
        ...(page.description ? { description: page.description } : {}),
        ...(author ? { author } : {}),
        ...(page.color ? { color: page.color } : {}),
        ...(page.largeImage ? { image_large: true } : {}),
    };
    // The picture and the site's icon in parallel.
    const [image, icon] = await Promise.all([firstImage([thumb], deps, ua), firstIcon(iconCandidates(read.html, finalUrl), deps, ua)]);
    // A real page without a picture of its own: worth a snapshot (the sender's
    // app may take one; never for a wall, an error status or an unreachable
    // host, which got the minimal card above).
    return { ok: true, embed, ...(image ? { image } : { snapshot: true as const }), ...(icon ? { icon } : {}), snapshotable: true };
}

/**
 * The shared "no embed without a preview" step: after a provider adapter,
 * read the link's own page for anything the adapter left empty (its picture
 * first; also title, description, site and colour on a non-post). Only gaps
 * are filled; nothing the adapter found is replaced. A post's text is the
 * post's own words, so a page summary never becomes it; a post's page picture
 * goes in `images` (where post cards draw pictures), anything else's in
 * `image`. An author's / channel's picture counts as the picture of a post
 * or a player.
 */
export async function withPageFallback(href: string, r: OkResult, deps: UnfurlDeps, usable?: (page: PageMeta) => boolean): Promise<OkResult> {
    const e = r.embed;
    const post = e.kind === 'post';
    // A post's author picture is part of the post; a player's (a TikTok author)
    // is not a picture OF the video, so it still gets the page's. A Twitch
    // channel has no frame: its picture is the channel's.
    const hasPicture = !!(r.image || r.images?.length || (post && r.icon) || (e.kind === 'player' && r.icon && e.player?.id.startsWith('channel:')));
    const textGap = !post && !e.title;
    if (hasPicture && !textGap) return r;
    const read = await readPage(href, deps, undefined, usable);
    if (!read.ok) return r;
    const { page, ua } = read;
    const embed: UnfurlDraft = { ...e };
    if (!post) {
        if (!embed.title && page.title) embed.title = page.title;
        if (!embed.description && page.description) embed.description = page.description;
    }
    if (!embed.site && page.site) embed.site = page.site;
    if (!embed.color && page.color) embed.color = page.color;
    if (hasPicture || !page.image) return { ...r, embed };
    const img = await firstImage([page.image], deps, ua);
    if (!img) return { ...r, embed };
    if (post && !e.media) return { ...r, embed, images: [img] };
    return { ...r, embed, image: img };
}

/** A provider page's result: the renderer may still snapshot it as a last resort. */
const snapshotable = (r: OkResult): OkResult => ({ ...r, snapshotable: true });

export async function unfurlLink(raw: unknown, deps: UnfurlDeps = {}): Promise<UnfurlResult> {
    let href: string;
    try { href = assertHttpsUrlShape(raw); } catch { return { ok: false, reason: 'invalid' }; }
    const url = raw as string;

    // ── YouTube: oEmbed + thumbnail; the page only for a gap ────────────────
    const yt = youTubeRefOf(href);
    if (yt) {
        const [meta, image] = await Promise.all([
            youTubeMetaFor(yt.id, { fetchDeps: deps.fetchDeps }),
            firstImage(youTubeThumbCandidates(yt.id), deps),
        ]);
        if (!meta && !image) return { ok: false, reason: 'failed' };
        const embed: UnfurlDraft = {
            url, kind: 'player', site: 'YouTube',
            player: { provider: 'youtube', id: yt.id, ...(yt.start > 0 ? { start_s: yt.start } : {}) },
            ...(meta?.title ? { title: meta.title } : {}),
            ...(meta?.author ? { author: meta.author } : {}),
            ...(yt.short ? { tag: 'Short' } : {}),
        };
        return snapshotable(await withPageFallback(href, { ok: true, embed, ...(image ? { image } : {}) }, deps));
    }

    // ── Twitch, X / Twitter, TikTok, Reddit (phase 4, social.ts) ────────────
    const social = await unfurlSocial(url, {
        fetchDeps: deps.fetchDeps,
        fetchImage: (u, hostAllowed, ua) => fetchImagePinned(u, deps, hostAllowed, ua),
        sleep: deps.sleep,
        timeoutMs: UNFURL_LIMITS.timeoutMs,
        htmlMaxBytes: UNFURL_LIMITS.htmlMaxBytes,
        jsonMaxBytes: UNFURL_LIMITS.oembedMaxBytes,
    });
    if (social) {
        const { embed, image, icon, images, pageUsable } = social;
        const r: OkResult = { ok: true, embed: embed as unknown as UnfurlDraft, ...(image ? { image } : {}), ...(icon ? { icon } : {}), ...(images?.length ? { images } : {}) };
        return snapshotable(await withPageFallback(href, r, deps, pageUsable));
    }
    if (social === null) {
        // A provider link the provider would not describe (an X / Reddit post,
        // a TikTok short link that never resolved) still gets its page's card,
        // and with it a picture (never "no embed").
        return pageCard(url, href, deps);
    }

    // ── Clip pages (phase-2 adapters, now on the sender) ────────────────────
    const clip = clipLinkOf(href);
    if (clip) {
        if (!clip.pageUrl) {
            // Giphy, Imgur .gifv: the GIF's file follows from the link (no page
            // read). The renderer grabs a frame of it for the picture and its shape.
            if (!clip.directUrl) return { ok: false, reason: 'local' };
            return {
                ok: true,
                embed: { url, kind: 'video', site: CLIP_SITE[clip.provider], media: { url: clip.directUrl, mime: 'video/mp4', loop: true } },
            };
        }
        let html: { text: string; finalUrl: string };
        try {
            html = await fetchHtml(clip.pageUrl, deps, (h) => pageHostAllowed(clip.provider, h));
        } catch {
            // The clip page did not answer: still a clip card (readers read the
            // page again on play), and the renderer's chain gives it a picture.
            return { ok: true, embed: { url, kind: 'video', site: CLIP_SITE[clip.provider], title: CLIP_NOUN[clip.provider] } };
        }
        const page = parsePageMeta(html.text, html.finalUrl);
        const media = parseClipPage(html.text, clip.provider);
        const medal = clip.provider === 'medal' ? medalFacts(page.title, clip.pageUrl) : null;
        const title = medal ? medal.title : clipTitle(page.title, clip.provider);
        // The file's real shape: og:video:width/height, else the page picture's
        // (Tenor's GIF poster has the GIF's shape).
        const fromPage = !media?.width || !media?.height;
        const width = fromPage ? page.image?.width : media!.width;
        const height = fromPage ? page.image?.height : media!.height;
        // Tenor publishes GIFs as silent loops: readers draw them as GIFs.
        const loop = clip.provider === 'tenor';
        const embed: UnfurlDraft = {
            url, kind: 'video', site: CLIP_SITE[clip.provider],
            ...(title ? { title } : {}),
            ...(clip.provider !== 'medal' && page.description ? { description: page.description } : {}),
            ...(page.author ? { author: page.author } : {}),
            ...(medal?.game ? { tag: medal.game } : {}),
            ...(page.color ? { color: page.color } : {}),
            ...(media ? {
                media: {
                    url: media.url, mime: videoMime(media.url),
                    ...(width && height ? { width, height } : {}),
                    ...(page.durationS ? { duration_s: page.durationS } : {}),
                    ...(loop ? { loop: true } : {}),
                },
            } : {}),
        };
        if (!embed.title) embed.title = CLIP_NOUN[clip.provider];
        const image = await firstImage([page.image], deps);
        return snapshotable(await withPageFallback(href, { ok: true, embed, ...(image ? { image } : {}) }, deps));
    }

    // ── A media file, decided by its BYTES (2026-11-24): a ranged GET of its
    //    first bytes (media-probe.ts). The extension (tested on the path only,
    //    never the query: `a.gif?ex=...&hm=...`) and an expiring signature only
    //    say "probe it"; an extensionless link that answers with an image /
    //    video is caught by pageCard below. ──
    const path = new URL(href).pathname;
    // KLIPY's own media files: never fetched by the sender (readers' KLIPY rules).
    if (isKlipyMediaHost(href)) return { ok: false, reason: 'local' };
    if (DIRECT_MEDIA_RE.test(path) || isExpiringMediaUrl(href)) {
        const probe = await probeMedia(href, deps);
        if (probe.ok) {
            const r = await directMediaResult(url, href, probe, deps);
            if (r) return r;
            // HTML behind a media-looking link (i.imgur.com/<id> -> an imgur.com page): read it as a page.
            if (/^text\/html|^application\/xhtml/.test(probe.contentType)) return pageCard(url, href, deps);
            // Anything else (JSON, text, an AVIF): the link stays visible with its card / the reader's embed.
            return probe.facts ? { ok: false, reason: 'local' } : minimalCard(url, href, true, deps);
        }
        // A dead link (an expired Discord attachment: 404) gets the minimal card,
        // so readers see a card naming the site, never an empty image box.
        if (probe.reason === 'http') return minimalCard(url, href, true, deps);
        // Unreachable from here: as before (a video card the reader may still
        // play; an image the reader's own embed loads).
        if (DIRECT_VIDEO_RE.test(path)) return { ok: true, embed: { url, kind: 'video', site: hostLabel(href) || href, media: { url: href, mime: videoMime(href) } } };
        return { ok: false, reason: 'local' };
    }

    // ── Any other page: always a card (the minimal one when the page gave nothing) ──
    return pageCard(url, href, deps);
}
