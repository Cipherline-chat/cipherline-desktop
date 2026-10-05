import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { secureLocalStore } from '../utils/secureLocalStore';
import type { CallNamingSettings } from '@cipherline/shared';
import { isQuietRenameRefusal } from '../utils/callNaming';

/**
 * Local cache for the server list and each server's channels/categories.
 *
 * Unlike messages, none of this was cached at all — every launch re-fetched it,
 * and `GET /servers/:id/channels` is not cheap (it resolves permissions for
 * every channel). So the sidebar sat empty until the network round-trips
 * landed, on every single boot. These caches paint immediately and are
 * replaced by the network result when it arrives (stale-while-revalidate).
 *
 * Keyed with the userId INSIDE the key on purpose: secureLocalStore encrypts
 * per-account records under a per-user subkey derived from a userId found in
 * the key (see ownerFor). Without it these would land master-tier, readable by
 * any other account on the device — and which servers you're in is exactly the
 * social-graph metadata that's supposed to stay on-device and per-account.
 *
 * NOTE ON STALENESS: cached channels carry `my_permissions`, which can be out
 * of date for the moment before revalidation. That is safe by design — the
 * client's permission checks are UX-only mirrors and the server enforces every
 * gate independently (see CLAUDE.md). Never let anything load-bearing depend
 * on these values being fresh.
 */
const serversCacheKey = (userId: string) => `cipherline_servers_${userId}`;
const channelsCacheKey = (userId: string, serverId: string) =>
    `cipherline_srv_channels_${userId}_${serverId}`;

export interface ServerInfo {
    server_id: string;
    name: string;
    description: string | null;
    /** Encrypted attachment id; key+nonce are stored ALONGSIDE on the server
     *  (icons are public-by-design, see Server entity comment for the privacy
     *  rationale). Null when no icon has been uploaded. */
    icon_attachment: string | null;
    icon_key_b64: string | null;
    icon_nonce_b64: string | null;
    banner_attachment: string | null;
    banner_key_b64: string | null;
    banner_nonce_b64: string | null;
    owner_user_id: string;
    created_at: string;
    /** Server-wide default notification level set by an admin.
     *  'all' = all messages; 'mentions' = @mentions only.
     *  Defaults to 'all' if absent (older API). */
    default_notification_level?: 'all' | 'mentions';
    /** Channel where system events (join/leave/kick/ban) are posted.
     *  Null or absent = system messages disabled. */
    system_channel_id?: string | null;
    /** LEGACY. Used to mark a server in a 60-day lapsed-owner deletion grace
     *  period. That policy was retired 2026-10-04 (every plan may own servers);
     *  the API now always sends null and nothing renders it. */
    owner_lapsed_at?: string | null;
}

export interface ChannelInfo {
    channel_id: string;
    server_id: string;
    kind: 'text' | 'voice' | 'huddle';
    name: string;
    /** Description / topic, plaintext metadata. */
    topic: string | null;
    /** Optional emoji rendered before the channel name (legacy). */
    icon_emoji: string | null;
    /** Lucide-icon identifier (preferred when set). */
    icon_name: string | null;
    position: number;
    /** Category the channel is grouped under in the sidebar — null = uncategorized. */
    parent_category_id: string | null;
    active_call_session_id: string | null;
    /** Max participants allowed across all active calls under this Huddle. Null = unlimited. */
    member_limit: number | null;
    /** Max concurrent active calls under this Huddle. Null = unlimited. */
    max_calls: number | null;
    /** Calls channels only: the "Call names" setting (always a full object
     *  from a current API; absent from an older one — read it through
     *  `callNamingOf`, which fills the defaults). */
    call_naming?: CallNamingSettings;
    /** Resolved effective permissions for the current user in this channel.
     *  Serialised as a decimal BigInt string by the API — parse with BigInt(ch.my_permissions).
     *  Present only for server channels; undefined for locally-constructed channel objects. */
    my_permissions?: string;
    /** Highest registered Sender-Key epoch for this (text) channel — 0 means
     *  no one has ever minted a key for it yet; undefined for non-API-sourced
     *  channel objects. Drives the mint-vs-wait decision in Dashboard's
     *  channel-key bootstrap (src/utils/channelKeyDistribution.ts). */
    latest_epoch?: number;
}

