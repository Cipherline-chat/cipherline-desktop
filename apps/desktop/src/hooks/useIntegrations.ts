import { useEffect, useState, useSyncExternalStore } from 'react';
import axios from 'axios';
import { apiUrl } from '../utils/apiPath';
import { API_BASE } from '../constants';
import {
    isArtRef, readMyIntegrations, readSpotifyItems, type MyIntegrations, type SpotifyItem,
} from '../utils/integrations/api';

/**
 * Integrations reads, each cached in memory for the session:
 *  - useArt(ref): a third-party image by art ref, fetched THROUGH our API
 *    (GET /v1/integrations/art) as a data: URI - this device never talks to
 *    Steam's or Spotify's CDN. One request per ref per session (LRU-capped).
 *  - useUserIntegrations(userId): someone's Spotify showcase
 *    (GET /v1/users/:id/integrations, 404 = nothing to show), 60 s.
 *  - useMyIntegrations(): what this deployment offers + your own showcase.
 */

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

// ── Art ─────────────────────────────────────────────────────────────────────

const ART_MAX = 200;
const art = new Map<string, string | null>();
const artInflight = new Map<string, Promise<string | null>>();
const artSubs = new Set<() => void>();

function rememberArt(ref: string, v: string | null) {
    art.delete(ref);
    art.set(ref, v);
    while (art.size > ART_MAX) art.delete(art.keys().next().value as string);
    for (const s of artSubs) s();
}

export function fetchArt(ref: string, token: string): Promise<string | null> {
    if (art.has(ref)) return Promise.resolve(art.get(ref) ?? null);
    let p = artInflight.get(ref);
    if (!p) {
        p = axios.get(`${API_BASE}/integrations/art`, { ...auth(token), params: { ref } })
            .then((res) => {
                const d = res.data?.data;
                return typeof d === 'string' && /^data:image\/(jpeg|png|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(d) ? d : null;
            })
            // A 404 (no such image) is remembered; anything else is retried next time.
            .then((v) => { rememberArt(ref, v); return v; }, (e) => { if (e?.response?.status === 404) rememberArt(ref, null); return null; })
            .finally(() => artInflight.delete(ref));
        artInflight.set(ref, p);
    }
    return p;
}

/**
 * The image for the first ref that has one (refs are tried in order: e.g. a
 * capsule, then the small icon). `undefined` while loading, null = none.
 */
export function useArt(refs: ReadonlyArray<string | null | undefined> | string | null | undefined, token: string | null): string | null | undefined {
    const list = (Array.isArray(refs) ? refs : [refs]).filter(isArtRef);
    const key = list.join('|');
    const snap = useSyncExternalStore(
        (cb) => { artSubs.add(cb); return () => { artSubs.delete(cb); }; },
        () => {
            for (const r of list) {
                if (!art.has(r)) return undefined;
                const v = art.get(r);
                if (v) return v;
            }
            return null;
        },
    );
    useEffect(() => {
        if (!token || list.length === 0) return;
        let cancelled = false;
        (async () => {
            for (const r of list) {
                if (cancelled) return;
                const v = await fetchArt(r, token);
                if (v) return;
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the list's identity
    }, [key, token]);
    return list.length === 0 ? null : snap;
}

// ── Someone's showcase ──────────────────────────────────────────────────────

const TTL_MS = 60_000;
const userCache = new Map<string, { at: number; value: SpotifyItem[] }>();
const userSubs = new Set<() => void>();

/** Synchronous peek (for "does this profile have an Integrations tab"): undefined = not fetched yet. */
export function peekUserIntegrations(userId: string): SpotifyItem[] | undefined {
    const e = userCache.get(userId);
    return e && Date.now() - e.at < TTL_MS ? e.value : undefined;
}

/**
 * Whether a profile's integration panels may have content before they render
 * (the Integrations tab's visibility): a verified Steam account (its showcase
 * may exist), or a Spotify showcase already fetched for them.
 */
export function hasIntegrationPanels(profile: { user_id: string; steam?: { steam_id: string } | null } | null | undefined): boolean {
    if (!profile) return false;
    return !!profile.steam?.steam_id || (peekUserIntegrations(profile.user_id)?.length ?? 0) > 0;
}

export function forgetUserIntegrations(userId: string | null | undefined): void {
    if (userId) { userCache.delete(userId); for (const s of userSubs) s(); }
}

export function useUserIntegrations(userId: string | null, token: string | null): { spotify: SpotifyItem[]; loading: boolean } {
    const [, bump] = useState(0);
    useEffect(() => {
        const s = () => bump((n) => n + 1);
        userSubs.add(s);
        return () => { userSubs.delete(s); };
    }, []);
    useEffect(() => {
        if (!userId || !token || peekUserIntegrations(userId)) return;
        let cancelled = false;
        axios.get(apiUrl`/users/${userId}/integrations`, auth(token))
            .then((res) => readSpotifyItems(res.data?.spotify), () => [] as SpotifyItem[])
            .then((value) => {
                userCache.set(userId, { at: Date.now(), value });
                if (!cancelled) for (const s of userSubs) s();
            });
        return () => { cancelled = true; };
    }, [userId, token]);
    const hit = userId ? peekUserIntegrations(userId) : undefined;
    return { spotify: hit ?? [], loading: !!userId && hit === undefined };
}

// ── Yours ───────────────────────────────────────────────────────────────────

export function useMyIntegrations(token: string | null): {
    data: MyIntegrations | null; error: boolean; reload: () => void; setSpotify: (items: SpotifyItem[]) => void;
} {
    const [data, setData] = useState<MyIntegrations | null>(null);
    const [error, setError] = useState(false);
    const [n, setN] = useState(0);
    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        axios.get(`${API_BASE}/integrations/me`, auth(token))
            .then((res) => { if (!cancelled) { setData(readMyIntegrations(res.data)); setError(false); } })
            .catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [token, n]);
    return {
        data, error,
        reload: () => setN((x) => x + 1),
        setSpotify: (items) => setData((d) => (d ? { ...d, spotify: items } : d)),
    };
}
