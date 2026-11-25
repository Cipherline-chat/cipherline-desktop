/**
 * Link embeds built by the SENDER — the cross-client contract (2026-11-23,
 * docs/plans/embeds.md §4, phase 3).
 *
 * ## Why the sender builds them
 *
 * URLs are message content, so the server must never fetch or proxy them (it
 * only relays ciphertext; a server-side unfurler would see every link anyone
 * posts). Instead the sender's device visits the link, reads the page's
 * OpenGraph / Twitter / oEmbed / JSON-LD metadata and puts a small preview
 * INSIDE the end-to-end encrypted message, the way Signal does. Receivers draw
 * it with no request to the linked site at all. The thumbnail is re-encoded by
 * the sender (WebP, EXIF stripped) and travels as an ordinary encrypted
 * attachment (its key inside this message), or inline when it is tiny.
 *
 * ## Wire shape: an additive field on `type: 'text'`
 *
 *   { type: 'text', text: 'look https://example.com/a', embeds: [LinkEmbed, …] }
 *
 * Optional and additive: a client that predates it (desktop <= 0.1.3, the
 * phone apps until they adopt it) ignores the field and shows the link the way
 * it always has. Never parsed by the server.
 *
 * An `edit` may carry `embeds` too (withEditEmbeds): an array REPLACES the
 * original's, `null` removes them all, and an edit WITHOUT the field keeps the
 * original's (an older client editing the text must not silently strip them;
 * any whose link the new text no longer contains are dropped by the reader's
 * URL check anyway). "Remove embed" is an edit that leaves one out.
 *
 * ## The late preview: an embeds-only edit (`embeds_only: true`)
 *
 * A preview not ready at send (a slow page, or a page SNAPSHOT still being
 * taken for a page with no picture of its own) is attached afterwards by the
 * sender's app with an edit carrying the SAME text, channel refs, font and
 * size and the new `embeds`, flagged `embeds_only: true`. A reader leaves the
 * message unmarked (no "(edited)") ONLY when `isEmbedsOnlyEdit` holds: the
 * flag is set, the message after the edit differs from before in nothing but
 * `embeds`, and every preview it had is still there (previews were only
 * added or filled in). Any other edit, flagged or not, is a real edit and
 * marked, so the flag can never hide a change to the words. Readers that
 * predate the flag show it as an ordinary edit.
 *
 * ## Readers MUST run `sanitizeLinkEmbeds` (the sender is untrusted)
 *
 *   - at most LINK_EMBED_MAX_PER_MESSAGE, in order, one per URL;
 *   - an embed whose `url` is not one of the links the reader itself finds in
 *     the text (same rules as the desktop's `embedUrlsOf`: no `<url>`, no link
 *     inside a spoiler or code) is DROPPED, so a sender cannot make a card for
 *     a link nobody can see;
 *   - text fields are plain text (never HTML), stripped of control and
 *     bidi-override characters, and capped;
 *   - `color` must be `#rrggbb`;
 *   - `media.url` must be https without credentials;
 *   - `media.file` (the sender's encrypted copy of media from an expiring
 *     link) must be a well-formed attachment reference within
 *     LINK_EMBED_MEDIA_COPY_MAX_BYTES for its type; a reader shows / plays the
 *     decrypted copy (its magic bytes checked against `media.mime`) and then
 *     makes NO request to `media.url`'s host;
 *   - `player.provider` must be on LINK_EMBED_PLAYER_PROVIDERS, and the player
 *     (iframe) URL is built by the READER from `{ provider, id }` — a message
 *     never supplies a frame URL;
 *   - the thumbnail must be one of LINK_EMBED_THUMB_MIMES, within the size
 *     caps, and either a well-formed attachment reference or inline bytes; a
 *     reader also checks the image's magic bytes after decrypting;
 *   - the text part of all embeds together is capped at
 *     LINK_EMBED_MAX_JSON_BYTES (inline thumbnail bytes are counted
 *     separately, by LINK_EMBED_THUMB_INLINE_MAX_BYTES each).
 */

