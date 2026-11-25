/**
 * Which links play as video inside the chat (docs/plans/embeds.md phase 2).
 * Pure; never fetches.
 *
 *  - Direct video files: an https URL whose path ends .mp4 / .m4v / .webm / .mov.
 *  - Clip PAGES with a known video file: Medal, Streamable, Imgur (.gifv and
 *    single-image pages), Tenor and Giphy. The page is resolved to its file by
 *    the main process ON CLICK (electron/media-embed/clip-links.ts, which is
 *    the authority: it refuses anything its own copy of these rules rejects).
 *
 * `clipLinkOf` is a deliberate copy of electron/media-embed/clip-links.ts's
 * (electron/ and src/ may not import each other; tsconfig rootDir). The
 * parity test electron/media-embed/clip-links.parity.test.ts runs both over
 * one table, so they cannot drift apart silently.
 */
import { safeDisplayFilename } from '../fileSafety';

export type ClipProvider = 'medal' | 'streamable' | 'imgur' | 'tenor' | 'giphy';

export interface ClipLink {
    provider: ClipProvider;
    id: string;
    pageUrl: string | null;
    directUrl: string | null;
}

export const CLIP_PROVIDER_LABEL: Record<ClipProvider, string> = {
    medal: 'Medal',
    streamable: 'Streamable',
    imgur: 'Imgur',
    tenor: 'Tenor',
    giphy: 'GIPHY',
};

const STREAMABLE_RESERVED = new Set(['login', 'signup', 'pricing', 'about', 'upload', 'settings', 'terms', 'privacy',
    'documentation', 'blog', 'careers', 'help', 'contact', 'videos', 'clipper', 'free', 'static', 'api']);
const IMGUR_RESERVED = new Set(['upload', 'about', 'apps', 'privacy', 'tos', 'rules', 'signin', 'register', 'search',
    'hot', 'new', 'top', 'random', 'memegen', 'vidgif', 'emerald', 'gallery', 'user', 'account', 'download']);

function parseHttps(raw: unknown): URL | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    return u;
}

export function clipLinkOf(raw: unknown): ClipLink | null {
    const u = parseHttps(raw);
    if (!u) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname;
    let m: RegExpExecArray | null;

    if (host === 'medal.tv') {
        m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:games\/[a-z0-9-]{1,64}\/)?clips?\/([A-Za-z0-9_-]{4,40})(?:\/[^/]*)?\/?$/i.exec(path);
        if (!m) return null;
        return { provider: 'medal', id: m[1], pageUrl: `https://medal.tv${path}`, directUrl: null };
    }
    if (host === 'streamable.com') {
        m = /^\/(?:e\/)?([a-z0-9]{3,12})\/?$/i.exec(path);
        if (!m || STREAMABLE_RESERVED.has(m[1].toLowerCase())) return null;
        return { provider: 'streamable', id: m[1], pageUrl: `https://streamable.com/${m[1]}`, directUrl: null };
    }
    if (host === 'i.imgur.com') {
        m = /^\/([A-Za-z0-9]{5,10})\.gifv$/.exec(path);
        if (!m) return null;
        return { provider: 'imgur', id: m[1], pageUrl: null, directUrl: `https://i.imgur.com/${m[1]}.mp4` };
    }
    if (host === 'imgur.com') {
        m = /^\/([A-Za-z0-9]{5,10})\/?$/.exec(path);
        if (!m || IMGUR_RESERVED.has(m[1].toLowerCase())) return null;
        return { provider: 'imgur', id: m[1], pageUrl: `https://imgur.com/${m[1]}`, directUrl: null };
    }
    if (host === 'tenor.com') {
        m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?view\/[A-Za-z0-9%_-]*-(\d{5,25})\/?$/i.exec(path);
        if (!m) return null;
        return { provider: 'tenor', id: m[1], pageUrl: `https://tenor.com${path}`, directUrl: null };
    }
    if (host === 'giphy.com') {
        m = /^\/(?:gifs\/(?:[A-Za-z0-9_-]*-)?|embed\/)([A-Za-z0-9]{6,40})\/?$/.exec(path);
        if (!m) return null;
        return { provider: 'giphy', id: m[1], pageUrl: null, directUrl: `https://media.giphy.com/media/${m[1]}/giphy.mp4` };
    }
    return null;
}

/**
 * GIF-like video loops (owner, 2026-11-23): Tenor and Giphy pages and Imgur
 * .gifv links are GIFs published as short muted mp4 loops. They behave like
 * GIFs (inline, muted, looping, playing under the app's GIF rule), not like
 * click-to-play videos. Returns the CDN host the loop streams from, for the
 * image auto-load decision, or null for anything else (Imgur PAGES can be
 * real videos with sound: those stay click-to-play).
 */
export function gifLoopMediaHost(link: ClipLink | null): string | null {
    if (!link) return null;
    if (link.provider === 'tenor') return 'media.tenor.com';
    if (link.provider === 'giphy') return 'media.giphy.com';
    if (link.provider === 'imgur' && link.directUrl) return 'i.imgur.com';
    return null;
}

const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov)$/i;

/** An https link straight to a video file (the main process plays only https). */
export function isDirectVideoUrl(raw: string): boolean {
    const u = parseHttps(raw);
    return !!u && VIDEO_EXT_RE.test(u.pathname);
}

/** What the facade calls a direct file: its decoded file name and host. */
export function mediaCaption(raw: string): { name: string; host: string } {
    try {
        const u = new URL(raw);
        const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
        let name = last;
        try { name = decodeURIComponent(last); } catch { /* keep encoded */ }
        name = safeDisplayFilename(name);
        if (name.length > 80) name = `${name.slice(0, 79)}…`;
        return { name, host: u.hostname.replace(/^www\./, '') };
    } catch {
        return { name: 'video', host: '' };
    }
}
