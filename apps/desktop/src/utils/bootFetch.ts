/**
 * Start the three core loads (conversations, friends, servers) the moment the
 * stored session is restored, instead of when the Dashboard's effects run
 * after its first render (owner 2026-11-19: "make it load a little faster").
 *
 * The Dashboard's own fetchers are unchanged except that their FIRST call
 * takes the request already in flight (same URL, same token) instead of
 * opening a second one. Each boot request is used at most once, only for the
 * token it was made with, and only while fresh; if it failed, the caller falls
 * back to its usual fetch-with-retry, so behaviour on error is exactly as before.
 */
import axios, { type AxiosResponse } from 'axios';
import { API_BASE } from '../constants';

export type BootLoad = 'conversations' | 'friends' | 'servers';
/** Literal URLs, exactly as the Dashboard's own fetchers write them (no ids). */
const URLS: Record<BootLoad, () => string> = {
    conversations: () => `${API_BASE}/conversations`,
    friends: () => `${API_BASE}/friends`,
    servers: () => `${API_BASE}/servers`,
};
/** A boot response older than this is not reused (a later call wants fresh data). */
export const BOOT_FETCH_MAX_AGE_MS = 15_000;

interface Pending { token: string; at: number; p: Promise<AxiosResponse> }
const pending = new Map<BootLoad, Pending>();

/** Fire all three now. Safe to call more than once: one set per token. */
export function startBootFetches(token: string | null | undefined, now: () => number = Date.now): void {
    if (!token) return;
    for (const load of Object.keys(URLS) as BootLoad[]) {
        if (pending.get(load)?.token === token) continue;
        const p = axios.get(URLS[load](), { headers: { Authorization: `Bearer ${token}` } });
        p.catch(() => { /* consumed (or dropped) below; never an unhandled rejection */ });
        pending.set(load, { token, at: now(), p });
    }
}

/**
 * The boot request for `load` if one is fresh and was made with `token`, else
 * `fallback()`. A failed boot request also falls back. One use each.
 */
export function takeBootFetch<T extends AxiosResponse>(load: BootLoad, token: string | null | undefined, fallback: () => Promise<T>, now: () => number = Date.now): Promise<T> {
    const b = pending.get(load);
    pending.delete(load);
    if (!b || !token || b.token !== token || now() - b.at > BOOT_FETCH_MAX_AGE_MS) return fallback();
    return (b.p as Promise<T>).catch(() => fallback());
}

/** Test hook. */
export function __resetBootFetches(): void {
    pending.clear();
}