export const LINK_EMBED_MAX_PER_MESSAGE = 5;
/** The JSON of all embeds of one message, inline thumbnail bytes excluded. */
export const LINK_EMBED_MAX_JSON_BYTES = 8 * 1024;
/** A thumbnail after the sender's re-encode. */
export const LINK_EMBED_THUMB_MAX_BYTES = 150 * 1024;
/** Thumbnails up to this size ride inline (`inline_b64`) instead of as an attachment. */
export const LINK_EMBED_THUMB_INLINE_MAX_BYTES = 12 * 1024;
export const LINK_EMBED_THUMB_MAX_SIDE = 4096;

/**
 * `post` (phase 4): a social post drawn as a post card (an X / Twitter tweet,
 * a Reddit post): author, handle, avatar, text, time and its media. Which
 * card it is follows from the READER's own reading of the visible link, never
 * from a field in the message.
 */
export const LINK_EMBED_KINDS = ['card', 'image', 'video', 'player', 'post'] as const;
export type LinkEmbedKind = typeof LINK_EMBED_KINDS[number];

/**
 * Players whose frame the READER builds from `{ provider, id }` (an exact,
 * allowlisted origin per provider; the message never names a frame URL).
 *
 *   youtube  id = the 11-character video id
 *   twitch   id = `clip:<slug>` | `video:<digits>` | `channel:<login>`
 *   tiktok   id = the numeric video id
 */
export const LINK_EMBED_PLAYER_PROVIDERS = ['youtube', 'twitch', 'tiktok'] as const;
export type LinkEmbedPlayerProvider = typeof LINK_EMBED_PLAYER_PROVIDERS[number];

