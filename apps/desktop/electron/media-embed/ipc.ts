/**
 * IPC surface of the link embeds (main process). docs/plans/embeds.md.
 *
 * Pure of `electron` (ipcMain and the fetch are injected) so the contract is
 * unit-tested; main.ts only wires `registerLinkEmbedIpc`. The global sender
 * guard (ipc-guard.ts) wraps `ipcMain.handle`, so every channel here is
 * origin-checked by construction. Every argument is validated here; a bad one
 * gets a quiet null / `{ ok: false }`, never a thrown error with detail.
 *
 *   embed:youtube-oembed  id → { title, author } | null
 *   embed:register-media  (url, kind) → clmedia:// URL for a DIRECT media link
 *                         the renderer is showing (https). 2026-11-24: by
 *                         content, not extension (an extensionless link the
 *                         sender found to be a video): a media extension of the
 *                         kind, or NO extension at all; the protocol still
 *                         serves only a real video/* or image/* response
 *                         (media-protocol.ts servedType)
 *   embed:resolve-clip    pageUrl → clmedia:// URL of the video a supported
 *                         clip page publishes (clip-links.ts, clip-page.ts),
 *                         fetched on the receiver's click
 *   embed:register-clip-media  (pageUrl, mediaUrl) → clmedia:// URL for the
 *                         video file a SENDER's embed named for a supported
 *                         clip page (phase 3): played with no page fetch, and
 *                         only when the file is on that provider's own media
 *                         hosts (mediaHostAllowed). A signed URL that has
 *                         expired fails at play time; the renderer then falls
 *                         back to embed:resolve-clip.
 *   embed:register-thumb-media  (pageUrl, mediaUrl) → clmedia:// URL for the
 *                         SENDER's frame grab (2026-11-24, embeds-always-thumb):
 *                         the video file its own unfurler found for a clip page,
 *                         an X / Reddit post, or a direct video link (then
 *                         mediaUrl === pageUrl). Same host rules as playing it;
 *                         a fresh entry every time with a byte budget
 *                         (FRAME_GRAB_BUDGET_BYTES), so a grab streams the
 *                         file's index and a few frames, never the whole clip.
 */
import { fetchTextPinned, type FetchDeps } from './pinned-fetch';
import { isYouTubeId, parseYouTubeOEmbed, youTubeOEmbedUrl, type YouTubeMeta } from './youtube-oembed';
import { clipLinkOf, mediaHostAllowed, pageHostAllowed } from './clip-links';
import { parseClipPage, type ClipMedia } from './clip-page';
import type { MediaRegistry } from './media-registry';
import { redditRefOf, xStatusRefOf } from '../unfurl/provider-links';

export const LINK_EMBED_CHANNELS = {
    youtubeOEmbed: 'embed:youtube-oembed',
    registerMedia: 'embed:register-media',
    resolveClip: 'embed:resolve-clip',
    registerClipMedia: 'embed:register-clip-media',
    registerPostMedia: 'embed:register-post-media',
    registerThumbMedia: 'embed:register-thumb-media',
} as const;

/** What one frame grab may stream in total (its index + 2-3 seeks of a 1080p clip, with room). */
export const FRAME_GRAB_BUDGET_BYTES = 24 * 1024 * 1024;

export interface IpcMainLike {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface LinkEmbedIpcDeps {
    fetchDeps?: FetchDeps;
    /** Required for register-media / resolve-clip. */
    registry?: MediaRegistry;
    now?: () => number;
}

const OEMBED_TIMEOUT_MS = 4000;
const OEMBED_MAX_BYTES = 64 * 1024;
const PAGE_TIMEOUT_MS = 4000;
const PAGE_MAX_BYTES = 512 * 1024;
const CLIP_CACHE_TTL_MS = 20 * 60_000;
const CLIP_CACHE_MAX = 64;

const VIDEO_PATH_RE = /\.(mp4|m4v|webm|mov)$/i;
const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|avif)$/i;
/** The last path segment has an extension. */
const NO_EXT_RE = /\.[a-z0-9]{1,6}$/i;

export async function youTubeMetaFor(id: unknown, deps: LinkEmbedIpcDeps = {}): Promise<YouTubeMeta | null> {
    if (!isYouTubeId(id)) return null;
    try {
        const { text } = await fetchTextPinned(youTubeOEmbedUrl(id), {
            accept: 'application/json',
            allowedTypes: ['application/json', 'text/json'],
            maxBytes: OEMBED_MAX_BYTES,
            timeoutMs: OEMBED_TIMEOUT_MS,
            maxRedirects: 2,
            truncate: false,
            hostAllowed: (h) => h === 'www.youtube.com' || h === 'youtube.com',
        }, deps.fetchDeps);
        return parseYouTubeOEmbed(text);
    } catch {
        return null;
    }
}

