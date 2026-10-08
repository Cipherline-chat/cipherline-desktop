import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';

/** GET /servers/:id/storage. Everything counted against the quota is in
 *  `used_bytes` (saves + custom emojis); the split fields are absent on an
 *  API older than the emoji-storage change. */
export interface ServerStorageQuota {
    used_bytes: number;
    limit_bytes: number;
    member_count: number;
    tier_label: string;
    storage_plan?: 'flat25' | 'ladder';
    saves_bytes?: number;
    emoji_bytes?: number;
    emoji_count?: number;
}

/** The server's storage quota, refetched when `refreshKey` changes and via
 *  the returned `refresh`. Display only — the API enforces the quota. */
export function useServerStorageQuota(serverId: string | null, token: string | null, refreshKey = 0) {
    // Tagged with the server it belongs to, so a switch never shows the
    // previous server's numbers while the new ones load.
    const [state, setState] = useState<{ serverId: string; quota: ServerStorageQuota } | null>(null);

    const fetchQuota = useCallback(() => {
        if (!serverId || !token) return Promise.resolve(null);
        return axios.get<ServerStorageQuota>(`${API_BASE}/servers/${serverId}/storage`, {
            headers: { Authorization: `Bearer ${token}` },
        }).then(res => ({ serverId, quota: res.data }), () => null); // display-only: a failure omits the meter
    }, [serverId, token]);

    /** Refetch now (after an upload or delete changed usage). */
    const refresh = useCallback(async () => {
        const next = await fetchQuota();
        if (next) setState(next);
    }, [fetchQuota]);

    useEffect(() => {
        let cancelled = false;
        void fetchQuota().then(next => { if (next && !cancelled) setState(next); });
        return () => { cancelled = true; };
    }, [fetchQuota, refreshKey]);

    const quota = state && token && state.serverId === serverId ? state.quota : null;
    return { quota, refresh };
}
