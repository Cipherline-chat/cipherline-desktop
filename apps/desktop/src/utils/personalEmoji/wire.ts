/**
 * Carrying personal emojis inside E2EE messages.
 *
 * SEND: a message whose text (or edit text, or reaction key) holds personal
 * tokens gets an optional `personal_emojis` array with the bytes of each
 * distinct emoji it uses (`attachPersonalEmojis`). Added at the last moment
 * before encryption, so the optimistic in-feed copy and the retry queue never
 * carry multi-KB blobs.
 *
 * RECEIVE: right after decryption, `takePersonalEmojis` validates the array
 * (content hash, magic bytes, size, count - the sender is untrusted), files the
 * images in the local encrypted store, and returns the content WITHOUT the
 * field, so message history (and so backups) never holds the bytes twice. Only
 * ids the message's own tokens reference are stored.
 *
 * The server never sees any of this: it all lives inside the encrypted content.
 */

import {
    PERSONAL_EMOJI_MAX_PER_MESSAGE, bytesToB64, isPersonalEmojiName, personalTokenSource, personalTokensIn,
    validateWirePayload, type PersonalEmojiWire,
} from './token';
import type { PutMeta } from './store';

/** The slice of the store this module needs (the real one is `personalEmojis().store`). */
export interface EmojiBytesStore {
    read(id: string): Promise<Uint8Array | null>;
    put(id: string, bytes: Uint8Array, meta: PutMeta): Promise<void>;
    meta(id: string): { m: string; a: 0 | 1; n: string } | undefined;
}

type AnyContent = Record<string, unknown>;

/** Content with `personal_emojis` for every personal token it uses and whose
 *  bytes this device has. Returns the SAME object when there is nothing to add. */
export async function attachPersonalEmojis<T>(content: T, store: EmojiBytesStore): Promise<T> {
    const source = personalTokenSource(content);
    if (!source) return content;
    const tokens = personalTokensIn(source).slice(0, PERSONAL_EMOJI_MAX_PER_MESSAGE);
    if (tokens.length === 0) return content;
    const payload: PersonalEmojiWire[] = [];
    for (const t of tokens) {
        const bytes = await store.read(t.id);
        if (!bytes) continue; // receiver shows the unavailable glyph for this one
        const meta = store.meta(t.id);
        payload.push({
            id: t.id,
            name: isPersonalEmojiName(t.name) ? t.name : (meta?.n ?? 'emoji'),
            mime: meta?.m ?? 'image/webp',
            animated: meta?.a === 1,
            bytes_b64: bytesToB64(bytes),
        });
    }
    if (payload.length === 0) return content;
    return { ...(content as AnyContent), personal_emojis: payload } as T;
}

/** JSON for the wire: the content plus its emoji payload. */
export async function serializeForSend(content: unknown, store: EmojiBytesStore): Promise<string> {
    return JSON.stringify(await attachPersonalEmojis(content, store));
}

export interface TakeResult<T> {
    /** `content` minus `personal_emojis` (same object if it had none). */
    content: T;
    /** Resolves once the validated images are stored. Never rejects. */
    stored: Promise<string[]>;
}

/** Strip and ingest. The strip is synchronous; storing is background work. */
export function takePersonalEmojis<T>(content: T, store: EmojiBytesStore): TakeResult<T> {
    if (!content || typeof content !== 'object' || !('personal_emojis' in (content as AnyContent))) {
        return { content, stored: Promise.resolve([]) };
    }
    const { personal_emojis: raw, ...rest } = content as AnyContent;
    const source = personalTokenSource(content);
    const wanted = new Set(personalTokensIn(source).map(t => t.id));
    const stored = (async () => {
        if (wanted.size === 0) return [];
        const ok = (await validateWirePayload(raw)).filter(e => wanted.has(e.id));
        const done: string[] = [];
        for (const e of ok) {
            try {
                await store.put(e.id, e.bytes, { mime: e.mime, animated: e.animated, name: e.name });
                done.push(e.id);
            } catch { /* disk full / locked store: the token just renders as unavailable */ }
        }
        return done;
    })().catch(() => []);
    return { content: rest as T, stored };
}
