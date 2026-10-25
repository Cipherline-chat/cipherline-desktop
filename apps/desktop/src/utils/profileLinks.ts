/**
 * Profile links (Steam + socials) - client side.
 *
 * The SERVER enforces every rule (apps/api/src/auth/profile-links.ts) and
 * stores HANDLES only. This module mirrors the handle patterns and pasted-URL
 * extraction for live validation in the editor (`profileLinks.test.ts` reads
 * the API file and fails on drift), and owns the ONLY place a URL is built:
 * fixed https templates per platform, handle URL-encoded into one path
 * segment. There is no arbitrary-URL platform, so a link can only ever point
 * at the host its platform maps to.
 *
 * Ownership is not verified: the card says so ("Unverified").
 *
 * Opening goes through `openExternalLink` (the validated, https/mailto-only
 * path chat links use; the main process re-validates) and nothing else.
 */
import { openExternalLink, type OpenExternalResult } from './openExternalLink';

export const PROFILE_LINKS_MAX = 6;
export const LINK_INPUT_MAX_LEN = 200;

export const LINK_PLATFORMS = [
    'steam', 'x', 'instagram', 'tiktok', 'youtube', 'twitch', 'github', 'reddit', 'spotify', 'discord', 'bluesky', 'medal',
] as const;
export type LinkPlatform = (typeof LINK_PLATFORMS)[number];

export interface ProfileLink { platform: LinkPlatform; handle: string }

interface PlatformRule {
    label: string;
    handle: RegExp;
    hosts: readonly string[];
    path?: RegExp;
    atPrefix?: boolean;
    /** Shown in the input and the validation message. */
    placeholder: string;
    hint: string;
}

export const PLATFORM_RULES: Readonly<Record<LinkPlatform, PlatformRule>> = {
    steam: {
        label: 'Steam', handle: /^(?:\d{17}|(?=.*\D)[A-Za-z0-9_-]{2,32})$/,
        hosts: ['steamcommunity.com'], path: /^\/(?:id|profiles)\/([^/]+)\/?$/,
        placeholder: 'Custom id, SteamID64 or profile link', hint: 'a custom id (2-32 letters, digits, - or _), a 17-digit SteamID64, or your steamcommunity.com profile link',
    },
    x: {
        label: 'X', handle: /^[A-Za-z0-9_]{1,15}$/,
        hosts: ['x.com', 'twitter.com', 'mobile.twitter.com'], path: /^\/([^/]+)\/?$/, atPrefix: true,
        placeholder: '@handle', hint: '1-15 letters, digits or _',
    },
    instagram: {
        label: 'Instagram', handle: /^(?!\.)(?!.*\.\.)[A-Za-z0-9._]{1,30}(?<!\.)$/,
        hosts: ['instagram.com'], path: /^\/([^/]+)\/?$/, atPrefix: true,
        placeholder: '@handle', hint: '1-30 letters, digits, . or _ (no leading, trailing or double dots)',
    },
    tiktok: {
        label: 'TikTok', handle: /^[A-Za-z0-9._]{2,24}$/,
        hosts: ['tiktok.com'], path: /^\/@([^/]+)\/?$/, atPrefix: true,
        placeholder: '@handle', hint: '2-24 letters, digits, . or _',
    },
    youtube: {
        label: 'YouTube', handle: /^[A-Za-z0-9._-]{3,30}$/,
        hosts: ['youtube.com', 'm.youtube.com'], path: /^\/@([^/]+)\/?$/, atPrefix: true,
        placeholder: '@handle', hint: 'your @handle: 3-30 letters, digits, . _ or -',
    },
    twitch: {
        label: 'Twitch', handle: /^[A-Za-z0-9_]{4,25}$/,
        hosts: ['twitch.tv'], path: /^\/([^/]+)\/?$/, atPrefix: true,
        placeholder: 'username', hint: '4-25 letters, digits or _',
    },
    github: {
        label: 'GitHub', handle: /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
        hosts: ['github.com'], path: /^\/([^/]+)\/?$/,
        placeholder: 'username', hint: '1-39 letters, digits or single hyphens, not starting or ending with one',
    },
    reddit: {
        label: 'Reddit', handle: /^[A-Za-z0-9_-]{3,20}$/,
        hosts: ['reddit.com', 'old.reddit.com'], path: /^\/(?:u|user)\/([^/]+)\/?$/,
        placeholder: 'username (without u/)', hint: '3-20 letters, digits, _ or -',
    },
    spotify: {
        label: 'Spotify', handle: /^[A-Za-z0-9_.-]{1,40}$/,
        hosts: ['open.spotify.com'], path: /^\/user\/([^/]+)\/?$/,
        placeholder: 'user id or profile link', hint: 'your Spotify user id (up to 40 letters, digits, . _ or -)',
    },
    discord: {
        label: 'Discord', handle: /^[a-z0-9_.]{2,32}$/, hosts: [],
        placeholder: 'username', hint: 'your lowercase username: 2-32 letters, digits, . or _ (shown as text, never a link)',
    },
    bluesky: {
        label: 'Bluesky', handle: /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
        hosts: ['bsky.app'], path: /^\/profile\/([^/]+)\/?$/,
        placeholder: 'name.bsky.social', hint: 'your lowercase handle, like name.bsky.social',
    },
    medal: {
        label: 'Medal', handle: /^[A-Za-z0-9_.-]{2,32}$/,
        hosts: ['medal.tv'], path: /^\/(?:u|users)\/([^/]+)\/?$/, atPrefix: true,
        placeholder: 'username or medal.tv link', hint: '2-32 letters, digits, . _ or -',
    },
};

