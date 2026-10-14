/**
 * React access to the shared server storage-status cache
 * (utils/serverStorageStatusStore.ts — read it for the pacing/caching rules).
 *
 * Fetch triggers, deliberately NOT a timer:
 *   - a server becomes the one being shown (banner) / its settings open;
 *   - the WS push `server:storage_status_changed`, which useRealtime re-emits
 *     as the `SERVER_STORAGE_STATUS_WINDOW_EVENT` window event — only the
 *     pushed server is refetched, and only if something is showing it;
 *   - a WS reconnect (`wsConnectCount`), to self-heal a push missed offline.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import axios from 'axios';
import type { ServerStorageStatus } from '@cipherline/shared';
import { API_BASE } from '../constants';
import { apiUrl } from '../utils/apiPath';
import {
    createServerStorageStatusStore,
    SERVER_STORAGE_STATUS_WINDOW_EVENT,
    StorageStatusHttpError,
    storageStatusPushServerId,
    type ServerStorageStatusStore,
} from '../utils/serverStorageStatusStore';
import { countOwnedServersOverFreeStorage } from '../utils/serverStorageGrace';

async function fetchStorageStatus(serverId: string, token: string): Promise<ServerStorageStatus> {
    try {
        const res = await axios.get<ServerStorageStatus>(
            apiUrl`/servers/${serverId}/storage-status`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        return res.data;
    } catch (e: unknown) {
        const status = (e as { response?: { status?: number } })?.response?.status;
        throw new StorageStatusHttpError(typeof status === 'number' ? status : 0);
    }
}

/** The app-wide instance. */
export const serverStorageStatusStore: ServerStorageStatusStore =
    createServerStorageStatusStore({ fetcher: fetchStorageStatus });

/** Latest token, so the module-level push listener can refetch. */
let currentToken: string | null = null;
let pushListenerInstalled = false;

function installPushListener(): void {
    if (pushListenerInstalled || typeof window === 'undefined') return;
    pushListenerInstalled = true;
    window.addEventListener(SERVER_STORAGE_STATUS_WINDOW_EVENT, (ev: Event) => {
        const id = storageStatusPushServerId((ev as CustomEvent).detail);
        if (id) serverStorageStatusStore.handlePush(id, currentToken);
    });
}

/**
 * Track the signed-in account: the cache is dropped when the token's owner
 * changes so one account never sees another's (owner-scoped) status.
 */
let currentUserId: string | null = null;
function bindAccount(userId: string | null, token: string | null): void {
    if (userId !== currentUserId) {
        if (currentUserId !== null) serverStorageStatusStore.reset();
        currentUserId = userId;
    }
    currentToken = token;
}

/**
 * Status for one server (null serverId = nothing). Returns `undefined` until
 * the first answer, `null` when there is nothing to show.
 */
export function useServerStorageStatus(
    serverId: string | null | undefined,
    token: string | null,
    userId: string | null,
    wsConnectCount = 0,
): ServerStorageStatus | null | undefined {
    // Account binding runs before the fetch effect below (effects run in order).
    useEffect(() => { bindAccount(userId, token); installPushListener(); }, [userId, token]);

    const subscribe = useCallback(
        (cb: () => void) => (serverId ? serverStorageStatusStore.subscribe(serverId, cb) : () => {}),
        [serverId],
    );
    const getSnapshot = useCallback(
        () => (serverId ? serverStorageStatusStore.get(serverId) : undefined),
        [serverId],
    );
    const status = useSyncExternalStore(subscribe, getSnapshot);

    useEffect(() => {
        if (!serverId || !token) return;
        void serverStorageStatusStore.ensure(serverId, token);
    }, [serverId, token]);

    // Reconnect: a push may have been missed while offline. Skips the first
    // connect (the effect above already covers boot).
    const prevConnect = useRef(wsConnectCount);
    useEffect(() => {
        const prev = prevConnect.current;
        prevConnect.current = wsConnectCount;
        if (wsConnectCount === prev || prev === 0) return;
        if (serverId && token) void serverStorageStatusStore.refresh(serverId, token);
        // Only a reconnect should trigger this, not a server switch.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wsConnectCount]);

    return status;
}

/**
 * Billing cancel confirmation: how many servers the user OWNS are over the free
 * 25 MB. Runs only while `enabled` (the confirmation is open) — one
 * `GET /servers`, then the storage status of owned servers only, paced by the
 * shared store and served from its cache where fresh (60 s).
 */
export function useOwnedServersOverFreeStorage(
    enabled: boolean,
    token: string | null,
    userId: string | null,
): { overCount: number } {
    const [overCount, setOverCount] = useState(0);

    useEffect(() => {
        if (!enabled || !token || !userId) return;
        bindAccount(userId, token);
        let cancelled = false;
        void (async () => {
            try {
                const res = await axios.get<Array<{ server_id: string; owner_user_id: string }>>(
                    `${API_BASE}/servers`,
                    { headers: { Authorization: `Bearer ${token}` } },
                );
                if (cancelled) return;
                // Statuses come from the shared, paced store (fresh for 60 s),
                // so a reopen recounts from cache rather than refetching.
                const n = await countOwnedServersOverFreeStorage({
                    servers: Array.isArray(res.data) ? res.data : [],
                    userId,
                    getStatus: (id) => serverStorageStatusStore.ensure(id, token, 60_000),
                    isCancelled: () => cancelled,
                });
                if (!cancelled) setOverCount(n);
            } catch {
                // Informational only: the cancel itself never waits on this.
            }
        })();
        return () => { cancelled = true; };
    }, [enabled, token, userId]);

    return { overCount: enabled ? overCount : 0 };
}
