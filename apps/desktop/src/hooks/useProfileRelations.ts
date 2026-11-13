import { useEffect, useReducer, useState } from 'react';
import axios from 'axios';
import { apiUrl } from '../utils/apiPath';
import { readSteamActivity, type SteamActivity } from '../utils/integrations/api';

/**
 * The two extra reads behind the profile card, each cached for a minute per
 * user so re-opening a card paints at once (the Steam card is also re-read
 * every minute while a surface stays open, and its now-playing line expires
 * after 90 s - see STEAM_NOW_PLAYING_MAX_AGE_MS):
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
    /** Level / recent games / now playing - only when the server has STEAM_WEB_API_KEY and the owner shows Steam stats. */
    activity?: SteamActivity | null;
    /** Your own card only: you have hidden your Steam stats (others get no activity). */
    statsHidden?: boolean;
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
        statsHidden: r.stats_hidden === true,
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

/**
 * HOW LONG A "PLAYING" LINE MAY OUTLIVE ITS FETCH. One number for every place
 * that shows Steam's now-playing (the profile's activity row, the Steam card's
 * "Playing now" line, the Settings preview): the card the hook hands out has
 * `nowPlaying` removed once its fetch is this old, so no surface can keep a
 * finished game on screen for minutes. The slow stats (level, hours, badges)
 * stay cached and keep painting while the card is re-read.
 */
export const STEAM_NOW_PLAYING_MAX_AGE_MS = 90_000;
/** A profile surface that stays open re-reads the card this often (the API caches Steam's answer for 60 s, so more often only re-reads the same data). */
export const STEAM_REFRESH_MS = 60_000;

/** The card with Steam's now-playing dropped when the fetch behind it is too old (else the same object). */
const stripped = new WeakMap<SteamCard, SteamCard>();
export function expireNowPlaying(card: SteamCard | null, fetchedAt: number, now: number = Date.now()): SteamCard | null {
    if (!card?.activity?.nowPlaying || now - fetchedAt < STEAM_NOW_PLAYING_MAX_AGE_MS) return card;
    let s = stripped.get(card);
    if (!s) {
        s = { ...card, activity: { ...card.activity, nowPlaying: null } };
        stripped.set(card, s);
    }
    return s;
}

// ---- the card store: one fetch per user for every open surface ----------------------------

const cardListeners = new Map<string, Set<() => void>>();
const cardInflight = new Map<string, Promise<void>>();
/** When each user's card was last ASKED for (a failed read does not move the cache, but must not be retried at once). */
const cardAttemptAt = new Map<string, number>();
const notifyCard = (userId: string) => { cardListeners.get(userId)?.forEach((f) => f()); };
const windowHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** The cached card and when it was fetched (test seam and the hook's read). */
export const peekSteamCard = (userId: string): Entry<SteamCard | null> | undefined => steamCache.get(userId);

/** Fetch the card now (shared by concurrent callers). A failed refresh keeps what was cached; a 404 means there is nothing to show. */
export function refreshSteamCard(userId: string, token: string): Promise<void> {
    const open = cardInflight.get(userId);
    if (open) return open;
    cardAttemptAt.set(userId, Date.now());
    const p = axios.get(apiUrl`/users/${userId}/steam`, { headers: { Authorization: `Bearer ${token}` } })
        .then((res) => { steamCache.set(userId, { at: Date.now(), value: readSteamCard(res.data) }); })
        .catch((e: unknown) => {
            const status = (e as { response?: { status?: number } })?.response?.status;
            if (status === 404) steamCache.set(userId, { at: Date.now(), value: null });
        })
        .finally(() => { cardInflight.delete(userId); notifyCard(userId); });
    cardInflight.set(userId, p);
    return p;
}

/**
 * Keep a user's card current while a surface is open: read it on open when it
 * is older than `STEAM_REFRESH_MS`, then again every `STEAM_REFRESH_MS`, and
 * not at all while the window is hidden (it catches up when shown again).
 * Nothing is polled for a user with no card (404). Returns the stop function.
 */
export function watchSteamCard(userId: string, token: string): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const schedule = () => {
        clear();
        if (stopped || windowHidden()) return;
        const e = steamCache.get(userId);
        if (e && e.value === null) return;
        const last = Math.max(e?.at ?? 0, cardAttemptAt.get(userId) ?? 0);
        const wait = last ? Math.max(0, last + STEAM_REFRESH_MS - Date.now()) : 0;
        timer = setTimeout(() => {
            timer = null;
            if (stopped || windowHidden()) return;
            void refreshSteamCard(userId, token).then(schedule);
        }, wait);
    };
    const onVisible = () => { if (!windowHidden()) schedule(); };
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisible);
    schedule();
    return () => {
        stopped = true;
        clear();
        if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisible);
    };
}

/**
 * The verified Steam card for `userId`, with when it was fetched. Steam's
 * now-playing in it is dropped once its fetch is older than
 * `STEAM_NOW_PLAYING_MAX_AGE_MS` (this hook re-renders at that moment).
 */
export function useSteamCardEntry(userId: string | null, token: string | null): { card: SteamCard | null; at: number } {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        if (!userId || !token) return;
        let set = cardListeners.get(userId);
        if (!set) cardListeners.set(userId, (set = new Set()));
        set.add(bump);
        const stop = watchSteamCard(userId, token);
        return () => { set!.delete(bump); if (!set!.size) cardListeners.delete(userId); stop(); };
    }, [userId, token]);
    const entry = userId ? steamCache.get(userId) : undefined;
    const showing = entry?.value?.activity?.nowPlaying ? entry : undefined;
    // Re-render the moment the "Playing" line expires.
    useEffect(() => {
        if (!showing) return;
        const wait = showing.at + STEAM_NOW_PLAYING_MAX_AGE_MS - Date.now();
        if (wait <= 0) return;
        const t = setTimeout(bump, wait + 50);
        return () => clearTimeout(t);
    }, [showing]);
    return entry ? { card: expireNowPlaying(entry.value, entry.at), at: entry.at } : { card: null, at: 0 };
}

export function useSteamCard(userId: string | null, token: string | null): SteamCard | null {
    return useSteamCardEntry(userId, token).card;
}

/**
 * The Steam stats a profile surface may draw from a card: none when there are
 * none, and none on your OWN profile while you hide them (your card still
 * carries them for the Settings preview; nobody else receives them at all).
 */
export function visibleSteamActivity(card: SteamCard | null, isSelf: boolean): SteamActivity | null {
    if (!card?.activity) return null;
    return isSelf && card.statsHidden ? null : card.activity;
}

/** After you link / unlink: forget your own cached card. */
export function forgetSteamCard(userId: string | null | undefined): void {
    if (userId) { steamCache.delete(userId); cardAttemptAt.delete(userId); notifyCard(userId); }
}
