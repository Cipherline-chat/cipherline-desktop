import secureLocalStore from './secureLocalStore';

// Fallback path (window.electronAPI unavailable) used to write avatar keys to
// raw, PLAINTEXT localStorage — a real key-at-rest exposure, and one the
// secureLocalStore purge sweep couldn't clean up since it lived outside that
// store entirely. In the packaged Electron app window.electronAPI is always
// present, so this fallback is essentially unreachable in production; keeping
// it routed through secureLocalStore (AES-256-GCM, same per-account isolation
// as everything else at rest) rather than dropping it costs nothing and means
// it's never a plaintext key even in whatever degraded context reaches it.
const FALLBACK_KEY_PREFIX = 'avatar_key_fallback_';

export async function saveAvatarKey(attachmentId: string, keyB64: string, nonceB64: string): Promise<boolean> {
    try {
        if (window.electronAPI?.setAvatarKey) {
            await window.electronAPI.setAvatarKey(attachmentId, keyB64, nonceB64);
            return true;
        }
    } catch (err) {
        console.warn('Failed to save avatar key via electron API, falling back to secureLocalStore', err);
    }

    // Fallback
    try {
        secureLocalStore.setItem(`${FALLBACK_KEY_PREFIX}${attachmentId}`, JSON.stringify({ keyB64, nonceB64 }));
        return true;
    } catch (e) {
        console.error('Failed to save avatar key to secureLocalStore', e);
        return false;
    }
}

export async function loadAvatarKey(attachmentId: string): Promise<{ keyB64: string, nonceB64: string } | null> {
    try {
        if (window.electronAPI?.getAvatarKey) {
            const data = await window.electronAPI.getAvatarKey(attachmentId);
            // An empty key is a tombstone left by deleteAvatarKey (the preload
            // has no delete IPC) - treat it as absent.
            if (data && data.keyB64) return data;
        }
    } catch (err) {
        console.warn('Failed to load avatar key via electron API, checking secureLocalStore', err);
    }

    // Fallback
    try {
        const local = secureLocalStore.getItem(`${FALLBACK_KEY_PREFIX}${attachmentId}`);
        if (local) { const parsed = JSON.parse(local); if (parsed?.keyB64) return parsed; }
    } catch (e) {
        console.error('Failed to load avatar key from secureLocalStore', e);
    }
    return null;
}

/**
 * Forget a cached key - used when it fails to decrypt the avatar it was saved
 * for (stale after a re-upload, or corrupt), so the next load asks the server.
 * The preload exposes no delete IPC, so the Electron path writes an empty
 * tombstone that loadAvatarKey() reads as "absent".
 */
export async function deleteAvatarKey(attachmentId: string): Promise<void> {
    try {
        if (window.electronAPI?.setAvatarKey) await window.electronAPI.setAvatarKey(attachmentId, '', '');
    } catch (err) {
        console.warn('Failed to clear avatar key via electron API', err);
    }
    try { secureLocalStore.removeItem(`${FALLBACK_KEY_PREFIX}${attachmentId}`); } catch { /* nothing to clear */ }
}