export const LINK_EMBED_MEDIA_MIMES = ['video/mp4', 'video/webm', 'video/quicktime', 'image/gif', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type LinkEmbedMediaMime = typeof LINK_EMBED_MEDIA_MIMES[number];

export const LINK_EMBED_THUMB_MIMES = ['image/webp', 'image/jpeg', 'image/png'] as const;

/**
 * A COPY of the linked media itself (2026-11-24, embeds-media-everywhere),
 * attached by the sender when the link would stop working for readers: an
 * expiring / signed media URL (a Discord CDN attachment link carries
 * `ex=&is=&hm=` and 404s once it expires). The sender's app downloads the file
 * (within these caps and the account's upload limit), encrypts it like any
 * attachment and puts its key in `media.file`; readers play / show the
 * decrypted copy and NEVER contact the linked host. Caps, by the media's type:
 */
export const LINK_EMBED_MEDIA_COPY_MAX_BYTES = { image: 8 * 1024 * 1024, video: 25 * 1024 * 1024 } as const;

/** The cap for a media type (image/* incl. GIF and WebP, else video). */
export function linkEmbedCopyCap(mime: string): number {
    return mime.startsWith('image/') ? LINK_EMBED_MEDIA_COPY_MAX_BYTES.image : LINK_EMBED_MEDIA_COPY_MAX_BYTES.video;
}
export type LinkEmbedThumbMime = typeof LINK_EMBED_THUMB_MIMES[number];

/** Field caps (characters, after cleaning). `post_text` is a post card's text (a tweet, a Reddit excerpt). */
export const LINK_EMBED_FIELD_MAX = { site: 80, title: 256, description: 350, author: 120, tag: 40, handle: 64, post_text: 700 } as const;
/** Pictures a post card may carry (a tweet's photos, a Reddit gallery), besides `thumb`. */
export const LINK_EMBED_MAX_IMAGES = 4;

/**
 * The sender's re-encoded preview image. Exactly one of:
 *   - an encrypted attachment: `attachment_id` + `file_key_b64` (AES-256-GCM,
 *     raw key, base64) + `file_nonce_b64` (12-byte IV, base64) + `byte_size`;
 *   - `inline_b64`: the image bytes themselves, at most
 *     LINK_EMBED_THUMB_INLINE_MAX_BYTES.
 */
export interface EmbedImage {
    mime: LinkEmbedThumbMime;
    width: number;
    height: number;
    attachment_id?: string;
    file_key_b64?: string;
    file_nonce_b64?: string;
    byte_size?: number;
    inline_b64?: string;
    /**
     * The sender found no picture of the page or video at all (2026-11-24,
     * "always a thumbnail"): this is the DESIGNED card picture its app drew
     * (the site's icon or letter on a tinted background). Readers may draw
     * their own designed picture instead; a later embeds-only edit with a real
     * picture counts as an improvement. Additive: older readers ignore it.
     */
    designed?: true;
}

/** The sender's encrypted copy of the media (see LINK_EMBED_MEDIA_COPY_MAX_BYTES): an ordinary attachment. */
export interface EmbedMediaFile {
    attachment_id: string;
    /** AES-256-GCM raw key, base64. */
    file_key_b64: string;
    /** 12-byte IV, base64. */
    file_nonce_b64: string;
    /** Plaintext bytes; within the cap for `media.mime`. */
    byte_size: number;
}

export interface LinkEmbedMedia {
    /** https; played only when the viewer presses play (and, on desktop, only for known clip / post media hosts). */
    url: string;
    mime: LinkEmbedMediaMime;
    width?: number;
    height?: number;
    duration_s?: number;
    /** A GIF published as a silent video loop (X "GIF"): drawn and played under the GIF rules. */
    loop?: boolean;
    /** The file has no sound track the reader can play (Reddit's video-only rendition). */
    no_audio?: boolean;
    /** An ANIMATED image (a GIF with more than one frame, an animated WebP / PNG): drawn under the GIF rules. */
    animated?: boolean;
    /**
     * The sender's copy of the file (an expiring link, 2026-11-24): readers
     * show / play THIS and never contact `url`'s host. Additive: older readers
     * ignore it and use `url`.
     */
    file?: EmbedMediaFile;
}

export interface LinkEmbedPlayer {
    provider: LinkEmbedPlayerProvider;
    id: string;
    start_s?: number;
}

export interface LinkEmbed {
    /** The link exactly as the reader's link finder returns it from `text`. */
    url: string;
    kind: LinkEmbedKind;
    site?: string;
    title?: string;
    description?: string;
    author?: string;
    /** One short label, e.g. a clip's game ("Valorant"). */
    tag?: string;
    /** `#rrggbb`, from the page's theme-color. Used as a faint corner glow. */
    color?: string;
    thumb?: EmbedImage;
    /** The page asked for a large image (summary_large_image) — a hint; readers decide from the thumb's shape. */
    image_large?: boolean;
    media?: LinkEmbedMedia;
    player?: LinkEmbedPlayer;
    // ── phase 4 ────────────────────────────────────────────────────────────
    /** "@jack", "r/aww · u/someone": shown under the author's name. */
    author_handle?: string;
    /**
     * The author's picture (re-encoded by the sender, like `thumb`). On a
     * `card` it is the SITE's icon (its favicon, re-encoded to a small WebP;
     * 2026-11-23 fixes). The same field rather than a new one, so readers that
     * predate it accept the message unchanged (they ignore it on a card) and
     * report / franking text stays identical across versions.
     */
    author_icon?: EmbedImage;
    /** When the post was made: ISO-8601 UTC, e.g. 2026-11-12T04:22:27Z. */
    published_at?: string;
    /** A post's pictures, in order (photos, a gallery), at most LINK_EMBED_MAX_IMAGES. */
    images?: EmbedImage[];
    /** Marked adult (Reddit over_18, X possibly_sensitive): readers blur the media until clicked. */
    nsfw?: boolean;
    /** Marked spoiler: readers blur the media until clicked. */
    spoiler?: boolean;
    score?: number;
    comments?: number;
}

// ── helpers ────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Plain display text: no control or bidi-override characters, whitespace collapsed, bounded. */
export function cleanEmbedText(v: unknown, max: number): string | undefined {
    if (typeof v !== 'string') return undefined;
    let out = '';
    let n = 0;
    for (const ch of v) {
        if (++n > max * 4 + 64) break; // never walk an absurd string
        const c = ch.codePointAt(0)!;
        if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) { out += ' '; continue; }
        if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c === 0x061c || c === 0xfeff) continue;
        out += ch;
    }
    out = out.replace(/\s+/g, ' ').trim();
    if (!out) return undefined;
    const chars = Array.from(out);
    return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : out;
}

/** `#rgb` / `#rrggbb` (any case) → lower-case `#rrggbb`, else undefined. */
export function normalizeEmbedColor(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
    return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : undefined;
}

