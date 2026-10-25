/**
 * Personal ("My Emojis") emoji identity, tokens and wire validation.
 *
 * A personal emoji travels as the same inline token server emojis use,
 * `<:name:ID>`, with `ID = p_ + first 32 hex of SHA-256(bytes)`. Server-emoji
 * ids are UUIDs, so the `p_` prefix is how a renderer tells the two apart
 * without any lookup. The bytes ride in the message's optional
 * `personal_emojis` field (packages/shared/content.ts, `PersonalEmojiPayload`).
 *
 * Content-addressing is the security property: a reader recomputes the hash
 * and drops any payload whose bytes do not match the id it claims, so no sender
 * can plant pixels under an id another sender's token resolves to.
 *
 * Pure (no DOM, IPC or storage) so it is unit-testable. The wire shape is
 * mirrored here rather than imported from @cipherline/shared because desktop
 * resolves that package through a built `dist/`; keep the two in step.
 */

import { findMentionTokens, parseMentionToken } from '../mentionTokens';

export interface PersonalEmojiWire {
    id: string;
    name: string;
    mime: string;
    animated: boolean;
    bytes_b64: string;
}

export const PERSONAL_EMOJI_MAX_BYTES = 256 * 1024;
export const PERSONAL_EMOJI_MAX_PER_MESSAGE = 6;
/** Library size (owner decision). */
export const PERSONAL_EMOJI_LIBRARY_MAX = 100;
/** Rendered/stored side length. */
export const PERSONAL_EMOJI_PX = 128;
/** Target size of a still after on-device processing. */
export const PERSONAL_EMOJI_STATIC_TARGET_BYTES = 16 * 1024;

export const PERSONAL_EMOJI_ID_RE = /^p_[0-9a-f]{32}$/;
export const PERSONAL_EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;
export const PERSONAL_EMOJI_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type PersonalEmojiMime = (typeof PERSONAL_EMOJI_MIMES)[number];

export function isPersonalEmojiId(id: unknown): id is string {
    return typeof id === 'string' && PERSONAL_EMOJI_ID_RE.test(id);
}

export function isPersonalEmojiName(name: unknown): name is string {
    return typeof name === 'string' && PERSONAL_EMOJI_NAME_RE.test(name);
}

export function personalEmojiToken(name: string, id: string): string {
    return `<:${name}:${id}>`;
}

/** Turn arbitrary text (a file name, a typed label) into a valid emoji name. */
export function suggestEmojiName(raw: string): string {
    let n = raw.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (n.length > 32) n = n.slice(0, 32).replace(/_+$/, '');
    if (n.length < 2) n = (n + '_emoji').slice(0, 32);
    return n;
}

const hex = (u8: Uint8Array) => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

/** `p_` + first 32 hex of SHA-256(bytes). */
export async function personalEmojiIdFromBytes(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
    return 'p_' + hex(digest).slice(0, 32);
}

/** The image type the bytes actually are, from magic numbers; null if none of
 *  PNG / JPEG / WebP / GIF. The declared mime is only ever a claim. */
export function sniffImageMime(b: Uint8Array): PersonalEmojiMime | null {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
        && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
}

