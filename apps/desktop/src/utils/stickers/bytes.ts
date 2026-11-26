/**
 * A sticker's image bytes on this device, whichever kind it is:
 *   personal - the shared personal blob store (own library or received cache)
 *   server   - the server's list (stickerListCache) for its key material, then
 *              the custom-emoji loader (encrypted disk cache / signed URL),
 *              decrypted to a blob: URL we read back.
 * Used to send a server sticker OUTSIDE its server (as personal bytes, so a
 * recipient who is not a member can still see it) and for "Add to My stickers".
 */
import { personalStickers } from '../personalEmoji/service';
import { personalEmojiIdFromBytes, sniffImageMime, isAnimatedImage } from '../personalEmoji/token';
import { loadEmojiUrl } from '../serverEmojiLoader';
import { STICKER_MAX_BYTES } from '@cipherline/shared';
import { findServerSticker, refreshServerStickers } from './serverStickers';
import { peekAssetRef } from '../serverAssetRefs';
import type { StickerRef } from './wire';

export async function serverStickerBytes(serverId: string, stickerId: string, token: string): Promise<Uint8Array | null> {
    let s = findServerSticker(serverId, stickerId);
    if (s === undefined) {
        try { await refreshServerStickers(serverId, token); } catch { /* fall through */ }
        s = findServerSticker(serverId, stickerId);
    }
    // Not in the server's list (deleted/retired, or not loaded)? The device's remembered ref still has the key.
    const kept = s ? null : peekAssetRef(stickerId);
    const row = s ?? (kept && kept.kind === 'sticker' ? { attachment_id: kept.attachment_id, key_b64: kept.key_b64, nonce_b64: kept.nonce_b64 } : null);
    if (!row) return null;
    const url = await loadEmojiUrl({ serverId, attachmentId: row.attachment_id, keyB64: row.key_b64, nonceB64: row.nonce_b64 }, token, 'visible');
    if (!url) return null;
    try { return new Uint8Array(await (await fetch(url)).arrayBuffer()); } catch { return null; }
}

export async function stickerBytes(ref: StickerRef, token: string | null): Promise<Uint8Array | null> {
    if (ref.source === 'personal') return personalStickers().store.read(ref.id);
    if (!token || !ref.server_id) return null;
    return serverStickerBytes(ref.server_id, ref.id, token);
}

/**
 * Turn a server sticker into a PERSONAL one (content-addressed bytes filed in
 * the shared store) so it can travel inside an E2EE message to people who are
 * not members of its server. Null when the image is not available.
 */
export async function serverStickerAsPersonal(serverId: string, stickerId: string, name: string, token: string): Promise<StickerRef | null> {
    const bytes = await serverStickerBytes(serverId, stickerId, token);
    if (!bytes || bytes.length === 0 || bytes.length > STICKER_MAX_BYTES) return null;
    const mime = sniffImageMime(bytes);
    if (!mime) return null;
    const id = await personalEmojiIdFromBytes(bytes);
    const animated = isAnimatedImage(bytes, mime);
    const store = personalStickers().store;
    await store.put(id, bytes, { mime, animated, name });
    if (!store.has(id)) return null;
    return { source: 'personal', id, name, mime, animated };
}