/** An https URL without credentials or an explicit port, bounded; its href, else undefined. */
export function safeEmbedHttpsUrl(v: unknown): string | undefined {
    if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return undefined;
    let u: URL;
    try { u = new URL(v); } catch { return undefined; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return undefined;
    return u.href.length > 2048 ? undefined : u.href;
}

const intIn = (v: unknown, lo: number, hi: number): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** AES-256 raw key, standard base64 (32 bytes → 44 chars). */
const KEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;
/** 12-byte AES-GCM IV, standard base64 (16 chars). */
const NONCE_B64_RE = /^[A-Za-z0-9+/]{16}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Decoded byte length of standard base64, or -1 when it is not base64. */
export function base64DecodedLength(b64: string): number {
    if (b64.length % 4 !== 0 || !B64_RE.test(b64)) return -1;
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return (b64.length / 4) * 3 - pad;
}

export function sanitizeEmbedImage(v: unknown): EmbedImage | undefined {
    if (!isObj(v)) return undefined;
    const mime = (LINK_EMBED_THUMB_MIMES as readonly unknown[]).includes(v.mime) ? v.mime as LinkEmbedThumbMime : undefined;
    const width = intIn(v.width, 1, LINK_EMBED_THUMB_MAX_SIDE);
    const height = intIn(v.height, 1, LINK_EMBED_THUMB_MAX_SIDE);
    if (!mime || !width || !height) return undefined;
    const inline = v.inline_b64;
    const hasAttachment = v.attachment_id !== undefined || v.file_key_b64 !== undefined;
    if (typeof inline === 'string') {
        if (hasAttachment) return undefined; // exactly one source
        const n = base64DecodedLength(inline);
        if (n < 16 || n > LINK_EMBED_THUMB_INLINE_MAX_BYTES) return undefined;
        return { mime, width, height, inline_b64: inline, ...(v.designed === true ? { designed: true as const } : {}) };
    }
    if (typeof v.attachment_id !== 'string' || !UUID_RE.test(v.attachment_id)) return undefined;
    if (typeof v.file_key_b64 !== 'string' || !KEY_B64_RE.test(v.file_key_b64)) return undefined;
    if (typeof v.file_nonce_b64 !== 'string' || !NONCE_B64_RE.test(v.file_nonce_b64)) return undefined;
    const byteSize = intIn(v.byte_size, 1, LINK_EMBED_THUMB_MAX_BYTES);
    if (!byteSize) return undefined;
    return {
        mime, width, height, attachment_id: v.attachment_id.toLowerCase(), file_key_b64: v.file_key_b64, file_nonce_b64: v.file_nonce_b64, byte_size: byteSize,
        ...(v.designed === true ? { designed: true as const } : {}),
    };
}

function sanitizeMedia(v: unknown): LinkEmbedMedia | undefined {
    if (!isObj(v)) return undefined;
    const url = safeEmbedHttpsUrl(v.url);
    const mime = (LINK_EMBED_MEDIA_MIMES as readonly unknown[]).includes(v.mime) ? v.mime as LinkEmbedMediaMime : undefined;
    if (!url || !mime) return undefined;
    const out: LinkEmbedMedia = { url, mime };
    const w = intIn(v.width, 1, 16384);
    const h = intIn(v.height, 1, 16384);
    if (w && h) { out.width = w; out.height = h; }
    if (typeof v.duration_s === 'number' && Number.isFinite(v.duration_s) && v.duration_s > 0 && v.duration_s <= 86400) {
        out.duration_s = Math.round(v.duration_s * 100) / 100;
    }
    if (v.loop === true && out.mime.startsWith('video/')) out.loop = true;
    if (v.no_audio === true && out.mime.startsWith('video/')) out.no_audio = true;
    if (v.animated === true && out.mime.startsWith('image/')) out.animated = true;
    const file = sanitizeMediaFile(v.file, out.mime); if (file) out.file = file;
    return out;
}

/** The copy's attachment reference, within the cap for its media type; else undefined. */
export function sanitizeMediaFile(v: unknown, mime: string): EmbedMediaFile | undefined {
    if (!isObj(v)) return undefined;
    if (typeof v.attachment_id !== 'string' || !UUID_RE.test(v.attachment_id)) return undefined;
    if (typeof v.file_key_b64 !== 'string' || !KEY_B64_RE.test(v.file_key_b64)) return undefined;
    if (typeof v.file_nonce_b64 !== 'string' || !NONCE_B64_RE.test(v.file_nonce_b64)) return undefined;
    const byteSize = intIn(v.byte_size, 1, linkEmbedCopyCap(mime));
    if (!byteSize) return undefined;
    return { attachment_id: v.attachment_id.toLowerCase(), file_key_b64: v.file_key_b64, file_nonce_b64: v.file_nonce_b64, byte_size: byteSize };
}

const TWITCH_PLAYER_ID_RE = /^(?:clip:[A-Za-z0-9_-]{3,100}|video:\d{1,15}|channel:[a-z0-9_]{1,25})$/;
const TIKTOK_ID_RE = /^\d{10,25}$/;

/** Is `id` a well-formed player id for `provider`? (Its shape only; readers also match it to the visible link.) */
export function isLinkEmbedPlayerId(provider: unknown, id: unknown): boolean {
    if (typeof id !== 'string') return false;
    switch (provider) {
        case 'youtube': return YT_ID_RE.test(id);
        case 'twitch': return TWITCH_PLAYER_ID_RE.test(id);
        case 'tiktok': return TIKTOK_ID_RE.test(id);
        default: return false;
    }
}

function sanitizePlayer(v: unknown): LinkEmbedPlayer | undefined {
    if (!isObj(v)) return undefined;
    if (!(LINK_EMBED_PLAYER_PROVIDERS as readonly unknown[]).includes(v.provider)) return undefined;
    if (!isLinkEmbedPlayerId(v.provider, v.id)) return undefined;
    const out: LinkEmbedPlayer = { provider: v.provider as LinkEmbedPlayerProvider, id: v.id as string };
    const s = v.provider === 'youtube' ? intIn(v.start_s, 1, 86400) : undefined;
    if (s) out.start_s = s;
    return out;
}

/** An ISO-8601 UTC instant between 2005 and a day from now, re-serialised; else undefined. */
function sanitizeInstant(v: unknown): string | undefined {
    if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(v)) return undefined;
    const t = Date.parse(v);
    if (!Number.isFinite(t) || t < Date.UTC(2005, 0, 1) || t > Date.now() + 86_400_000) return undefined;
    return new Date(t).toISOString().replace(/\.000Z$/, 'Z');
}