export function bytesToB64(u8: Uint8Array): string {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
    return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Personal-emoji tokens in `text` as {name, id}, in order, de-duplicated by id. */
export function personalTokensIn(text: unknown): { name: string; id: string }[] {
    if (typeof text !== 'string' || !text.includes('<:')) return [];
    const seen = new Set<string>();
    const out: { name: string; id: string }[] = [];
    for (const m of findMentionTokens(text, 'emoji')) {
        const p = parseMentionToken(m[0]);
        if (p?.kind !== 'emoji' || !isPersonalEmojiId(p.id) || seen.has(p.id)) continue;
        seen.add(p.id);
        out.push({ name: p.label, id: p.id });
    }
    return out;
}

/** The text-bearing field of a content object whose personal tokens must be
 *  backed by `personal_emojis`: text/edit bodies and a reaction's emoji key. */
export function personalTokenSource(content: unknown): string | null {
    if (!content || typeof content !== 'object') return null;
    const c = content as { type?: unknown; text?: unknown; emoji?: unknown };
    if (c.type === 'text' || c.type === 'edit') return typeof c.text === 'string' ? c.text : null;
    if (c.type === 'reaction') return typeof c.emoji === 'string' ? c.emoji : null;
    return null;
}

/** Does this image have more than one frame? Cheap header scan, no decode. */
export function isAnimatedImage(b: Uint8Array, mime: string): boolean {
    if (mime === 'image/gif') {
        // Two or more graphic-control extensions (0x21 0xF9) = more than one frame.
        let ext = 0;
        for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9) { if (++ext > 1) return true; }
        return false;
    }
    if (mime === 'image/webp') {
        // VP8X chunk, flags bit 1 (0x02) = animation.
        return b.length > 20 && b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58 && (b[20] & 0x02) !== 0;
    }
    if (mime === 'image/png') {
        // APNG: an acTL chunk before the first IDAT.
        for (let i = 8; i + 8 <= b.length;) {
            const len = (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
            const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
            if (type === 'acTL') return true;
            if (type === 'IDAT') return false;
            i += 12 + len;
        }
    }
    return false;
}

export type WireRejection = 'shape' | 'mime' | 'size' | 'hash' | 'name';

export interface ValidatedWireEmoji {
    id: string;
    name: string;
    mime: PersonalEmojiMime;
    animated: boolean;
    bytes: Uint8Array;
}

/**
 * Validate ONE untrusted payload entry. Returns the decoded emoji or why it
 * was refused. The mime and animated flag are derived from the bytes, never
 * trusted from the sender.
 */
export async function validateWireEmoji(raw: unknown): Promise<ValidatedWireEmoji | { rejected: WireRejection }> {
    if (!raw || typeof raw !== 'object') return { rejected: 'shape' };
    const e = raw as Partial<PersonalEmojiWire>;
    if (!isPersonalEmojiId(e.id) || typeof e.bytes_b64 !== 'string' || !e.bytes_b64) return { rejected: 'shape' };
    if (!isPersonalEmojiName(e.name)) return { rejected: 'name' };
    // base64 of N bytes is ceil(N/3)*4 chars: refuse before decoding anything.
    if (e.bytes_b64.length > Math.ceil(PERSONAL_EMOJI_MAX_BYTES / 3) * 4 + 4) return { rejected: 'size' };
    let bytes: Uint8Array;
    try { bytes = b64ToBytes(e.bytes_b64); } catch { return { rejected: 'shape' }; }
    if (bytes.length === 0 || bytes.length > PERSONAL_EMOJI_MAX_BYTES) return { rejected: 'size' };
    const mime = sniffImageMime(bytes);
    if (!mime) return { rejected: 'mime' };
    if ((await personalEmojiIdFromBytes(bytes)) !== e.id) return { rejected: 'hash' };
    return { id: e.id, name: e.name, mime, animated: isAnimatedImage(bytes, mime), bytes };
}

/**
 * Validate a whole `personal_emojis` array from a message. Entries that fail
 * are dropped (the token then renders as the unavailable glyph); entries past
 * PERSONAL_EMOJI_MAX_PER_MESSAGE are ignored.
 */
export async function validateWirePayload(raw: unknown): Promise<ValidatedWireEmoji[]> {
    if (!Array.isArray(raw)) return [];
    const out: ValidatedWireEmoji[] = [];
    const seen = new Set<string>();
    for (const item of raw.slice(0, PERSONAL_EMOJI_MAX_PER_MESSAGE)) {
        const v = await validateWireEmoji(item);
        if ('rejected' in v || seen.has(v.id)) continue;
        seen.add(v.id);
        out.push(v);
    }
    return out;
}
