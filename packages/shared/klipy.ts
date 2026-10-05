/**
 * KLIPY GIFs — the cross-client contract.
 *
 * GIF search talks to KLIPY directly from the user's device (KLIPY's standard
 * integration: client-side API requests, media loaded straight from KLIPY's
 * CDN). Sending a KLIPY GIF puts ONLY a reference to it inside the normal E2EE
 * envelope — the `klipy_gif` ClientContent variant below — and each recipient's
 * client loads the media from KLIPY itself, if and only if that recipient has
 * opted in (or taps to load it once).
 *
 * The server never sees any of this: the reference travels encrypted, and the
 * API has no KLIPY route.
 *
 * ## Why the URL check is a strict pattern and not "ends with KLIPY's domain"
 *
 * The media URL comes from the SENDER, and the sender is not trusted. Whatever
 * URL a recipient's client loads, that host learns the recipient's IP address
 * and when they looked — an arbitrary URL would turn a GIF message into a
 * tracking pixel. So a recipient loads a URL only when it is https, on the
 * default port, with no credentials, whitespace or backslashes, and its host is
 * EXACTLY one of KLIPY's documented media hosts. KLIPY's bare apex domain
 * (the marketing site), look-alikes (a media host with an attacker's domain
 * appended, or a different TLD), and suffix matches are all refused.
 * (Non-allowlisted KLIPY host names are deliberately never spelled out in
 * source: src/utils/klipyHosts.test.ts fails the build if one appears.)
 *
 * Deliberately a regular expression rather than `new URL()`: React Native's
 * `URL` is incomplete, and the mobile client must be able to copy this rule
 * character for character (docs/klipy-client-contract.md).
 */

/** KLIPY's API origin — the only KLIPY host a client calls with `fetch`. */
export const KLIPY_API_HOST = 'api.klipy.com';
export const KLIPY_API_ORIGIN = `https://${KLIPY_API_HOST}`;

/**
 * KLIPY's documented media/CDN hosts (KLIPY API docs → Network Requirements).
 * The ONLY hosts a client may load KLIPY media from. Exact match.
 */
export const KLIPY_MEDIA_HOSTS = ['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com'] as const;

/** Every KLIPY host a Cipherline client is allowed to contact. */
export const KLIPY_ALLOWED_HOSTS: readonly string[] = [KLIPY_API_HOST, ...KLIPY_MEDIA_HOSTS];

/** Renditions a client may send and must be able to render. Both animate in an
 *  `<img>` on desktop and in expo-image on mobile; no `<video>` is needed. */
export const KLIPY_GIF_MIMES = ['image/gif', 'image/webp'] as const;
export type KlipyGifMime = typeof KLIPY_GIF_MIMES[number];

export const KLIPY_SLUG_MAX_LENGTH = 200;
export const KLIPY_TITLE_MAX_LENGTH = 200;
export const KLIPY_URL_MAX_LENGTH = 2048;
export const KLIPY_MAX_DIMENSION = 8192;

/** KLIPY slugs are `[A-Za-z0-9._-]`. Anything else is refused, never repaired. */
export const KLIPY_SLUG_RE = /^[A-Za-z0-9._-]{1,200}$/;

const escapeHost = (h: string) => h.replace(/\./g, '\\.');

/**
 * `https://` + one exact media host + `/` + path [+ `?query`]. The host must be
 * followed immediately by `/`, which rules out a port (`:8443`), userinfo
 * (`@` can only appear AFTER the host's slash), and suffix tricks
 * (a media host followed by `.evil.net`). Path/query characters are RFC 3986 unreserved,
 * sub-delims, `:`, `@`, `/`, `?` and `%` escapes — no whitespace, no backslash
 * (WHATWG parsers treat `\` as `/`, a classic host-confusion vector), no quotes
 * or angle brackets, no fragment. Hosts are lowercase: KLIPY returns them that
 * way, and a mixed-case host from a sender is a sign someone is being creative.
 */
export const KLIPY_MEDIA_URL_RE = new RegExp(
    `^https://(?:${KLIPY_MEDIA_HOSTS.map(escapeHost).join('|')})/`
    + `[A-Za-z0-9\\-._~%!$&'()*+,;=:@/]*`
    + `(?:\\?[A-Za-z0-9\\-._~%!$&'()*+,;=:@/?]*)?$`,
);

/** True only for a URL a client may load KLIPY media from. */
export function isKlipyMediaUrl(raw: unknown): raw is string {
    return typeof raw === 'string'
        && raw.length > 0
        && raw.length <= KLIPY_URL_MAX_LENGTH
        && KLIPY_MEDIA_URL_RE.test(raw);
}

export function isKlipySlug(raw: unknown): raw is string {
    return typeof raw === 'string' && KLIPY_SLUG_RE.test(raw);
}

/** One KLIPY rendition — the exact file a client loads. */
export interface KlipyGifMedia {
    url: string;
    width: number;
    height: number;
    mime: KlipyGifMime;
}

const isDimension = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= KLIPY_MAX_DIMENSION;

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a rendition is unusable, or null when it is fine. */
export function klipyMediaProblem(m: unknown): string | null {
    if (!isRecord(m)) return 'media must be an object';
    if (!isKlipyMediaUrl(m.url)) return 'media.url is not an allowed KLIPY media URL';
    if (!isDimension(m.width)) return 'media.width must be an integer 1..8192';
    if (!isDimension(m.height)) return 'media.height must be an integer 1..8192';
    if (typeof m.mime !== 'string' || !(KLIPY_GIF_MIMES as readonly string[]).includes(m.mime)) {
        return 'media.mime must be image/gif or image/webp';
    }
    return null;
}

/** Why a `klipy_gif` payload is unusable, or null when it is fine. */
export function klipyGifProblem(c: unknown): string | null {
    if (!isRecord(c)) return 'content is not an object';
    if (c.type !== 'klipy_gif') return 'content.type must be klipy_gif';
    if (!isKlipySlug(c.slug)) return 'klipy_gif.slug must match [A-Za-z0-9._-]{1,200}';
    const mp = klipyMediaProblem(c.media);
    if (mp) return `klipy_gif.${mp}`;
    if (c.title !== undefined && c.title !== null) {
        if (typeof c.title !== 'string') return 'klipy_gif.title must be a string';
        if (c.title.length > KLIPY_TITLE_MAX_LENGTH) return 'klipy_gif.title is too long';
    }
    if (c.client_msg_id !== undefined && typeof c.client_msg_id !== 'string') {
        return 'klipy_gif.client_msg_id must be a string';
    }
    return null;
}

/** The fields a renderer may use — copied out, so unknown extra keys a sender
 *  added never reach a component. */
export interface KlipyGifRef {
    slug: string;
    media: KlipyGifMedia;
    title?: string;
}

/**
 * Re-validate and copy a `klipy_gif` payload (or a saved favorite's reference,
 * which has the same fields). Null when anything is off — the caller shows a
 * "couldn't be shown" placeholder and loads nothing.
 */
export function parseKlipyGifRef(value: unknown): KlipyGifRef | null {
    if (!isRecord(value)) return null;
    const asContent = { ...value, type: 'klipy_gif' };
    if (klipyGifProblem(asContent) !== null) return null;
    const m = value.media as Record<string, unknown>;
    const ref: KlipyGifRef = {
        slug: value.slug as string,
        media: { url: m.url as string, width: m.width as number, height: m.height as number, mime: m.mime as KlipyGifMime },
    };
    if (typeof value.title === 'string' && value.title) ref.title = value.title;
    return ref;
}