/** One embed, cleaned; undefined when it is unusable. Does NOT check the URL against the text. */
export function sanitizeLinkEmbed(v: unknown): LinkEmbed | undefined {
    if (!isObj(v)) return undefined;
    if (typeof v.url !== 'string' || v.url.length === 0 || v.url.length > 2048) return undefined;
    if (!(LINK_EMBED_KINDS as readonly unknown[]).includes(v.kind)) return undefined;
    const kind = v.kind as LinkEmbedKind;
    const out: LinkEmbed = { url: v.url, kind };
    const F = LINK_EMBED_FIELD_MAX;
    const site = cleanEmbedText(v.site, F.site); if (site) out.site = site;
    const title = cleanEmbedText(v.title, F.title); if (title) out.title = title;
    const description = cleanEmbedText(v.description, F.description); if (description) out.description = description;
    const author = cleanEmbedText(v.author, F.author); if (author) out.author = author;
    const tag = cleanEmbedText(v.tag, F.tag); if (tag) out.tag = tag;
    const color = normalizeEmbedColor(v.color); if (color) out.color = color;
    const thumb = sanitizeEmbedImage(v.thumb); if (thumb) out.thumb = thumb;
    if (v.image_large === true) out.image_large = true;
    if (kind === 'video' || kind === 'image' || kind === 'post') {
        const media = sanitizeMedia(v.media); if (media) out.media = media;
    }
    if (kind === 'player') {
        const player = sanitizePlayer(v.player);
        if (!player) return undefined;
        out.player = player;
    }
    if (kind === 'post') {
        // A post's text is longer than a card's description.
        const text = cleanEmbedText(v.description, F.post_text);
        if (text) out.description = text; else delete out.description;
        if (Array.isArray(v.images)) {
            const imgs = v.images.slice(0, 8).map(sanitizeEmbedImage).filter((x): x is EmbedImage => !!x).slice(0, LINK_EMBED_MAX_IMAGES);
            if (imgs.length) out.images = imgs;
        }
        if (v.nsfw === true) out.nsfw = true;
        if (v.spoiler === true) out.spoiler = true;
        const score = intIn(v.score, -1e9, 1e9); if (score !== undefined) out.score = score;
        const comments = intIn(v.comments, 0, 1e9); if (comments !== undefined) out.comments = comments;
    }
    if (kind === 'post' || kind === 'player' || kind === 'card') {
        const handle = cleanEmbedText(v.author_handle, F.handle); if (handle) out.author_handle = handle;
        const icon = sanitizeEmbedImage(v.author_icon); if (icon) out.author_icon = icon;
        const at = sanitizeInstant(v.published_at); if (at) out.published_at = at;
    }
    // A card with nothing to show is no card. The MINIMAL card (2026-11-23
    // fixes: a page that gave nothing, a bot wall, an unreachable host) is a
    // `card` with only its `site` (+ the site's icon): readers draw the
    // no-image card with the site, its icon or letter, and the link's path.
    // (Readers before this rule drop it and show their plain link card.)
    if (!out.title && !out.description && !out.thumb && !out.media && !out.player && !out.images && !(kind === 'card' && out.site)) return undefined;
    return out;
}

