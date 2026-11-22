/**
 * Stickers inside E2EE messages (contract: packages/shared/stickers.ts).
 *
 * A sticker message is `{ type: 'text', text: '[Sticker: name]', sticker }`.
 * The `text` is the fallback a client that predates stickers shows; this
 * client draws the sticker and never the text.
 *
 * SEND: the optimistic copy and the delivery retry queue carry the sticker
 * WITHOUT bytes; `attachStickerBytes` adds a personal sticker's `bytes_b64`
 * at the last moment before encryption (exactly like personal_emojis), from
 * the shared personal blob store.
 *
 * RECEIVE: `takeSticker` runs on every decrypted body before it is shown or
 * stored. A malformed `sticker` is dropped (the row shows the fallback text,
 * never a broken image). A personal sticker's bytes are stripped
 * synchronously and filed in the store in the background after checking
 * size, magic bytes and that SHA-256(bytes) matches the id — so history and
 * backups never hold the bytes twice, and no sender can plant pixels under an
 * id another sender's sticker resolves to.
 *
 * The server never sees any of this: it all lives inside the encrypted content.
 */
import {
    PERSONAL_STICKER_ID_RE, SERVER_STICKER_ID_RE, STICKER_MAX_BYTES, STICKER_NAME_RE,
    stickerFallbackText, stickerPayloadProblem, type StickerPayload,
} from '@cipherline/shared';
import { bytesToB64, validateWireEmoji } from '../personalEmoji/token';
import type { EmojiBytesStore } from '../personalEmoji/wire';

type AnyContent = Record<string, unknown>;

/** A sticker as stored in history (bytes already filed away). */
export interface StickerRef {
    source: 'server' | 'personal';
    id: string;
    name: string;
    server_id?: string;
    mime?: string;
    animated?: boolean;
}

/**
 * The sticker of a stored/rendered message, or null. Structural only — a
 * personal sticker's bytes are not here (they are in the store). Never throws.
 */
export function stickerRefOf(content: unknown): StickerRef | null {
    if (!content || typeof content !== 'object') return null;
    const c = content as AnyContent;
    if (c.type !== 'text') return null;
    const s = c.sticker as AnyContent | undefined;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    if (typeof s.name !== 'string' || !STICKER_NAME_RE.test(s.name) || typeof s.id !== 'string') return null;
    if (s.source === 'server') {
        if (!SERVER_STICKER_ID_RE.test(s.id) || typeof s.server_id !== 'string' || !SERVER_STICKER_ID_RE.test(s.server_id)) return null;
        return { source: 'server', id: s.id, name: s.name, server_id: s.server_id };
    }
    if (s.source === 'personal') {
        if (!PERSONAL_STICKER_ID_RE.test(s.id)) return null;
        return {
            source: 'personal', id: s.id, name: s.name,
            ...(typeof s.mime === 'string' ? { mime: s.mime } : {}),
            ...(typeof s.animated === 'boolean' ? { animated: s.animated } : {}),
        };
    }
    return null;
}

export const isStickerMessage = (content: unknown): boolean => stickerRefOf(content) !== null;

/** The text content of a sticker message (no bytes: those are added at send). */
export function buildStickerContent(sticker: StickerRef, replyToId?: string | null): { type: 'text'; text: string; sticker: StickerPayload; reply_to_id?: string } {
    const payload: StickerPayload = sticker.source === 'server'
        ? { source: 'server', id: sticker.id, name: sticker.name, server_id: sticker.server_id }
        : { source: 'personal', id: sticker.id, name: sticker.name, mime: sticker.mime ?? 'image/webp', animated: !!sticker.animated };
    return {
        type: 'text',
        text: stickerFallbackText(sticker.name),
        sticker: payload,
        ...(replyToId ? { reply_to_id: replyToId } : {}),
    };
}

/** A personal sticker's bytes for the wire, read from the store. Returns the
 *  SAME object when there is nothing to add; drops the sticker (fallback text
 *  only) when its bytes are not on this device. */
export async function attachStickerBytes<T>(content: T, store: Pick<EmojiBytesStore, 'read' | 'meta'>): Promise<T> {
    const ref = stickerRefOf(content);
    if (!ref || ref.source !== 'personal') return content;
    const c = content as AnyContent;
    const s = c.sticker as AnyContent;
    if (typeof s.bytes_b64 === 'string' && s.bytes_b64) return content;
    const bytes = await store.read(ref.id);
    if (!bytes || bytes.length > STICKER_MAX_BYTES) {
        const { sticker: _drop, ...rest } = c;
        return rest as T;
    }
    const meta = store.meta(ref.id);
    return {
        ...c,
        sticker: { ...s, mime: meta?.m ?? ref.mime ?? 'image/webp', animated: meta ? meta.a === 1 : !!ref.animated, bytes_b64: bytesToB64(bytes) },
    } as T;
}

export interface TakeStickerResult<T> {
    content: T;
    /** Resolves true once a personal sticker's bytes are verified and stored. Never rejects. */
    stored: Promise<boolean>;
}

/** Strip, validate and ingest a received sticker. Synchronous strip; storing is background work. */
export function takeSticker<T>(content: T, store: Pick<EmojiBytesStore, 'put'>): TakeStickerResult<T> {
    const none = { content, stored: Promise.resolve(false) };
    if (!content || typeof content !== 'object' || !('sticker' in (content as AnyContent))) return none;
    const c = content as AnyContent;
    const { sticker: raw, ...rest } = c;
    // Only a text message may carry a sticker, and only a well-formed one.
    if (c.type !== 'text' || stickerPayloadProblem(raw) !== null) {
        return { content: rest as T, stored: Promise.resolve(false) };
    }
    const s = raw as StickerPayload;
    if (s.source === 'server') {
        return { content: { ...rest, sticker: { source: 'server', id: s.id, name: s.name, server_id: s.server_id } } as T, stored: Promise.resolve(false) };
    }
    const stored = (async () => {
        const v = await validateWireEmoji({ id: s.id, name: s.name, bytes_b64: s.bytes_b64 }, STICKER_MAX_BYTES);
        if ('rejected' in v) return false;
        try { await store.put(v.id, v.bytes, { mime: v.mime, animated: v.animated, name: v.name }); return true; }
        catch { return false; }
    })().catch(() => false);
    return {
        content: { ...rest, sticker: { source: 'personal', id: s.id, name: s.name, mime: s.mime, animated: !!s.animated } } as T,
        stored,
    };
}

/**
 * The line a sticker message's franking commitment and report carry: the
 * fallback text plus the sticker as an emoji-style token `<:name:id>`. That
 * token is what lets the report pipeline show the sticker's IMAGE through the
 * custom-emoji evidence path (a server sticker is copied by the API from its
 * own storage; a personal one is uploaded by the reporter and checked against
 * its content-addressed id), and it binds the id into what the sender
 * committed to.
 */
export function stickerReportText(content: unknown): string | null {
    const ref = stickerRefOf(content);
    if (!ref) return null;
    // The message's OWN text (normally the fallback), not one rebuilt from the
    // name: the commitment must cover exactly what an older client displays.
    const text = (content as { text?: unknown }).text;
    return `${typeof text === 'string' ? text : stickerFallbackText(ref.name)}\n<:${ref.name}:${ref.id}>`;
}

/** Display line for previews / notifications / reply quotes. */
export function stickerPreviewText(content: unknown): string | null {
    const ref = stickerRefOf(content);
    return ref ? `Sticker: ${ref.name}` : null;
}
