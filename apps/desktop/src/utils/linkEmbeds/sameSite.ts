/**
 * Is a sender-named media file on the SAME SITE as the visible link
 * (2026-11-24, embeds-media-everywhere)? A sender-built embed names the file
 * to play (`media.url`); for a link that is not a known provider, a reader
 * only loads / plays a file the link's own site serves
 * (example.com/page → cdn.example.com/a.mp4), so a message
 * cannot make a reader fetch an unrelated host it never showed. Approximate
 * registrable domain: the last two labels, three when the second-level label
 * is a short public suffix part (co.uk, com.au, …). Pure, never throws.
 */
const SHORT_SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

export function siteOf(hostname: string): string {
    const parts = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    const sld = parts[parts.length - 2];
    const n = SHORT_SLD.has(sld) && parts[parts.length - 1].length === 2 ? 3 : 2;
    return parts.slice(-n).join('.');
}

export function isSameSite(a: string, b: string): boolean {
    try {
        const ua = new URL(a);
        const ub = new URL(b);
        if (ua.protocol !== 'https:' || ub.protocol !== 'https:') return false;
        return siteOf(ua.hostname) === siteOf(ub.hostname);
    } catch {
        return false;
    }
}