const noInline = (i: EmbedImage | undefined): EmbedImage | undefined => (i?.inline_b64 ? { ...i, inline_b64: '' } : i);

/** Bytes the text part of an embed costs against LINK_EMBED_MAX_JSON_BYTES (inline picture bytes excluded). */
export function linkEmbedTextBytes(e: LinkEmbed): number {
    const t: LinkEmbed = { ...e, thumb: noInline(e.thumb), author_icon: noInline(e.author_icon), images: e.images?.map((i) => noInline(i)!) };
    const json = JSON.stringify(t);
    let n = 0;
    for (let i = 0; i < json.length; i++) {
        const c = json.charCodeAt(i);
        // UTF-8 length: a surrogate pair is 4 bytes over its two units.
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? 4 : c >= 0xdc00 && c < 0xe000 ? 0 : 3;
    }
    return n;
}

/**
 * The embeds a reader may draw for a message: cleaned, at most
 * LINK_EMBED_MAX_PER_MESSAGE, each tied to a link the reader found in the
 * text itself (`textUrls`, from its own link finder), one per URL, in the
 * sender's order, within the byte cap. Never throws.
 */
export function sanitizeLinkEmbeds(raw: unknown, textUrls: readonly string[]): LinkEmbed[] {
    if (!Array.isArray(raw) || raw.length === 0 || textUrls.length === 0) return [];
    const allowed = new Set(textUrls);
    const seen = new Set<string>();
    const out: LinkEmbed[] = [];
    let bytes = 0;
    for (let i = 0; i < raw.length && i < 16 && out.length < LINK_EMBED_MAX_PER_MESSAGE; i++) {
        const e = sanitizeLinkEmbed(raw[i]);
        if (!e || !allowed.has(e.url) || seen.has(e.url)) continue;
        const cost = linkEmbedTextBytes(e);
        if (bytes + cost > LINK_EMBED_MAX_JSON_BYTES) break;
        bytes += cost;
        seen.add(e.url);
        out.push(e);
    }
    return out;
}

/**
 * The content after an edit, for the `embeds` field: an array on the edit
 * replaces the original's (empty = none), `null` removes them, and an edit
 * without the field keeps the original's. Readers re-run sanitizeLinkEmbeds
 * against the NEW text when drawing, so an embed whose link the edit removed
 * disappears either way.
 */
export function withEditEmbeds<T extends object>(content: T, edit: unknown): T {
    if (!isObj(edit) || !Object.prototype.hasOwnProperty.call(edit, 'embeds')) return content;
    const next = { ...content } as Record<string, unknown>;
    const e = edit.embeds;
    if (Array.isArray(e) && e.length > 0) next.embeds = e.slice(0, 16);
    else if (e === null || Array.isArray(e)) delete next.embeds;
    else return content;
    return next as T;
}

