/**
 * The SENDER's copy of linked media (LinkEmbed `media.file`, 2026-11-24,
 * embeds-media-everywhere), on the READER: downloaded from Cipherline's own
 * attachment storage and decrypted with the key the message carries, exactly
 * like any attachment. No request ever goes to the linked host (that link may
 * have expired: a Discord CDN attachment). The decrypted bytes must be the
 * declared size and really the declared media type (magic bytes) before an
 * object URL is made; anything else is `failed` (the caller shows the link
 * card). Shared with the session's decrypted-media cache, so a remount paints
 * at once and nothing is decrypted twice.
 *
 * `enabled`: images / GIFs load as soon as they are shown (like any attachment
 * picture); a video copy only when the viewer presses play.
 */
import { useEffect, useState } from 'react';
import type { LinkEmbedMedia } from '@cipherline/shared';
import { useAuth } from '../../contexts/AuthContext';
import { API_BASE } from '../../constants';
import { downloadEncryptedAttachment } from '../../utils/attachmentDownload';
import { decryptBlob, importKeyFromBase64 } from '../../utils/crypto';
import { acquireDecryptedMedia, peekDecryptedMedia, putDecryptedMedia, releaseDecryptedMedia } from '../../utils/decryptedMediaCache';
import { acquireAutoLoadSlot } from '../../utils/autoLoadLimiter';
import { copyMatchesMime } from '../../utils/linkEmbeds/mediaCopy';

const cacheKey = (id: string) => `embed-media:${id}`;

export type MediaCopyState = { url: string | null; failed: boolean; loading: boolean };

/** Test seam: the download (default: the app's attachment download). */
export const mediaCopyIo = { download: downloadEncryptedAttachment };

export function useEmbedMediaCopy(media: LinkEmbedMedia | undefined, enabled: boolean): MediaCopyState {
    const auth = useAuth() as { token?: string | null } | null;
    const token = auth?.token ?? null;
    const f = media?.file;
    const id = f?.attachment_id;
    const key = f?.file_key_b64;
    const nonce = f?.file_nonce_b64;
    const size = f?.byte_size;
    const mime = media?.mime;
    const cached = id ? peekDecryptedMedia(cacheKey(id)) : null;
    const [state, setState] = useState<{ id: string; url: string | null; failed: boolean } | null>(null);

    useEffect(() => {
        if (!enabled || !id || !key || !nonce || !mime) return;
        let cancelled = false;
        let held = false;
        const k = cacheKey(id);
        if (acquireDecryptedMedia(k)) return () => { releaseDecryptedMedia(k); };
        if (!token) return;
        (async () => {
            const release = mime.startsWith('image/') ? await acquireAutoLoadSlot() : null;
            try {
                if (cancelled) return;
                const enc = await mediaCopyIo.download(id, token, API_BASE, { downloadTimeoutMs: 60_000 });
                const plain = await decryptBlob(enc, await importKeyFromBase64(key), nonce, mime);
                if (size && plain.size !== size) throw new Error('size mismatch');
                if (!copyMatchesMime(mime, new Uint8Array(await plain.slice(0, 16).arrayBuffer()))) throw new Error('not the declared media');
                if (cancelled) return;
                const url = putDecryptedMedia(k, URL.createObjectURL(plain), plain.size, plain);
                held = true;
                setState({ id, url, failed: false });
            } catch {
                if (!cancelled) setState({ id, url: null, failed: true });
            } finally {
                release?.();
            }
        })();
        return () => {
            cancelled = true;
            if (held) releaseDecryptedMedia(k);
        };
    }, [enabled, id, key, nonce, size, mime, token]);

    if (!id) return { url: null, failed: false, loading: false };
    if (state && state.id === id) return { url: state.url ?? cached, failed: state.failed && !cached, loading: false };
    if (cached) return { url: cached, failed: false, loading: false };
    return { url: null, failed: false, loading: enabled };
}
