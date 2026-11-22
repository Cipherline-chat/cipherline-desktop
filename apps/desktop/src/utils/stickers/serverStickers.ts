/**
 * Server stickers on the client — the emoji pipeline with a second list.
 *
 * A server sticker is a `server_emojis` row with kind 'sticker' on the API
 * (apps/api ServerEmojisService), so everything about its IMAGE is the custom
 * emoji path, unchanged: the blob is an encrypted attachment under the
 * server's emoji prefix, the key is on the row, and `serverEmojiLoader`
 * downloads/decrypts/caches it by attachment id (the batch route signs any
 * `server_emojis/<server_id>/` object). Only the LIST is separate:
 *
 *   GET /v1/servers/:id/stickers  one server (membership-gated)
 *   GET /v1/stickers              every server the caller is in, grouped
 *
 * Both land in `stickerListCache` (a second instance of emojiListCache's
 * store), so the picker, the message renderer and server settings share one
 * stale-while-revalidate list per server, refreshed on
 * `server:stickers_updated`.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import axios from 'axios';
import { apiUrl } from '../apiPath';
import { createServerListCache } from '../emojiListCache';
import { prefetchServerEmojis } from '../serverEmojiLoader';

/** Mirrors the API's ServerStickerDto (apps/api/src/servers/server-emojis.service.ts). */
export interface ServerSticker {
    sticker_id: string;
    server_id: string;
    name: string;
    description: string | null;
    tags: string[];
    attachment_id: string;
    key_b64: string;
    nonce_b64: string;
    animated: boolean;
    created_by: string | null;
    created_at: string;
}

export const stickerListCache = createServerListCache<ServerSticker>(s => s.sticker_id);

const EMPTY: ServerSticker[] = [];
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** Warm the first screenful of a list's images (encrypted disk cache first). */
function warm(serverId: string, list: ServerSticker[], token: string) {
    prefetchServerEmojis(serverId, list.slice(0, 24), token);
}

/** Fetch one server's list into the cache. Shared by the hook and the realtime refresh. */
export async function refreshServerStickers(serverId: string, token: string): Promise<void> {
    try {
        let list: ServerSticker[] = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            const epoch = stickerListCache.epoch(serverId);
            const res = await axios.get<ServerSticker[]>(apiUrl`/servers/${serverId}/stickers`, auth(token));
            list = Array.isArray(res.data) ? res.data : [];
            if (stickerListCache.epoch(serverId) === epoch) break;
        }
        stickerListCache.set(serverId, list);
        warm(serverId, list, token);
    } catch (err: unknown) {
        // 403 = no longer a member; 404 = an API that predates stickers. Either
        // way there is nothing to show for this server.
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 403 || status === 404) stickerListCache.set(serverId, []);
        stickerListCache.markSettled(serverId);
        if (status !== 403 && status !== 404) throw err;
    }
}

/** Every server's stickers in one read (GET /v1/stickers) — the picker. */
export async function refreshAllServerStickers(token: string): Promise<void> {
    const res = await axios.get<{ servers?: { server_id: string; stickers: ServerSticker[] }[] }>(apiUrl`/stickers`, auth(token));
    const servers = Array.isArray(res.data?.servers) ? res.data.servers : [];
    const seen = new Set<string>();
    for (const s of servers) {
        if (!s || typeof s.server_id !== 'string' || !Array.isArray(s.stickers)) continue;
        seen.add(s.server_id);
        stickerListCache.set(s.server_id, s.stickers);
    }
    // A server we had a list for but that came back without stickers has none
    // now (all deleted, or we left it).
    for (const id of stickerListCache.serverIds()) if (!seen.has(id)) stickerListCache.set(id, []);
    allLoadedAt = Date.now();
}

let allLoadedAt = 0;
/** When the cross-server index was last fetched (0 = never this session). */
export const allStickersLoadedAt = () => allLoadedAt;
export function resetStickerSession(): void { allLoadedAt = 0; stickerListCache.clear(); }

