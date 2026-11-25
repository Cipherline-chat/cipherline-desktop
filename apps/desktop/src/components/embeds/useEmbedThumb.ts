/**
 * The sender's preview image for a link embed, on the RECEIVER (phase 3).
 *
 * No request ever goes to the linked site: the picture is either inline in
 * the (already decrypted) message, or an ordinary encrypted attachment on
 * Cipherline's own storage, downloaded and decrypted with the key the message
 * carries — the same path as any image someone sends. The decrypted bytes
 * must really be the declared image type (magic bytes) before an object URL
 * is made; anything else shows no picture. Attachment thumbnails share the
 * session's decrypted-media cache (utils/decryptedMediaCache), so a remount
 * paints at once and nothing is decrypted twice.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EmbedImage } from '@cipherline/shared';
import { useAuth } from '../../contexts/AuthContext';
import { API_BASE } from '../../constants';
import { downloadEncryptedAttachment } from '../../utils/attachmentDownload';
import { decryptBlob, importKeyFromBase64 } from '../../utils/crypto';
import { acquireDecryptedMedia, peekDecryptedMedia, putDecryptedMedia, releaseDecryptedMedia } from '../../utils/decryptedMediaCache';
import { acquireAutoLoadSlot } from '../../utils/autoLoadLimiter';
import { base64ToBytes, sniffImageMime } from '../../utils/linkEmbeds/thumb';

const cacheKey = (id: string) => `embed-thumb:${id}`;

export type EmbedThumbState = { url: string | null; failed: boolean };

/** The decrypted thumbnail's object URL (null while loading / when absent), and whether it failed. */
export function useEmbedThumb(thumb: EmbedImage | undefined): EmbedThumbState {
    const auth = useAuth() as { token?: string | null } | null;
    const token = auth?.token ?? null;
    // Primitives only: the embed objects are rebuilt by the validator on every
    // render of a message, and must not restart the download.
    const inline = thumb?.inline_b64;
    const attachmentId = thumb?.attachment_id;
    const mime = thumb?.mime;
    const fileKey = thumb?.file_key_b64;
    const nonce = thumb?.file_nonce_b64;
    const byteSize = thumb?.byte_size;

    // Inline bytes: checked (magic bytes = the declared type), then drawn as a
    // data: URL — no object URL to revoke, nothing fetched.
    const inlineUrl = useMemo(() => {
        if (!inline || !mime) return null;
        try {
            return sniffImageMime(base64ToBytes(inline)) === mime ? `data:${mime};base64,${inline}` : null;
        } catch {
            return null;
        }
    }, [inline, mime]);

    // Decrypted earlier this session (any message showing the same thumbnail): paint at once.
    const cached = attachmentId ? peekDecryptedMedia(cacheKey(attachmentId)) : null;
    const [state, setState] = useState<{ id: string; url: string | null; failed: boolean } | null>(null);

    useEffect(() => {
        if (!attachmentId || !fileKey || !nonce || !mime) return;
        let cancelled = false;
        let held = false;
        const key = cacheKey(attachmentId);
        // Already decrypted: just hold it while shown (the render reads it via peek).
        if (acquireDecryptedMedia(key)) return () => { releaseDecryptedMedia(key); };
        if (!token) return;
        (async () => {
            const release = await acquireAutoLoadSlot();
            try {
                if (cancelled) return;
                const enc = await downloadEncryptedAttachment(attachmentId, token, API_BASE, { downloadTimeoutMs: 20_000 });
                const cryptoKey = await importKeyFromBase64(fileKey);
                const plain = await decryptBlob(enc, cryptoKey, nonce, mime);
                if (byteSize && plain.size !== byteSize) throw new Error('size mismatch');
                const head = new Uint8Array(await plain.slice(0, 16).arrayBuffer());
                if (sniffImageMime(head) !== mime) throw new Error('not the declared image');
                if (cancelled) return;
                const url = putDecryptedMedia(key, URL.createObjectURL(plain), plain.size, plain);
                held = true;
                setState({ id: attachmentId, url, failed: false });
            } catch {
                if (!cancelled) setState({ id: attachmentId, url: null, failed: true });
            } finally {
                release();
            }
        })();
        return () => {
            cancelled = true;
            if (held) releaseDecryptedMedia(key);
        };
    }, [attachmentId, fileKey, nonce, mime, byteSize, token]);

    if (!mime) return { url: null, failed: false };
    if (inline) return { url: inlineUrl, failed: !inlineUrl };
    if (state && state.id === attachmentId) return { url: state.url ?? cached, failed: state.failed && !cached };
    if (cached) return { url: cached, failed: false };
    return { url: null, failed: false };
}