export const platformLabel = (p: LinkPlatform): string => PLATFORM_RULES[p].label;

export const isLinkPlatform = (p: unknown): p is LinkPlatform =>
    typeof p === 'string' && (LINK_PLATFORMS as readonly string[]).includes(p);

export function isValidHandle(platform: LinkPlatform, handle: unknown): handle is string {
    return typeof handle === 'string' && PLATFORM_RULES[platform].handle.test(handle);
}

/** Same extraction as the server: a handle or a pasted profile URL on the platform's own host. Null = not acceptable. */
export function parseLinkInput(platform: LinkPlatform, raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const rule = PLATFORM_RULES[platform];
    let s = raw.trim();
    if (!s || s.length > LINK_INPUT_MAX_LEN) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) {
        if (!rule.path) return null;
        let u: URL;
        try { u = new URL(s); } catch { return null; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (u.username || u.password || u.port) return null;
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        if (!rule.hosts.includes(host)) return null;
        const m = rule.path.exec(u.pathname);
        if (!m) return null;
        try { s = decodeURIComponent(m[1]); } catch { return null; }
    } else if (rule.atPrefix && s.startsWith('@')) {
        s = s.slice(1);
    }
    return rule.handle.test(s) ? s : null;
}

/**
 * A pasted profile URL -> the platform it belongs to (and its handle), so the
 * editor can switch the picker for you. Only the closed allow-list: a URL on
 * any other host is null, never guessed at.
 */
export function detectPlatform(raw: string): { platform: LinkPlatform; handle: string } | null {
    const s = raw.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(s)) return null;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
    for (const p of LINK_PLATFORMS) {
        if (!PLATFORM_RULES[p].hosts.length) continue;
        const handle = parseLinkInput(p, url);
        if (handle !== null) return { platform: p, handle };
    }
    return null;
}

export type LinkInputCheck = { ok: true; handle: string } | { ok: false; message: string };

/** Live validation for the editor: the extracted handle, or why not. Empty input is not an error (nothing to add yet). */
export function checkLinkInput(platform: LinkPlatform, raw: string): LinkInputCheck | null {
    if (!raw.trim()) return null;
    const handle = parseLinkInput(platform, raw);
    if (handle !== null) return { ok: true, handle };
    const rule = PLATFORM_RULES[platform];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) || raw.trim().startsWith('//')) {
        return {
            ok: false,
            message: rule.hosts.length
                ? `Paste a ${rule.label} profile link (${rule.hosts[0]}) or just the handle. Other websites are not allowed.`
                : `${rule.label} has no profile link. Enter just the username.`,
        };
    }
    return { ok: false, message: `${rule.label}: use ${rule.hint}.` };
}

/** Stored/server value -> well-formed links only (mirror of the server's readLinks). */
export function sanitizeLinks(stored: unknown): ProfileLink[] {
    if (!Array.isArray(stored)) return [];
    const out: ProfileLink[] = [];
    for (const e of stored) {
        if (!e || typeof e !== 'object') continue;
        const { platform, handle } = e as Record<string, unknown>;
        if (isLinkPlatform(platform) && isValidHandle(platform, handle)) out.push({ platform, handle });
        if (out.length >= PROFILE_LINKS_MAX) break;
    }
    return out;
}

/** The text a chip shows: `@name` where the platform displays one, the handle otherwise. */
export function displayHandle(link: ProfileLink): string {
    return PLATFORM_RULES[link.platform].atPrefix ? `@${link.handle}` : link.handle;
}

/**
 * The ONLY URL builder: fixed https template per platform, the handle
 * encodeURIComponent'd into a single path segment. Null for Discord (text
 * only) and for anything that is not a well-formed stored link.
 */
/** A VERIFIED Steam account's page (SteamID64 only; anything else falls back to Steam's home). */
export const steamProfileUrl = (steamId: string): string =>
    (/^7656119\d{10}$/.test(steamId) ? `https://steamcommunity.com/profiles/${steamId}` : 'https://steamcommunity.com/');

export function profileLinkUrl(link: ProfileLink): string | null {
    if (!isLinkPlatform(link.platform) || !isValidHandle(link.platform, link.handle)) return null;
    const h = encodeURIComponent(link.handle);
    switch (link.platform) {
        case 'steam': return /^\d{17}$/.test(link.handle) ? `https://steamcommunity.com/profiles/${h}` : `https://steamcommunity.com/id/${h}`;
        case 'x': return `https://x.com/${h}`;
        case 'instagram': return `https://www.instagram.com/${h}/`;
        case 'tiktok': return `https://www.tiktok.com/@${h}`;
        case 'youtube': return `https://www.youtube.com/@${h}`;
        case 'twitch': return `https://www.twitch.tv/${h}`;
        case 'github': return `https://github.com/${h}`;
        case 'reddit': return `https://www.reddit.com/user/${h}`;
        case 'spotify': return `https://open.spotify.com/user/${h}`;
        case 'bluesky': return `https://bsky.app/profile/${h}`;
        case 'medal': return `https://medal.tv/u/${h}`;
        case 'discord': return null;
        default: return null;
    }
}

/**
 * Open a profile link in the system browser through the app's validated
 * external-link path (the same one chat links use). Never builds a URL from
 * anything but a well-formed stored link; returns false when there is nothing
 * to open (Discord, malformed) or the validator refused.
 */
export function openProfileLink(link: ProfileLink): boolean {
    const url = profileLinkUrl(link);
    if (!url) return false;
    const result: OpenExternalResult = openExternalLink(url);
    return result.ok;
}
