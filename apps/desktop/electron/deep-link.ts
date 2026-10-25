/**
 * `cipherline://` deep-link parsing (invite / referral), shared by the
 * cold-start argv path, macOS `open-url`, `second-instance` and the loopback
 * handoff endpoint.
 *
 * Every one of those sources is attacker-reachable in some form — any web page
 * can navigate to a `cipherline://` URL, any local process can launch the app
 * with one — so the code is validated here, at the parse site, against the
 * same charset the clipboard/argv attribution parser uses
 * (attribution-link.ts): base64url, 4-64 characters. Anything else is not one
 * of our links and is dropped before it reaches the renderer.
 *
 * No `electron` import (unit-testable).
 */

/** Invite and referral codes: base64url, as the API generates them. */
export const DEEP_LINK_CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** No real deep link is anywhere near this long. */
export const MAX_DEEP_LINK_LENGTH = 512;

function codeFor(url: unknown, host: 'invite' | 'ref'): string | null {
    if (typeof url !== 'string' || url.length > MAX_DEEP_LINK_LENGTH) return null;
    try {
        const u = new URL(url);
        if (u.protocol !== 'cipherline:') return null;
        if (u.host !== host) return null;
        if (u.search || u.hash || u.username || u.password || u.port) return null;
        const code = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').trim();
        return DEEP_LINK_CODE_RE.test(code) ? code : null;
    } catch {
        return null;
    }
}

/** `cipherline://invite/<CODE>` → the invite code, or null. */
export function parseInviteUrl(url: unknown): string | null {
    return codeFor(url, 'invite');
}

/** `cipherline://ref/<CODE>` → the referral code (upper-cased), or null. */
export function parseReferralUrl(url: unknown): string | null {
    const code = codeFor(url, 'ref');
    return code ? code.toUpperCase() : null;
}

/**
 * The first `cipherline://` argument in a process argv (Windows/Linux pass the
 * URL as an argument on a protocol launch). Only an argument that is itself a
 * plausible URL is returned; switches are never interpreted here.
 */
export function extractDeepLinkFromArgv(argv: readonly unknown[]): string | null {
    for (const arg of argv) {
        if (typeof arg !== 'string') continue;
        if (!arg.startsWith('cipherline://')) continue;
        if (arg.length > MAX_DEEP_LINK_LENGTH || /[\s"]/.test(arg)) continue;
        return arg;
    }
    return null;
}

/**
 * What `shell:open-external` hands to the OS: the PARSED href, so the string
 * that was validated is the string that is launched. https and mailto only.
 */
export function externalUrlToOpen(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return null; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') return null;
    if (parsed.protocol === 'https:' && (parsed.username || parsed.password)) return null;
    return parsed.href;
}
