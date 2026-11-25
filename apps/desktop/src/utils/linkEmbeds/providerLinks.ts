/**
 * Links to the phase-4 providers (docs/plans/embeds.md §7 phase 4): Twitch,
 * X / Twitter, TikTok and Reddit. Pure; never fetches.
 *
 * Renderer copy. The main process has its own (electron/unfurl/
 * provider-links.ts): electron/ and src/ may not import each other
 * (tsconfig rootDir). provider-links.parity.test.ts runs both over one table.
 * The renderer's copy is the one that matters for safety: a READER derives
 * the player id from the visible link itself and refuses an embed whose id
 * does not match, so a message cannot point a player at some other video.
 */

export type TwitchRef =
    | { kind: 'clip'; slug: string; channel: string | null }
    | { kind: 'video'; id: string }
    | { kind: 'channel'; login: string };

export interface XStatusRef { id: string; handle: string | null }
export interface TikTokRef { id: string | null; handle: string | null; short: boolean }
export interface RedditRef { id: string | null; sub: string | null; share: string | null }

const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv']);
/** First path segments on twitch.tv that are app pages, never a channel. */
const TWITCH_RESERVED = new Set([
    'directory', 'videos', 'settings', 'p', 'downloads', 'jobs', 'search', 'login', 'signup', 'subscriptions',
    'inventory', 'wallet', 'drops', 'friends', 'messages', 'payments', 'prime', 'turbo', 'store', 'team', 'u',
    'moderator', 'popout', 'embed', 'broadcast', 'user', 'privacy', 'legal', 'clip', 'clips', 'creatorcamp',
    'following', 'collections', 'bits', 'partner', 'redeem', 'activate', 'products', 'event', 'events', 'about',
    'security', 'dashboard', 'manager', 'help', 'logout', 'passport-callback', 'twitchcon',
]);
const SLUG_RE = /^[A-Za-z0-9_-]{3,100}$/;
const LOGIN_RE = /^[A-Za-z0-9_]{1,25}$/;

function parseHttps(raw: unknown): URL | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    return u;
}
const segsOf = (u: URL) => u.pathname.split('/').filter(Boolean);

/** A Twitch clip, VOD or channel link, or null. */
export function twitchRefOf(raw: unknown): TwitchRef | null {
    const u = parseHttps(raw);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    const s = segsOf(u);
    if (host === 'clips.twitch.tv') {
        if (s.length !== 1 || s[0] === 'embed' || !SLUG_RE.test(s[0])) return null;
        return { kind: 'clip', slug: s[0], channel: null };
    }
    if (!TWITCH_HOSTS.has(host)) return null;
    if (s[0] === 'videos' && s.length === 2 && /^\d{1,15}$/.test(s[1])) return { kind: 'video', id: s[1] };
    if (s[0] === 'clip' && s.length === 2 && SLUG_RE.test(s[1])) return { kind: 'clip', slug: s[1], channel: null };
    if (s.length === 3 && s[1] === 'clip' && LOGIN_RE.test(s[0]) && SLUG_RE.test(s[2]) && !TWITCH_RESERVED.has(s[0].toLowerCase())) {
        return { kind: 'clip', slug: s[2], channel: s[0].toLowerCase() };
    }
    if (s.length === 3 && s[1] === 'v' && /^\d{1,15}$/.test(s[2])) return { kind: 'video', id: s[2] };
    if (s.length === 1 && LOGIN_RE.test(s[0]) && !TWITCH_RESERVED.has(s[0].toLowerCase())) return { kind: 'channel', login: s[0].toLowerCase() };
    return null;
}

/** The `player.id` a Twitch link gets (packages/shared isLinkEmbedPlayerId). */
export function twitchPlayerId(ref: TwitchRef): string {
    return ref.kind === 'clip' ? `clip:${ref.slug}` : ref.kind === 'video' ? `video:${ref.id}` : `channel:${ref.login}`;
}

