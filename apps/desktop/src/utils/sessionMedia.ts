/**
 * Everything plaintext-media the renderer keeps warm for fast chat switching —
 * decrypted attachment / saved-GIF object URLs (+ their inline thumbnails) and
 * remote images fetched through the main process. None of it may outlive the
 * session it belongs to, so EVERY way a session ends (explicit sign-out, the
 * session-revoked close, a refresh token the server rejected) calls this. Held
 * entries are revoked too: a mounted pane just loses its images.
 */
import { clearDecryptedMediaCache } from './decryptedMediaCache';
import { clearRemoteImageCache } from './remoteImageCache';

export function dropSessionMedia(): void {
    clearDecryptedMediaCache();
    clearRemoteImageCache();
}
