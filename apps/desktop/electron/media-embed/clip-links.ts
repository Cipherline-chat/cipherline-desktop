/**
 * Clip PAGE links whose video can play inside Cipherline (docs/plans/embeds.md
 * phase 2), main-process copy.
 *
 * A clip page (medal.tv/…/clips/<id>) is HTML, not a video. On the RECEIVER's
 * click, main fetches the page and reads the video file it publishes
 * (clip-page.ts), or builds the file URL from the id where the provider has a
 * fixed pattern (Giphy, Imgur .gifv), and plays it through clmedia://.
 *
 * The renderer has its own copy of `clipLinkOf` (src/utils/mediaEmbed/
 * mediaLinks.ts): electron/ must not import from src/ (tsconfig rootDir, see
 * tsconfig.electron.json), and the renderer only uses it to choose the card.
 * THIS copy is the authority: main refuses any page URL it does not accept
 * itself. clip-links.parity.test.ts keeps the two in agreement.
 *
 * Verified against live pages on 2026-11-23 (fixtures in __fixtures__/):
 *   medal      og:video → medal.tv/api/content/<id>/socialVideoUrl (307 → signed cdn.medal.tv mp4);
 *              JSON-LD contentUrl → signed cdn.medal.tv/mediac/*.mp4 (307 → ugcc/content-concat/*.mp4).
 *              Signed `?auth=exp=…~hmac=…`, ~6.5 h lifetime, NOT referrer-checked, Range OK, H.264 + AAC.
 *   streamable og:video → signed CloudFront cdn-cf-*.streamable.com/video/*.mp4 (~3 days), Range OK.
 *   tenor      og:video → media.tenor.com/<id>/<slug>.mp4 (unsigned), Range OK.
 *   imgur      i.imgur.com/<id>.gifv → i.imgur.com/<id>.mp4 (pattern; the page says the same).
 *              imgur.com/<id> page: twitter:player:stream mp4 (its og:video is a .gif mislabelled video/mp4).
 *   giphy      the giphy.com page answers 403 to a non-browser TLS client, so the page is never fetched:
 *              media.giphy.com/media/<id>/giphy.mp4 is the documented rendition (Range OK).
 */

export type ClipProvider = 'medal' | 'streamable' | 'imgur' | 'tenor' | 'giphy';

export interface ClipLink {
    provider: ClipProvider;
    id: string;
    /** The canonical page to fetch, when the video has to be read from the page. */
    pageUrl: string | null;
    /** The video file, when the provider's pattern gives it without a page fetch. */
    directUrl: string | null;
}

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

/** The clip a page URL points at, or null. Pure; never fetches. */
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

/** Hosts a provider's clip PAGE may be served from (every redirect hop is checked). */
export function pageHostAllowed(provider: ClipProvider, hostname: string): boolean {
    const h = hostname.toLowerCase();
    switch (provider) {
        case 'medal': return h === 'medal.tv' || h === 'www.medal.tv';
        case 'streamable': return h === 'streamable.com' || h === 'www.streamable.com';
        case 'imgur': return h === 'imgur.com' || h === 'www.imgur.com';
        case 'tenor': return h === 'tenor.com' || h === 'www.tenor.com';
        case 'giphy': return false; // never fetched
    }
}

/**
 * Hosts a provider's VIDEO FILE may start on (defence in depth: a page that
 * names some other host is not played). Redirects while streaming are
 * SSRF-checked per hop like every clmedia request.
 */
export function mediaHostAllowed(provider: ClipProvider, hostname: string): boolean {
    const h = hostname.toLowerCase();
    switch (provider) {
        case 'medal': return h === 'cdn.medal.tv' || h === 'medal.tv';
        case 'streamable': return h.endsWith('.streamable.com');
        case 'imgur': return h === 'i.imgur.com';
        case 'tenor': return h === 'media.tenor.com' || /^media\d*\.tenor\.com$/.test(h) || h === 'c.tenor.com';
        case 'giphy': return h === 'media.giphy.com' || h === 'i.giphy.com' || /^media\d\.giphy\.com$/.test(h);
    }
}
