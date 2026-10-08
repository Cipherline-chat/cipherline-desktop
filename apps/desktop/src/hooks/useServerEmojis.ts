import { useEffect, useCallback, useSyncExternalStore } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { prefetchServerEmojis } from '../utils/serverEmojiLoader';
import { emojiListCache } from '../utils/emojiListCache';

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
 * Stale-while-revalidate: the last list seen for a server THIS SESSION
 * (emojiListCache, memory only) is returned synchronously on mount and on
 * every switch back to that server, so messages render their emojis at once
 * instead of showing placeholders until a fresh list arrives. The list is
 * still refetched in the background each time and replaces the cached one.
 * `loading` is true only while there is no list at all for this server.
 *
 * Each fetched list warms its emoji images (prefetchServerEmojis: encrypted
 * disk cache first, then batched network at background priority), so the
 * picker and messages paint from memory.
 *
 * Also refreshes after every local mutation (create/rename/remove), and a
 * DIFFERENT member's edit arrives via ChatPane's `server:emojis_updated`
 * listener calling `refresh` — this hook stays unaware of the realtime layer.
 */
const EMPTY: ServerEmoji[] = [];

export function useServerEmojis(serverId: string | null, token: string | null) {
    // The list for THIS server straight from the session store — so a server
    // switch shows that server's cached list (or nothing) at once, never the
    // previous server's, and a late response for a server already left only
    // updates the store.
    const emojis = useSyncExternalStore(
        emojiListCache.subscribe,
        () => (serverId ? emojiListCache.get(serverId) ?? EMPTY : EMPTY),
    );
    const loading = useSyncExternalStore(
        emojiListCache.subscribe,
        () => !!serverId && !!token && !emojiListCache.has(serverId) && !emojiListCache.isSettled(serverId),
    );

    const refresh = useCallback(async () => {
        if (!token) { emojiListCache.clear(); return; }
        if (!serverId) return;
        try {
            const res = await axios.get<ServerEmoji[]>(`${API_BASE}/servers/${serverId}/emojis`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const list = res.data ?? [];
            emojiListCache.set(serverId, list);
            prefetchServerEmojis(serverId, list, token);
        } catch (err: unknown) {
            // 403 = no longer a member: forget the cached list. A network blip
            // keeps whatever we already show. Callers surface errors around
            // their own mutating calls, not around this background fetch.
            if (axios.isAxiosError(err) && err.response?.status === 403) emojiListCache.delete(serverId);
            emojiListCache.markSettled(serverId);
        }
    }, [serverId, token]);

    useEffect(() => { void refresh(); }, [refresh]);

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
        emojiListCache.set(serverId, [...(emojiListCache.get(serverId) ?? []), res.data]);
        return res.data;
    }, [serverId, token]);

    const rename = useCallback(async (emojiId: string, name: string): Promise<ServerEmoji> => {
        if (!serverId || !token) throw new Error('Not ready');
        const res = await axios.patch<ServerEmoji>(
            `${API_BASE}/servers/${serverId}/emojis/${emojiId}`,
            { name },
            { headers: { Authorization: `Bearer ${token}` } },
        );
        emojiListCache.set(serverId, (emojiListCache.get(serverId) ?? []).map(e => (e.emoji_id === emojiId ? res.data : e)));
        return res.data;
    }, [serverId, token]);

    const remove = useCallback(async (emojiId: string): Promise<void> => {
        if (!serverId || !token) throw new Error('Not ready');
        await axios.delete(`${API_BASE}/servers/${serverId}/emojis/${emojiId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        emojiListCache.set(serverId, (emojiListCache.get(serverId) ?? []).filter(e => e.emoji_id !== emojiId));
    }, [serverId, token]);

    return { emojis, loading, refresh, create, rename, remove };
}
