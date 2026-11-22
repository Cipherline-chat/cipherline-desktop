/**
 * Stickers — the cross-client contract (2026-11-22).
 *
 * A sticker is a large image sent as a message of its own. Two kinds, exactly
 * like custom emojis:
 *
 *   SERVER sticker   uploaded to a server by a member with "Manage emojis &
 *                    stickers" (the MANAGE_EMOJIS bit). Stored like a server
 *                    emoji (a `server_emojis` row with kind 'sticker': encrypted
 *                    blob, key on the row because every member must render it).
 *                    Inside its OWN server's channels the message carries only a
 *                    reference — `{ source: 'server', id, server_id, name }` — and
 *                    each member's client resolves it through
 *                    GET /v1/servers/:sid/stickers (membership-gated).
 *   PERSONAL sticker "My stickers": the user's own library, on-device only.
 *                    Content-addressed (`id = p_ + first 32 hex of SHA-256(bytes)`)
 *                    and its bytes travel INSIDE the end-to-end encrypted message
 *                    (`bytes_b64`), exactly like `personal_emojis`. A server
 *                    sticker sent anywhere outside its own server (a DM, a group,
 *                    another server) is sent this way too, so a recipient who is
 *                    not a member can still see it.
 *
 * ## Wire shape: a `text` message with an additive `sticker` field
 *
 *   { type: 'text', text: '[Sticker: wave]', sticker: { source, id, name, ... } }
 *
 * Deliberately NOT a new `type`: a client that predates stickers (desktop
 * <= 0.1.2, the phone apps) turns an unknown `type` into an "Unsupported
 * message variant" / "couldn't be shown" row. Riding `text` means it shows the
 * fallback text instead — `[Sticker: wave]` — and searches, previews and
 * replies to it read sensibly. A reader that knows stickers renders the image
 * and ignores `text`. Never parsed by the server: it all lives inside the
 * encrypted content, so the server never learns which sticker was sent.
 *
 * Readers MUST validate with `stickerPayloadProblem` (the sender is
 * untrusted): for a personal sticker recompute the hash from `bytes_b64` and
 * drop it unless it equals `id`, check PNG/JPEG/WebP/GIF magic bytes and the
 * size cap. An invalid sticker renders as the fallback text, never as a broken
 * image.
 */

/** Stored side length of a sticker: it fits inside this square (aspect kept). */
export const STICKER_STORED_PX = 320;
/** Largest CSS size a sticker is drawn at in a message (2x = STICKER_STORED_PX). */
export const STICKER_DISPLAY_PX = 160;
/** Hard cap on one sticker's bytes: stored (server) and on the wire (personal). */
export const STICKER_MAX_BYTES = 512 * 1024;
/** Raw upload a server accepts for processing (same as server emojis). */
export const STICKER_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Server stickers per server (a backstop: stickers count toward server storage like emojis). */
export const MAX_STICKERS_PER_SERVER = 250;
/** "My stickers" library size. */
export const PERSONAL_STICKER_LIBRARY_MAX = 100;
/** Optional description shown in the picker and used for search. */
export const STICKER_DESCRIPTION_MAX = 100;
/** Search tags: up to this many, each `[a-z0-9_]{1,24}`. */
export const STICKER_TAGS_MAX = 5;
export const STICKER_TAG_RE = /^[a-z0-9_]{1,24}$/;

export const STICKER_NAME_RE = /^[a-z0-9_]{2,32}$/;
export const PERSONAL_STICKER_ID_RE = /^p_[0-9a-f]{32}$/;
export const SERVER_STICKER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const STICKER_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type StickerSource = 'server' | 'personal';

export interface StickerPayload {
    source: StickerSource;
    /** server: the sticker's UUID; personal: `p_` + 32 hex of SHA-256(bytes). */
    id: string;
    /** `[a-z0-9_]{2,32}` — also what the fallback text names. */
    name: string;
    /** server only: the server the sticker belongs to. */
    server_id?: string;
    /** personal only: image/png | image/jpeg | image/webp | image/gif */
    mime?: string;
    /** personal only. */
    animated?: boolean;
    /** personal only: the image, base64 (<= STICKER_MAX_BYTES decoded). */
    bytes_b64?: string;
}

/** What a client that does not know stickers shows instead (and what search indexes). */
export function stickerFallbackText(name: string): string {
    return `[Sticker: ${name}]`;
}

/** Base64 length that decodes to at most `bytes` bytes. */
const b64LenFor = (bytes: number) => Math.ceil(bytes / 3) * 4;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Why a `sticker` field is malformed, or null. STRUCTURAL only (shape, ids,
 * lengths) — it cannot hash; a reader must still recompute a personal
 * sticker's id from its decoded bytes and sniff the magic bytes.
 */
export function stickerPayloadProblem(s: unknown): string | null {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'sticker must be an object';
    const c = s as Record<string, unknown>;
    if (typeof c.name !== 'string' || !STICKER_NAME_RE.test(c.name)) return 'sticker.name is invalid';
    if (c.source === 'server') {
        if (typeof c.id !== 'string' || !SERVER_STICKER_ID_RE.test(c.id)) return 'sticker.id must be a server sticker id';
        if (typeof c.server_id !== 'string' || !SERVER_STICKER_ID_RE.test(c.server_id)) return 'sticker.server_id must be a server id';
        if (c.bytes_b64 !== undefined) return 'a server sticker carries no bytes';
        return null;
    }
    if (c.source === 'personal') {
        if (typeof c.id !== 'string' || !PERSONAL_STICKER_ID_RE.test(c.id)) return 'sticker.id must be a personal sticker id';
        if (typeof c.mime !== 'string' || !(STICKER_MIMES as readonly string[]).includes(c.mime)) return 'sticker.mime is invalid';
        if (c.animated !== undefined && typeof c.animated !== 'boolean') return 'sticker.animated must be a boolean';
        if (typeof c.bytes_b64 !== 'string' || c.bytes_b64.length === 0) return 'sticker.bytes_b64 is required';
        if (c.bytes_b64.length > b64LenFor(STICKER_MAX_BYTES)) return 'sticker is too large';
        if (!B64_RE.test(c.bytes_b64)) return 'sticker.bytes_b64 is not base64';
        if (c.server_id !== undefined) return 'a personal sticker names no server';
        return null;
    }
    return 'sticker.source must be server or personal';
}

/** The search haystack of a server sticker: name, description and tags. */
export function stickerMatches(q: string, s: { name: string; description?: string | null; tags?: readonly string[] | null }): boolean {
    const needle = q.trim().toLowerCase().replace(/^:+|:+$/g, '');
    if (!needle) return true;
    if (s.name.includes(needle)) return true;
    if (s.description && s.description.toLowerCase().includes(needle)) return true;
    return !!s.tags?.some(t => t.includes(needle));
}