/** Only X's own hosts: a mirror (fxtwitter, vxtwitter…) is a different site the reader would open. */
const X_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** An X / Twitter status (tweet) link, or null. */
export function xStatusRefOf(raw: unknown): XStatusRef | null {
    const u = parseHttps(raw);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    if (!X_HOSTS.has(host)) return null;
    const s = segsOf(u);
    if (s[0] === 'i' && (s[1] === 'status' || (s[1] === 'web' && s[2] === 'status'))) {
        const id = s[1] === 'status' ? s[2] : s[3];
        return id && /^\d{1,20}$/.test(id) ? { id, handle: null } : null;
    }
    if (s.length >= 3 && (s[1] === 'status' || s[1] === 'statuses') && X_HANDLE_RE.test(s[0]) && /^\d{1,20}$/.test(s[2])) {
        const rest = s.slice(3);
        if (rest.length && !(rest.length === 2 && (rest[0] === 'photo' || rest[0] === 'video') && /^[1-4]$/.test(rest[1]))) return null;
        return { id: s[2], handle: s[0] };
    }
    return null;
}

const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const TIKTOK_SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

/** A TikTok video link (id known), or a short share link (id only after its redirect), or null. */
export function tikTokRefOf(raw: unknown): TikTokRef | null {
    const u = parseHttps(raw);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    const s = segsOf(u);
    if (TIKTOK_SHORT_HOSTS.has(host)) return s.length === 1 && /^[A-Za-z0-9]{5,16}$/.test(s[0]) ? { id: null, handle: null, short: true } : null;
    if (!TIKTOK_HOSTS.has(host)) return null;
    if (s[0] === 't' && s.length === 2 && /^[A-Za-z0-9]{5,16}$/.test(s[1])) return { id: null, handle: null, short: true };
    if (s.length === 3 && /^@[A-Za-z0-9_.]{1,30}$/.test(s[0]) && s[1] === 'video' && /^\d{10,25}$/.test(s[2])) {
        return { id: s[2], handle: s[0].slice(1), short: false };
    }
    if (s.length === 3 && s[0] === 'embed' && s[1] === 'v2' && /^\d{10,25}$/.test(s[2])) return { id: s[2], handle: null, short: false };
    if (s.length === 2 && s[0] === 'v' && /^\d{10,25}\.html$/.test(s[1])) return { id: s[1].slice(0, -5), handle: null, short: false };
    return null;
}

const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com', 'sh.reddit.com']);
const SUB_RE = /^[A-Za-z0-9_]{2,21}$/;
const POST_ID_RE = /^[a-z0-9]{4,10}$/i;

/** A Reddit post link (or a /s/ share link, whose post is known only after its redirect), or null. */
export function redditRefOf(raw: unknown): RedditRef | null {
    const u = parseHttps(raw);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    const s = segsOf(u);
    if (host === 'redd.it') return s.length === 1 && POST_ID_RE.test(s[0]) ? { id: s[0].toLowerCase(), sub: null, share: null } : null;
    if (!REDDIT_HOSTS.has(host)) return null;
    if (s[0] === 'comments' && s[1] && POST_ID_RE.test(s[1]) && s.length <= 3) return { id: s[1].toLowerCase(), sub: null, share: null };
    if (s[0] === 'r' && s[1] && SUB_RE.test(s[1])) {
        if (s[2] === 'comments' && s[3] && POST_ID_RE.test(s[3]) && s.length <= 5) return { id: s[3].toLowerCase(), sub: s[1], share: null };
        if (s[2] === 's' && s.length === 4 && /^[A-Za-z0-9]{6,16}$/.test(s[3])) return { id: null, sub: s[1], share: s[3] };
    }
    return null;
}

/** The canonical post URL Reddit's endpoints are asked about. */
export function redditCanonicalUrl(ref: RedditRef): string | null {
    if (!ref.id) return null;
    return ref.sub ? `https://www.reddit.com/r/${ref.sub}/comments/${ref.id}/` : `https://www.reddit.com/comments/${ref.id}/`;
}
