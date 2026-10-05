import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';

/** Mirrors the API's ServerEmojiDto (apps/api/src/servers/server-emojis.service.ts). */
export interface ServerEmoji {
    emoji_id: string;
    server_id: string;
    name: string;
    attachment_id: string;
    key_b64: string;
    nonce_b64: string;
    animated: boolean;
    /** NULL once the uploader's account is erased — GDPR Art.17 nulls the
     *  attribution and keeps the emoji, since deleting it would remove another
     *  server's content because one member exercised erasure. Display-only. */
    created_by: string | null;
    created_at: string;
}

/**
 * Custom server emoji CRUD — see docs/custom-emoji-design.md.
 *
 * Fetches on mount / whenever `serverId` changes, and after every local
 * mutation (create/rename/remove) so the caller's own edits show up
 * immediately without waiting on a round-trip through the WS fan-out. A
 * DIFFERENT member's edit shows up too, via ChatPane's own listener for
 * `server:emojis_updated` calling this hook's `refresh` directly (see
 * ChatPane.tsx's `emojisChangedEvent` effect) — this hook itself stays
 * unaware of the realtime layer, it just exposes `refresh` for that.
 */
export function useServerEmojis(serverId: string | null, token: string | null) {
    const [emojis, setEmojis] = useState<ServerEmoji[]>([]);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        if (!serverId || !token) { setEmojis([]); setLoading(false); return; }
        setLoading(true);
        try {
            const res = await axios.get<ServerEmoji[]>(`${API_BASE}/servers/${serverId}/emojis`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setEmojis(res.data ?? []);
        } catch {
            // 403 (not a member) / network blip — leave the list empty rather
            // than throw; callers that need to surface an error do so around
            // their own mutating calls, not around this background fetch.
        } finally {
            setLoading(false);
        }
    }, [serverId, token]);

    useEffect(() => { refresh(); }, [refresh]);

    const create = useCallback(async (body: {
        // No `animated` here — the server derives it itself from the
        // decoded image (EmojiImageProcessorService), which also center-
        // crops it to a square and re-encrypts it before ever storing it;
        // key_b64/nonce_b64 below decrypt the AS-UPLOADED original only.
        name: string; attachment_id: string; key_b64: string; nonce_b64: string;
    }): Promise<ServerEmoji> => {
        if (!serverId || !token) throw new Error('Not ready');
        const res = await axios.post<ServerEmoji>(`${API_BASE}/servers/${serverId}/emojis`, body, {
            headers: { Authorization: `Bearer ${token}` },
        });
        setEmojis(prev => [...prev, res.data]);
        return res.data;
    }, [serverId, token]);

    const rename = useCallback(async (emojiId: string, name: string): Promise<ServerEmoji> => {
        if (!serverId || !token) throw new Error('Not ready');
        const res = await axios.patch<ServerEmoji>(
            `${API_BASE}/servers/${serverId}/emojis/${emojiId}`,
            { name },
            { headers: { Authorization: `Bearer ${token}` } },
        );
        setEmojis(prev => prev.map(e => (e.emoji_id === emojiId ? res.data : e)));
        return res.data;
    }, [serverId, token]);

    const remove = useCallback(async (emojiId: string): Promise<void> => {
        if (!serverId || !token) throw new Error('Not ready');
        await axios.delete(`${API_BASE}/servers/${serverId}/emojis/${emojiId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        setEmojis(prev => prev.filter(e => e.emoji_id !== emojiId));
    }, [serverId, token]);

    return { emojis, loading, refresh, create, rename, remove };
}