/** One server's stickers, live, plus the moderator mutations. Mirrors useServerEmojis. */
export function useServerStickers(serverId: string | null, token: string | null) {
    const stickers = useSyncExternalStore(
        stickerListCache.subscribe,
        () => (serverId ? stickerListCache.get(serverId) ?? EMPTY : EMPTY),
    );
    const loading = useSyncExternalStore(
        stickerListCache.subscribe,
        () => !!serverId && !!token && !stickerListCache.has(serverId) && !stickerListCache.isSettled(serverId),
    );

    const refresh = useCallback(async () => {
        if (!token || !serverId) return;
        try { await refreshServerStickers(serverId, token); } catch { /* network blip: keep what we show */ }
    }, [serverId, token]);

    useEffect(() => { void refresh(); }, [refresh]);

    const create = useCallback(async (body: {
        name: string; description?: string; tags?: string[];
        attachment_id: string; key_b64: string; nonce_b64: string;
    }): Promise<ServerSticker> => {
        if (!serverId || !token) throw new Error('Not ready');
        const res = await axios.post<ServerSticker>(apiUrl`/servers/${serverId}/stickers`, body, auth(token));
        stickerListCache.setLocal(serverId, stickerListCache.upsert(stickerListCache.get(serverId) ?? [], res.data));
        return res.data;
    }, [serverId, token]);

    const update = useCallback(async (stickerId: string, patch: { name?: string; description?: string; tags?: string[] }): Promise<ServerSticker> => {
        if (!serverId || !token) throw new Error('Not ready');
        const res = await axios.patch<ServerSticker>(apiUrl`/servers/${serverId}/stickers/${stickerId}`, patch, auth(token));
        stickerListCache.setLocal(serverId, stickerListCache.upsert(stickerListCache.get(serverId) ?? [], res.data));
        return res.data;
    }, [serverId, token]);

    const remove = useCallback(async (stickerId: string): Promise<void> => {
        if (!serverId || !token) throw new Error('Not ready');
        await axios.delete(apiUrl`/servers/${serverId}/stickers/${stickerId}`, auth(token));
        stickerListCache.setLocal(serverId, (stickerListCache.get(serverId) ?? []).filter(s => s.sticker_id !== stickerId));
    }, [serverId, token]);

    return { stickers, loading, refresh, create, update, remove };
}

/** A version number that changes whenever any server's sticker list does. */
let version = 0;
stickerListCache.subscribe(() => { version++; });
export function useStickerCacheVersion(): number {
    return useSyncExternalStore(stickerListCache.subscribe, () => version);
}

/** One fetch per server at a time, however many messages ask. */
const inflight = new Map<string, Promise<void>>();
function ensureServerStickers(serverId: string, token: string): void {
    if (stickerListCache.has(serverId) || inflight.has(serverId)) return;
    const p = refreshServerStickers(serverId, token).catch(() => {}).finally(() => { inflight.delete(serverId); });
    inflight.set(serverId, p);
}

/**
 * One server sticker for the RENDER path (a sticker message): `undefined`
 * while that server's list is loading, `null` when the sticker is gone (or the
 * list could not be read), else the row. Fetches the server's list at most
 * once (deduplicated); the list then stays live via server:stickers_updated.
 */
export function useServerSticker(serverId: string | null | undefined, stickerId: string, token: string | null): ServerSticker | null | undefined {
    const hit = useSyncExternalStore(stickerListCache.subscribe, () => {
        if (!serverId) return null;
        const list = stickerListCache.get(serverId);
        if (!list) return stickerListCache.isSettled(serverId) ? null : undefined;
        return list.find(s => s.sticker_id === stickerId) ?? null;
    });
    useEffect(() => {
        if (serverId && token && hit === undefined) ensureServerStickers(serverId, token);
    }, [serverId, token, hit]);
    return hit;
}

/** Look one sticker up (render path). Null until that server's list is known. */
export function findServerSticker(serverId: string, stickerId: string): ServerSticker | null | undefined {
    const list = stickerListCache.get(serverId);
    if (!list) return undefined; // not loaded yet
    return list.find(s => s.sticker_id === stickerId) ?? null; // null = deleted
}
