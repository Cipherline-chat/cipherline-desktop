import { useEffect, useState } from 'react';
import axios from 'axios';
import { apiUrl } from '../utils/apiPath';
import { readSteamActivity, type SteamActivity } from '../utils/integrations/api';

/**
 * The two extra reads behind the profile card, each cached for a minute per
 * user so re-opening a card paints at once:
 *
 *  - `useMutuals`: GET /v1/users/:id/mutuals - people who are friends with
 *    BOTH of you, and servers you are both in (the server computes it; it never
 *    sends anyone who is only their friend). Not fetched for your own card.
 *  - `useSteamCard`: GET /v1/users/:id/steam - the verified Steam block
 *    (persona name + avatar as a data: URI, so this device never talks to
 *    Steam). Only fetched when the profile says a verified link is visible.
 */

export interface MutualFriend { user_id: string; username: string; discriminator: number | null; avatar_url: string | null }
export interface MutualServer { server_id: string; name: string }
export interface Mutuals { friends: MutualFriend[]; servers: MutualServer[] }
export interface SteamCard {
    steam_id: string;
    persona_name: string | null;
    avatar: string | null;
    /** Level / recent games / now playing - only when the server has STEAM_WEB_API_KEY and the owner shows the Steam block. */
    activity?: SteamActivity | null;
}

const TTL_MS = 60_000;
type Entry<T> = { at: number; value: T };
const mutualsCache = new Map<string, Entry<Mutuals>>();
const steamCache = new Map<string, Entry<SteamCard | null>>();

const fresh = <T,>(m: Map<string, Entry<T>>, k: string): Entry<T> | undefined => {
    const e = m.get(k);
    return e && Date.now() - e.at < TTL_MS ? e : undefined;
};

/** Mutuals are only ever well-formed rows (the wire is untrusted). */
export function readMutuals(raw: unknown): Mutuals {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const friends = Array.isArray(r.friends) ? r.friends.filter((f): f is MutualFriend =>
        !!f && typeof f === 'object' && typeof (f as MutualFriend).user_id === 'string' && typeof (f as MutualFriend).username === 'string') : [];
    const servers = Array.isArray(r.servers) ? r.servers.filter((s): s is MutualServer =>
        !!s && typeof s === 'object' && typeof (s as MutualServer).server_id === 'string' && typeof (s as MutualServer).name === 'string') : [];
    return {
        friends: friends.map((f) => ({ user_id: f.user_id, username: f.username, discriminator: typeof f.discriminator === 'number' ? f.discriminator : null, avatar_url: typeof f.avatar_url === 'string' ? f.avatar_url : null })),
        servers: servers.map((s) => ({ server_id: s.server_id, name: s.name })),
    };
}

/** A steam card with only a data:image avatar and a SteamID64 (anything else is dropped). */
export function readSteamCard(raw: unknown): SteamCard | null {
    const r = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
    if (!r || typeof r.steam_id !== 'string' || !/^7656119\d{10}$/.test(r.steam_id)) return null;
    return {
        steam_id: r.steam_id,
        persona_name: typeof r.persona_name === 'string' && r.persona_name.trim() ? r.persona_name.slice(0, 64) : null,
        avatar: typeof r.avatar === 'string' && /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(r.avatar) ? r.avatar : null,
        activity: readSteamActivity(r.activity),
    };
}

export function useMutuals(userId: string | null, token: string | null): { data: Mutuals | null; loading: boolean } {
    const [state, setState] = useState<{ key: string | null; data: Mutuals | null; loading: boolean }>(() => {
        const hit = userId ? fresh(mutualsCache, userId) : undefined;
        return { key: userId, data: hit?.value ?? null, loading: !!userId && !hit };
    });
    useEffect(() => {
        if (!userId || !token) return;
        if (fresh(mutualsCache, userId)) return;
        let cancelled = false;
        axios.get(apiUrl`/users/${userId}/mutuals`, { headers: { Authorization: `Bearer ${token}` } })
            .then((res) => {
                const value = readMutuals(res.data);
                mutualsCache.set(userId, { at: Date.now(), value });
                if (!cancelled) setState({ key: userId, data: value, loading: false });
            })
            .catch(() => { if (!cancelled) setState({ key: userId, data: null, loading: false }); });
        return () => { cancelled = true; };
    }, [userId, token]);
    if (state.key !== userId) {
        const hit = userId ? fresh(mutualsCache, userId) : undefined;
        return { data: hit?.value ?? null, loading: !!userId && !hit };
    }
    return { data: state.data, loading: state.loading };
}

export function useSteamCard(userId: string | null, token: string | null): SteamCard | null {
    const [state, setState] = useState<{ key: string | null; data: SteamCard | null }>(() => ({
        key: userId, data: userId ? fresh(steamCache, userId)?.value ?? null : null,
    }));
    useEffect(() => {
        if (!userId || !token) return;
        if (fresh(steamCache, userId)) return;
        let cancelled = false;
        axios.get(apiUrl`/users/${userId}/steam`, { headers: { Authorization: `Bearer ${token}` } })
            .then((res) => {
                const value = readSteamCard(res.data);
                steamCache.set(userId, { at: Date.now(), value });
                if (!cancelled) setState({ key: userId, data: value });
            })
            .catch(() => { if (!cancelled) setState({ key: userId, data: null }); });
        return () => { cancelled = true; };
    }, [userId, token]);
    if (state.key !== userId) return userId ? fresh(steamCache, userId)?.value ?? null : null;
    return state.data;
}

/** After you link / unlink: forget your own cached card. */
export function forgetSteamCard(userId: string | null | undefined): void {
    if (userId) steamCache.delete(userId);
}
