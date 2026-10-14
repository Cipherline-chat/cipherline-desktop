/**
 * The one gate between "a URL string that arrived from somewhere" and an
 * `<img src>`.
 *
 * Image URLs in the renderer come from the avatar/banner pipeline (a `blob:`
 * object URL minted locally, or a `data:` URI) and from KLIPY (`https:`). Some
 * of the inputs to that pipeline are server- or peer-supplied (a profile may
 * carry a legacy inline `data:`/`blob:` string in place of an attachment id; the
 * `data:` mime type of a proxied image comes from a remote response), so every
 * component that hands a URL to an `<img>` runs it through here first and uses
 * ONLY the returned value. Anything else yields `undefined`, which renders as
 * "no image" (the caller's existing fallback), never as a request.
 *
 * The value returned is the PARSED URL's `href` (the validated, normalised
 * form), not the caller's string: the thing that was checked is the thing that
 * is rendered.
 *
 * Allowed, and nothing else (this mirrors the renderer CSP `img-src`, which is
 * the second line of defence; see electron/main.ts):
 *   - `blob:`            an object URL minted in this renderer.
 *   - `data:image/*`     an inline image. NOT `data:text/html`, `data:application/*`,
 *                        or a bare `data:`; images only.
 *   - `https:` to        the Cipherline media host, and KLIPY's exact media hosts
 *                        (no userinfo, no port, no suffix tricks).
 * Refused: `javascript:`, `vbscript:`, `file:`, plain `http:`, protocol-relative
 * `//host`, relative paths, anything with whitespace/control characters.
 */
import { isKlipyMediaUrl } from '@cipherline/shared';

/** Exact hosts (besides KLIPY's) an `<img>` may load over https. Must stay within the CSP `img-src`. */
export const TRUSTED_IMAGE_HTTPS_HOSTS: readonly string[] = ['media.cipherline.chat'];

// No whitespace, quote, angle bracket or backslash: the string is used as an
// attribute value and must stay one opaque token. Control characters are
// rejected separately (hasControlChar) so no regex needs a control-char class.
const BLOB_RE = /^blob:[^\s"'<>\\]+$/i;
const DATA_IMAGE_RE = /^data:image\/[a-z0-9][a-z0-9.+-]*(?:;[a-z0-9=_.+-]+)*[;,][^\s"'<>\\]*$/i;
const NO_SPECIAL_RE = /^[^\s"'<>\\]+$/;

function hasControlChar(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
}

function parse(raw: string): URL | null {
    try { return new URL(raw); } catch { return null; }
}

/** Returns the normalised `blob:` object URL, or `undefined` if `raw` is anything else.
 *  For media elements (<video>, <img>) that only ever show locally minted blobs. */
export function safeBlobUrl(raw: string | null | undefined): string | undefined {
    if (typeof raw !== 'string' || raw === '' || hasControlChar(raw) || !BLOB_RE.test(raw)) return undefined;
    const u = parse(raw);
    return u !== null && u.protocol === 'blob:' ? u.href : undefined;
}

/** Returns the normalised URL when `raw` is a permitted image URL, else `undefined`. */
export function safeImageSrc(raw: string | null | undefined): string | undefined {
    if (typeof raw !== 'string' || raw === '' || hasControlChar(raw)) return undefined;
    const scheme = raw.slice(0, raw.indexOf(':') + 1).toLowerCase();
    if (scheme === 'blob:') return safeBlobUrl(raw);
    if (scheme === 'data:') {
        if (!DATA_IMAGE_RE.test(raw)) return undefined;
        const u = parse(raw);
        return u !== null && u.protocol === 'data:' ? u.href : undefined;
    }
    if (scheme === 'https:') {
        if (!NO_SPECIAL_RE.test(raw)) return undefined;
        const u = parse(raw);
        if (u === null || u.protocol !== 'https:') return undefined;
        if (u.username !== '' || u.password !== '' || u.port !== '') return undefined;
        if (!isKlipyMediaUrl(raw) && !TRUSTED_IMAGE_HTTPS_HOSTS.includes(u.hostname)) return undefined;
        return u.href;
    }
    return undefined;
}
