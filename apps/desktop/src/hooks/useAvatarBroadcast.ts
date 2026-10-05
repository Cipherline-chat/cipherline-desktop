import axios from 'axios';
import { API_BASE } from '../constants';
import { useCallback } from 'react';

/**
 * Avatar key distribution — new model:
 *
 * Instead of encrypting keys into per-friend Signal envelopes (which fail for
 * offline users and new group members), we store the key server-side on the
 * Attachment record. Friends and group members fetch it on-demand via
 * GET /v1/attachments/:id/key, which gates access by friendship / membership.
 *
 * The server emits user:avatar_updated to online friends whenever the profile
 * is updated, so real-time UI refresh still works without a broadcast loop.
 *
 * Callers should still invoke broadcastProfileAvatarKey / broadcastGroupAvatarKey
 * immediately after the MinIO upload so the key is available before anyone requests it.
 */
export function useAvatarBroadcast(token: string | null, _userId: string | null) {
    /**
     * Store the avatar decryption key on the server so any friend can retrieve it
     * at any point — including after reconnecting from a long offline period.
     */
    const broadcastProfileAvatarKey = useCallback(
        async (attachmentId: string, keyB64: string, nonceB64: string) => {
            if (!token) return;
            try {
                await axios.patch(
                    `${API_BASE}/attachments/${attachmentId}/key`,
                    { file_key_b64: keyB64, file_nonce_b64: nonceB64 },
                    { headers: { Authorization: `Bearer ${token}` } }
                );
            } catch (err) {
                console.error('[useAvatarBroadcast] Failed to store profile avatar key on server', err);
            }
        },
        [token]
    );

    /**
     * Store the group icon decryption key on the server so any group member can
     * retrieve it — including members who join after the icon was set.
     */
    const broadcastGroupAvatarKey = useCallback(
        async (_conversationId: string, attachmentId: string, keyB64: string, nonceB64: string) => {
            if (!token) return;
            try {
                await axios.patch(
                    `${API_BASE}/attachments/${attachmentId}/key`,
                    { file_key_b64: keyB64, file_nonce_b64: nonceB64 },
                    { headers: { Authorization: `Bearer ${token}` } }
                );
            } catch (err) {
                console.error('[useAvatarBroadcast] Failed to store group avatar key on server', err);
            }
        },
        [token]
    );

    /**
     * No-op: key re-sync is now handled server-side.
     * Friends who reconnect after missing an avatar update fetch the key directly
     * from the server via GET /v1/attachments/:id/key.
     */
    const broadcastCurrentAvatar = useCallback(async (_conversationsList?: any[]) => {
        // No-op — server holds the key permanently; no client-side re-broadcast needed.
    }, []);

    return { broadcastProfileAvatarKey, broadcastGroupAvatarKey, broadcastCurrentAvatar };
}