export interface CategoryInfo {
    category_id: string;
    server_id: string;
    name: string;
    position: number;
    /** 'text' = left sidebar panel; 'huddle' = right context panel. */
    kind: 'text' | 'huddle';
    /** Lucide icon identifier for the category header. Null = kind default. */
    icon_name: string | null;
}

/**
 * One active call under a Huddle (server channel of kind='huddle').
 * Lifetime: spawned on click, destroyed when the last participant leaves.
 * `participants` is a live mirror of the server's per-call presence.
 */
export interface HuddleCallInfo {
    call_id: string;
    huddle_id: string;
    name: string;
    spawner_user_id: string;
    spawned_at: string;
    participants: string[];
}

export interface ServerMemberInfo {
    user_id: string;
    nickname: string | null;
    joined_at: string;
}

export function useServers(token: string | null, userId?: string | null) {
    const [servers, setServers] = useState<ServerInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [serversError, setServersError] = useState<string | null>(null);
    const [channels, setChannels] = useState<Record<string, ChannelInfo[]>>({});
    // P2-REND-18: per-server loading flag so fast switching between servers
    // doesn't clear the flag while a request for the new server is in flight.
    const [channelsLoading, setChannelsLoading] = useState<Record<string, boolean>>({});
    const [categories, setCategories] = useState<Record<string, CategoryInfo[]>>({});
    /** Active Huddle calls keyed by huddle (channel) id. Updated reactively
     *  via the four `huddle:*` WS events; see useRealtime. */
    const [huddleCalls, setHuddleCalls] = useState<Record<string, HuddleCallInfo[]>>({});
    /**
     * Resolved server-level permission bitfield for the calling user, keyed
     * by server_id. Fetched from `GET /v1/servers/:id/me/permissions`.
     * Use with `hasPermission` from `@cipherline/shared` — do NOT hardcode
     * owner checks on the frontend; use this instead.
     */
    const [myPermissions, setMyPermissions] = useState<Record<string, bigint>>({});

    const loadServers = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setServersError(null);
        try {
            const res = await axios.get(`${API_BASE}/servers`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const fetched = res.data ?? [];
            setServers(fetched);
            if (userId) {
                try {
                    secureLocalStore.setItem(serversCacheKey(userId), JSON.stringify(fetched));
                } catch { /* quota — cache is an optimisation, never required */ }
            }
        } catch (err: any) {
            console.error('[useServers] Failed to load servers:', err);
            // P2-REND-18: surface error so callers can show a retry prompt.
            setServersError(err?.message ?? 'Failed to load servers');
        } finally {
            setLoading(false);
        }
    }, [token, userId]);

    /**
     * Paint the server list from cache the moment a userId is known, so the
     * rail isn't empty while the network fetch above is in flight. Never
     * clobbers a result that already landed — if `servers` is non-empty the
     * fresh data won the race and the cache is stale by definition.
     */
    useEffect(() => {
        if (!userId) return;
        try {
            const cached = secureLocalStore.getItem(serversCacheKey(userId));
            if (!cached) return;
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > 0) {
                setServers(prev => (prev.length > 0 ? prev : parsed));
            }
        } catch { /* corrupt cache — the network fetch is the source of truth */ }
    }, [userId]);

    /**
     * Fetch the calling user's resolved server-level permissions and cache
     * them in `myPermissions[serverId]`. Called when a server is selected.
     * Non-fatal: a failure leaves the previous value (or 0n if first load).
     */
    const loadMyPermissions = useCallback(async (serverId: string) => {
        if (!token) return;
        try {
            const res = await axios.get(`${API_BASE}/servers/${serverId}/me/permissions`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const bits = BigInt(res.data?.permissions ?? '0');
            setMyPermissions(prev => ({ ...prev, [serverId]: bits }));
        } catch (err) {
            console.error('[useServers] Failed to load permissions for', serverId, err);
        }
    }, [token]);

    const loadChannels = useCallback(async (serverId: string): Promise<ChannelInfo[] | null> => {
        if (!token) return null;
        // Paint this server's channels from cache first so opening a server is
        // instant instead of waiting on a permission-resolving round-trip.
        // Only fills a gap — never overwrites a list already in state, which
        // would be fresher than the cache by definition.
        if (userId) {
            try {
                const cached = secureLocalStore.getItem(channelsCacheKey(userId, serverId));
                if (cached) {
                    const parsed = JSON.parse(cached);
                    if (Array.isArray(parsed?.channels)) {
                        setChannels(prev => (prev[serverId] ? prev : { ...prev, [serverId]: parsed.channels }));
                        setCategories(prev => (prev[serverId] ? prev : { ...prev, [serverId]: parsed.categories ?? [] }));
                    }
                }
            } catch { /* corrupt cache — the fetch below is the source of truth */ }
        }
        // P2-REND-18: flag per serverId to avoid clearing another server's spinner.
        setChannelsLoading(prev => ({ ...prev, [serverId]: true }));
        try {
            // Load channels, categories, and own permissions in parallel.
            const [chRes, catRes] = await Promise.all([
                axios.get(`${API_BASE}/servers/${serverId}/channels`, {
                    headers: { Authorization: `Bearer ${token}` },
                }),
                axios.get(`${API_BASE}/servers/${serverId}/categories`, {
                    headers: { Authorization: `Bearer ${token}` },
                }).catch(() => ({ data: [] })), // tolerate older API instances
                loadMyPermissions(serverId),     // fire-and-forget into myPermissions
            ]);
            const fetchedChannels: ChannelInfo[] = chRes.data ?? [];
            const fetchedCategories: CategoryInfo[] = catRes.data ?? [];
            setChannels(prev => ({ ...prev, [serverId]: fetchedChannels }));
            setCategories(prev => ({ ...prev, [serverId]: fetchedCategories }));
            if (userId) {
                try {
                    secureLocalStore.setItem(
                        channelsCacheKey(userId, serverId),
                        JSON.stringify({ channels: fetchedChannels, categories: fetchedCategories }),
                    );
                } catch { /* quota — cache is an optimisation, never required */ }
            }
            // Callers that need to act on the fresh list immediately (e.g.
            // minting keys for a just-created server's channels) would
            // otherwise have to wait a render for the `channels` state to
            // reflect this — returning it directly avoids that race.
            return fetchedChannels;
        } catch (err) {
            console.error('[useServers] Failed to load channels for', serverId, err);
            return null;
        } finally {
            setChannelsLoading(prev => ({ ...prev, [serverId]: false }));
        }
    }, [token, userId, loadMyPermissions]);

    /**
     * Pull the live list of calls under one Huddle. Called when the user
     * opens a server (any `kind='huddle'` channel found prompts a fetch)
     * and when the user navigates between servers. The fetch is best-effort:
     * a 404 / 403 just leaves the bucket empty.
     */
    const loadHuddleCalls = useCallback(async (huddleId: string) => {
        if (!token) return;
        try {
            const res = await axios.get(`${API_BASE}/huddles/${huddleId}/calls`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setHuddleCalls(prev => ({ ...prev, [huddleId]: res.data ?? [] }));
        } catch (err) {
            // Non-fatal; clear stale entries.
            setHuddleCalls(prev => ({ ...prev, [huddleId]: [] }));
        }
    }, [token]);

    /**
     * Replace the whole huddle-call map from the cross-server presence seed
     * (`GET /v1/voice-participants`).
     *
     * REPLACE, not merge — same reasoning as `setVoiceParticipants` in
     * Dashboard's `seedVoicePresence`: a call that ended since the last seed
     * must lose its entry, and a merge would strand it forever. The snapshot is
     * authoritative across every server the caller can see, so there is nothing
     * a merge would preserve that is still true.
     *
     * The one thing the snapshot deliberately drops is a call with zero
     * participants. Those are transient by construction (`leaveCall` destroys a
     * call the moment its last participant leaves) and an empty call is not
     * presence — it must not badge the rail or fill the Home deck.
     */
    const applyHuddleCallsSnapshot = useCallback((next: Record<string, HuddleCallInfo[]>) => {
        setHuddleCalls(next);
    }, []);

    /**
     * Apply a `huddle:call_spawned` WS event to local state. Idempotent —
     * if the call_id already exists in the bucket the spawn is dropped.
     */
    const applyHuddleSpawn = useCallback((huddleId: string, call: Omit<HuddleCallInfo, 'huddle_id' | 'participants'>) => {
        setHuddleCalls(prev => {
            const bucket = prev[huddleId] ?? [];
            if (bucket.some(c => c.call_id === call.call_id)) return prev;
            const next = [...bucket, { ...call, huddle_id: huddleId, participants: [call.spawner_user_id] }];
            return { ...prev, [huddleId]: next };
        });
    }, []);

    /** Apply a `huddle:call_destroyed` WS event. */
    const applyHuddleDestroy = useCallback((huddleId: string, callId: string) => {
        setHuddleCalls(prev => {
            const bucket = prev[huddleId];
            if (!bucket) return prev;
            const next = bucket.filter(c => c.call_id !== callId);
            return { ...prev, [huddleId]: next };
        });
    }, []);

    /** Apply a `huddle:call_renamed` WS event. */
    const applyHuddleRename = useCallback((huddleId: string, callId: string, name: string) => {
        setHuddleCalls(prev => {
            const bucket = prev[huddleId];
            if (!bucket) return prev;
            const next = bucket.map(c => c.call_id === callId ? { ...c, name } : c);
            return { ...prev, [huddleId]: next };
        });
    }, []);

    /** Apply a `huddle:participant` WS event (join or leave). */
    const applyHuddleParticipant = useCallback((
        huddleId: string,
        callId: string,
        userId: string,
        action: 'join' | 'leave',
    ) => {
        setHuddleCalls(prev => {
            const bucket = prev[huddleId];
            if (!bucket) return prev;
            const next = bucket.map(c => {
                if (c.call_id !== callId) return c;
                const set = new Set(c.participants);
                if (action === 'join') set.add(userId); else set.delete(userId);
                return { ...c, participants: Array.from(set) };
            });
            return { ...prev, [huddleId]: next };
        });
    }, []);

    /** POST a spawn-call request. Returns LiveKit connection details on success. */
    const spawnHuddleCall = useCallback(async (huddleId: string) => {
        if (!token) return null;
        const res = await axios.post(
            `${API_BASE}/huddles/${huddleId}/calls`,
            {},
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
        );
        return res.data as {
            call_id: string;
            huddle_id: string;
            server_id: string;
            name: string;
            spawner_user_id: string;
            spawned_at: string;
            livekit_token: string;
            livekit_url: string;
            e2ee_key_b64: string;
        };
    }, [token]);

    /** POST a join-call request for an existing call. */
    const joinHuddleCall = useCallback(async (callId: string) => {
        if (!token) return null;
        const res = await axios.post(
            `${API_BASE}/huddles/calls/${callId}/join`,
            {},
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
        );
        return res.data as {
            call_id: string;
            huddle_id: string;
            livekit_token: string;
            livekit_url: string;
            e2ee_key_b64: string;
        };
    }, [token]);

    /** Force-move another member into an existing call (needs MOVE_MEMBERS).
     *  The server derives the source call itself — we only say who and where
     *  to. Throws on rejection so the caller can roll back its optimistic
     *  update and surface the server's message. */
    const moveMemberToCall = useCallback(async (callId: string, userId: string) => {
        if (!token) return null;
        const res = await axios.post(
            `${API_BASE}/huddles/calls/${callId}/move`,
            { user_id: userId },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
        );
        return res.data as { ok: true; call_id: string; source_call_id: string };
    }, [token]);

    /** Force-move a member into a Calls channel with no active call — the
     *  server spawns one first. */
    const moveMemberToNewCall = useCallback(async (huddleId: string, userId: string) => {
        if (!token) return null;
        const res = await axios.post(
            `${API_BASE}/huddles/${huddleId}/move`,
            { user_id: userId },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
        );
        return res.data as { ok: true; call_id: string; source_call_id: string };
    }, [token]);

    /** POST a leave-call request. */
    const leaveHuddleCall = useCallback(async (callId: string) => {
        if (!token) return;
        try {
            const res = await axios.post(
                `${API_BASE}/huddles/calls/${callId}/leave`,
                {},
                { headers: { Authorization: `Bearer ${token}` } },
            );
            // Eagerly remove the call card when the server confirms it was
            // destroyed (last participant left). The WS event will also come
            // in and be a no-op since the call is already gone from state.
            const { destroyed } = (res.data ?? {}) as { destroyed?: boolean };
            if (destroyed) {
                setHuddleCalls(prev => {
                    const next = { ...prev };
                    for (const huddleId of Object.keys(next)) {
                        const bucket = next[huddleId];
                        if (bucket.some(c => c.call_id === callId)) {
                            next[huddleId] = bucket.filter(c => c.call_id !== callId);
                        }
                    }
                    return next;
                });
            }
        } catch { /* non-fatal */ }
    }, [token]);

    /** PATCH a rename. */
    const renameHuddleCall = useCallback(async (callId: string, name: string) => {
        if (!token) return;
        try {
            await axios.patch(
                `${API_BASE}/huddles/calls/${callId}`,
                { name },
                { headers: { Authorization: `Bearer ${token}` } },
            );
        } catch (err) {
            // The channel's "Call names" setting refused it (names locked, or
            // only managers may rename) — the menu offered Rename from a
            // stale copy of the setting. A quiet no-op, not an error.
            if (isQuietRenameRefusal(err)) return;
            throw err;
        }
    }, [token]);

    const reloadCategories = useCallback(async (serverId: string) => {
        if (!token) return;
        try {
            const res = await axios.get(`${API_BASE}/servers/${serverId}/categories`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setCategories(prev => ({ ...prev, [serverId]: res.data ?? [] }));
        } catch (err) {
            console.error('[useServers] Failed to reload categories for', serverId, err);
        }
    }, [token]);

    const createServer = useCallback(async (name: string): Promise<ServerInfo | null> => {
        if (!token) return null;
        try {
            const res = await axios.post(
                `${API_BASE}/servers`,
                { name },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            const server = res.data as ServerInfo;
            // Reload the full list so the nav rail gets the canonical shape from
            // the DB (avoids undefined fields if the API response changes shape).
            await loadServers();
            return server;
        } catch (err) {
            console.error('[useServers] createServer failed:', err);
            throw err;
        }
    }, [token, loadServers]);

    const joinServer = useCallback(async (code: string): Promise<{ server_id: string } | null> => {
        if (!token) return null;
        try {
            const res = await axios.post(
                `${API_BASE}/invites/${code}/accept`,
                {},
                { headers: { Authorization: `Bearer ${token}` } },
            );
            // Reload servers list so the new server appears in the rail
            await loadServers();
            return res.data;
        } catch (err) {
            console.error('[useServers] joinServer failed:', err);
            throw err;
        }
    }, [token, loadServers]);

    // Load servers list on mount / token change
    useEffect(() => {
        loadServers();
    }, [loadServers]);

    return {
        servers,
        loading,
        serversError,
        channels,
        channelsLoading,
        categories,
        huddleCalls,
        myPermissions,
        loadServers,
        loadChannels,
        loadMyPermissions,
        reloadCategories,
        loadHuddleCalls,
        applyHuddleCallsSnapshot,
        applyHuddleSpawn,
        applyHuddleDestroy,
        applyHuddleRename,
        applyHuddleParticipant,
        spawnHuddleCall,
        joinHuddleCall,
        leaveHuddleCall,
        moveMemberToCall,
        moveMemberToNewCall,
        renameHuddleCall,
        createServer,
        joinServer,
    };
}