/** Key-sorted JSON (stable for comparing two message contents). */
function stableJson(v: unknown, depth = 0): string {
    if (depth > 12) return 'null';
    if (Array.isArray(v)) return `[${v.map((x) => stableJson(x, depth + 1)).join(',')}]`;
    if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k], depth + 1)}`).join(',')}}`;
    return JSON.stringify(v ?? null) ?? 'null';
}

/**
 * Did `edit` (applied to a message whose content was `before`, giving
 * `after`) only ADD or fill in link previews? True only when the edit says
 * so (`embeds_only: true`), nothing but `embeds` changed, and every preview
 * `before` had (by URL) is still in `after`. Readers then do not mark the
 * message "(edited)". See "The late preview" above.
 */
export function isEmbedsOnlyEdit(before: unknown, after: unknown, edit: unknown): boolean {
    if (!isObj(edit) || edit.embeds_only !== true || !isObj(before) || !isObj(after)) return false;
    const rest = (c: Record<string, unknown>) => { const o = { ...c }; delete o.embeds; return stableJson(o); };
    if (rest(before) !== rest(after)) return false;
    const urls = (c: Record<string, unknown>) => (Array.isArray(c.embeds) ? c.embeds.slice(0, 16) : []).map((e) => (isObj(e) && typeof e.url === 'string' ? e.url : '')).filter(Boolean);
    const had = urls(before);
    const has = new Set(urls(after));
    if (has.size === 0) return false;
    return had.every((u) => has.has(u));
}

/** The thumbnails' attachment ids (retention sweeps, pins, reports). */
export function linkEmbedAttachmentIds(embeds: unknown): string[] {
    if (!Array.isArray(embeds)) return [];
    const ids: string[] = [];
    for (const e of embeds.slice(0, 16)) {
        if (!isObj(e)) continue;
        for (const p of [e.thumb, e.author_icon, ...(Array.isArray(e.images) ? e.images.slice(0, 8) : [])]) {
            const t = sanitizeEmbedImage(p);
            if (t?.attachment_id && !ids.includes(t.attachment_id)) ids.push(t.attachment_id);
        }
        // The sender's copy of the media (an expiring link).
        const m = isObj(e.media) ? e.media : undefined;
        const f = m && typeof m.mime === 'string' ? sanitizeMediaFile(m.file, m.mime) : undefined;
        if (f && !ids.includes(f.attachment_id)) ids.push(f.attachment_id);
    }
    return ids;
}

/**
 * The embeds as plain text for a REPORT and for message franking: a client
 * that knows embeds commits (and a reporter recomputes) `text` + this block,
 * so a reported preview is the one that was sent, and the moderator reads
 * what the reporter saw. Deterministic: only validated text fields, in a
 * fixed order. Thumbnail pixels are not included (they are not text); their
 * attachment id is, so the picture is identified.
 */
export function linkEmbedsReportText(embeds: readonly LinkEmbed[]): string {
    return embeds.map((e) => {
        const lines = [`[Link preview: ${e.url}]`];
        if (e.site) lines.push(`Site: ${e.site}`);
        if (e.title) lines.push(`Title: ${e.title}`);
        if (e.description) lines.push(`Description: ${e.description}`);
        if (e.author) lines.push(`Author: ${e.author}`);
        if (e.author_handle) lines.push(`Handle: ${e.author_handle}`);
        if (e.published_at) lines.push(`Posted: ${e.published_at}`);
        if (e.tag) lines.push(`Tag: ${e.tag}`);
        if (e.nsfw) lines.push('Marked: adult');
        if (e.spoiler) lines.push('Marked: spoiler');
        if (e.media) lines.push(`Video: ${e.media.url}`);
        // Only on messages that carry a copy (older reports recompute unchanged).
        if (e.media?.file) lines.push(`Media copy: attachment ${e.media.file.attachment_id}`);
        if (e.player) lines.push(`Player: ${e.player.provider} ${e.player.id}`);
        const pic = (label: string, i: EmbedImage) => lines.push(`${label}: ${i.attachment_id ? `attachment ${i.attachment_id}` : 'inline'}`);
        if (e.thumb) pic('Picture', e.thumb);
        if (e.author_icon) pic('Author picture', e.author_icon);
        e.images?.forEach((i, n) => pic(`Image ${n + 1}`, i));
        return lines.join('\n');
    }).join('\n\n');
}