export type RegisterResult = { ok: true; src: string } | { ok: false };

/** A direct media link (the URL itself is the file). */
export function registerDirectMedia(url: unknown, kind: unknown, deps: LinkEmbedIpcDeps): RegisterResult {
    if (!deps.registry) return { ok: false };
    if (typeof url !== 'string') return { ok: false };
    let path: string;
    try { path = new URL(url).pathname; } catch { return { ok: false }; }
    // By content (2026-11-24): the kind's extension, or none at all (media-protocol.ts serves only a
    // response whose type is the kind's; octet-stream only for a matching extension).
    const bare = !NO_EXT_RE.test(path);
    if (kind === 'video' ? !(VIDEO_PATH_RE.test(path) || bare) : kind === 'image' ? !(IMAGE_PATH_RE.test(path) || bare) : true) return { ok: false };
    try {
        return { ok: true, src: deps.registry.register(url, kind) };
    } catch {
        return { ok: false };
    }
}

/**
 * A sender-supplied video file for a clip page (packages/shared link-embeds
 * `media.url`). The page URL must be a supported clip page, and the file an
 * https video on THAT provider's media hosts; anything else is refused.
 */
export function registerSenderClipMedia(pageUrl: unknown, mediaUrl: unknown, deps: LinkEmbedIpcDeps): RegisterResult {
    if (!deps.registry) return { ok: false };
    const link = clipLinkOf(pageUrl);
    if (!link || typeof mediaUrl !== 'string' || mediaUrl.length > 2048) return { ok: false };
    let u: URL;
    try { u = new URL(mediaUrl); } catch { return { ok: false }; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return { ok: false };
    if (!mediaHostAllowed(link.provider, u.hostname)) return { ok: false };
    if (IMAGE_PATH_RE.test(u.pathname)) return { ok: false };
    try {
        return { ok: true, src: deps.registry.register(u.href, 'video', (h) => mediaHostAllowed(link.provider, h)) };
    } catch {
        return { ok: false };
    }
}

/** Video hosts a post's media may be on, per provider (phase 4). */
export function postMediaHostAllowed(provider: 'x' | 'reddit', hostname: string): boolean {
    const h = hostname.toLowerCase();
    return provider === 'x' ? h === 'video.twimg.com' : h === 'v.redd.it';
}

/**
 * A sender-supplied video file for a POST (phase 4): an X / Twitter status or
 * a Reddit post. The page URL must be one (main's own parse), and the file an
 * https video on that provider's own media host (video.twimg.com, v.redd.it);
 * anything else is refused. Every redirect while streaming is held to the same
 * host rule (plus the usual SSRF check).
 */
export function registerSenderPostMedia(pageUrl: unknown, mediaUrl: unknown, deps: LinkEmbedIpcDeps): RegisterResult {
    if (!deps.registry) return { ok: false };
    const provider = xStatusRefOf(pageUrl) ? 'x' : redditRefOf(pageUrl) ? 'reddit' : null;
    if (!provider || typeof mediaUrl !== 'string' || mediaUrl.length > 2048) return { ok: false };
    let u: URL;
    try { u = new URL(mediaUrl); } catch { return { ok: false }; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return { ok: false };
    if (!postMediaHostAllowed(provider, u.hostname) || !VIDEO_PATH_RE.test(u.pathname)) return { ok: false };
    try {
        return { ok: true, src: deps.registry.register(u.href, 'video', (h) => postMediaHostAllowed(provider, h)) };
    } catch {
        return { ok: false };
    }
}

/**
 * The video file a SENDER's frame grab may stream (see the header), with a
 * fresh byte-budgeted registration. Refused: anything that is not a clip page,
 * a post, or a direct video link naming itself; a file off that provider's
 * media hosts; an image path.
 */
export function registerThumbMedia(pageUrl: unknown, mediaUrl: unknown, deps: LinkEmbedIpcDeps): RegisterResult {
    if (!deps.registry || typeof pageUrl !== 'string' || typeof mediaUrl !== 'string' || mediaUrl.length > 2048) return { ok: false };
    let u: URL;
    try { u = new URL(mediaUrl); } catch { return { ok: false }; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return { ok: false };
    if (IMAGE_PATH_RE.test(u.pathname)) return { ok: false };
    let hostAllowed: ((h: string) => boolean) | undefined;
    const clip = clipLinkOf(pageUrl);
    const post = xStatusRefOf(pageUrl) ? 'x' : redditRefOf(pageUrl) ? 'reddit' : null;
    if (clip) {
        if (!mediaHostAllowed(clip.provider, u.hostname)) return { ok: false };
        hostAllowed = (h) => mediaHostAllowed(clip.provider, h);
    } else if (post) {
        if (!postMediaHostAllowed(post, u.hostname) || !VIDEO_PATH_RE.test(u.pathname)) return { ok: false };
        hostAllowed = (h) => postMediaHostAllowed(post, h);
    } else if (pageUrl !== mediaUrl || !(VIDEO_PATH_RE.test(u.pathname) || !NO_EXT_RE.test(u.pathname))) {
        // Only a direct video link naming itself: a video extension, or none (decided by its
        // bytes, 2026-11-24). The protocol serves only a real video/* response, within the budget.
        return { ok: false };
    }
    try {
        return { ok: true, src: deps.registry.register(u.href, 'video', hostAllowed, { budgetBytes: FRAME_GRAB_BUDGET_BYTES }) };
    } catch {
        return { ok: false };
    }
}

export type ResolveResult =
    | { ok: true; src: string; width?: number; height?: number; title?: string }
    | { ok: false; reason: 'unsupported' | 'no-media' | 'failed' };

/** Clip-page resolution, cached per clip (signed URLs last hours; 20 min is well inside). */
export function createClipResolver(deps: LinkEmbedIpcDeps) {
    const now = deps.now ?? Date.now;
    const cache = new Map<string, { media: ClipMedia; at: number }>();
    const inFlight = new Map<string, Promise<ClipMedia | null>>();

    async function mediaFor(key: string, pageUrl: string, provider: Parameters<typeof parseClipPage>[1]): Promise<ClipMedia | null> {
        const hit = cache.get(key);
        if (hit && now() - hit.at < CLIP_CACHE_TTL_MS) return hit.media;
        const joined = inFlight.get(key);
        if (joined) return joined;
        const p = (async () => {
            const { text } = await fetchTextPinned(pageUrl, {
                accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
                allowedTypes: ['text/html', 'application/xhtml+xml'],
                maxBytes: PAGE_MAX_BYTES,
                timeoutMs: PAGE_TIMEOUT_MS,
                maxRedirects: 3,
                truncate: true,
                hostAllowed: (h) => pageHostAllowed(provider, h),
            }, deps.fetchDeps);
            const media = parseClipPage(text, provider);
            if (media) {
                cache.set(key, { media, at: now() });
                while (cache.size > CLIP_CACHE_MAX) cache.delete(cache.keys().next().value as string);
            }
            return media;
        })();
        inFlight.set(key, p);
        try { return await p; } finally { inFlight.delete(key); }
    }

    return async function resolveClip(pageUrl: unknown): Promise<ResolveResult> {
        const link = clipLinkOf(pageUrl);
        if (!link || !deps.registry) return { ok: false, reason: 'unsupported' };
        let media: ClipMedia | null;
        try {
            media = link.directUrl ? { url: link.directUrl } : await mediaFor(`${link.provider}:${link.id}`, link.pageUrl!, link.provider);
        } catch {
            return { ok: false, reason: 'failed' };
        }
        if (!media) return { ok: false, reason: 'no-media' };
        try {
            const src = deps.registry.register(media.url, 'video', (h) => mediaHostAllowed(link.provider, h));
            return { ok: true, src, ...(media.width ? { width: media.width } : {}), ...(media.height ? { height: media.height } : {}), ...(media.title ? { title: media.title } : {}) };
        } catch {
            return { ok: false, reason: 'no-media' };
        }
    };
}

export function registerLinkEmbedIpc(ipcMain: IpcMainLike, deps: LinkEmbedIpcDeps = {}): void {
    const resolveClip = createClipResolver(deps);
    ipcMain.handle(LINK_EMBED_CHANNELS.youtubeOEmbed, (_e, id) => youTubeMetaFor(id, deps));
    ipcMain.handle(LINK_EMBED_CHANNELS.registerMedia, (_e, url, kind) => registerDirectMedia(url, kind, deps));
    ipcMain.handle(LINK_EMBED_CHANNELS.resolveClip, (_e, pageUrl) => resolveClip(pageUrl));
    ipcMain.handle(LINK_EMBED_CHANNELS.registerClipMedia, (_e, pageUrl, mediaUrl) => registerSenderClipMedia(pageUrl, mediaUrl, deps));
    ipcMain.handle(LINK_EMBED_CHANNELS.registerPostMedia, (_e, pageUrl, mediaUrl) => registerSenderPostMedia(pageUrl, mediaUrl, deps));
    ipcMain.handle(LINK_EMBED_CHANNELS.registerThumbMedia, (_e, pageUrl, mediaUrl) => registerThumbMedia(pageUrl, mediaUrl, deps));
}
