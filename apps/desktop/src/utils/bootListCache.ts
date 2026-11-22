/**
 * Last session's conversation and friend lists, so a cold start can open the
 * app at once and refresh them behind it (owner 2026-11-19: "make it load a
 * little faster"). Servers already have the same cache (useServers.ts).
 *
 * Encrypted at rest like every other key (secureLocalStore), per account, and
 * EXCLUDED from backups (backupRegistry.ts): it is a cache the server rebuilds,
 * and the social graph stays on this device. A cache that is missing, corrupt,
 * oversized or for another account reads as nothing; the network fetch is
 * always the source of truth and overwrites it.
 */
import { secureLocalStore } from './secureLocalStore';
import { parseFriendsPayload, type FriendsPayload } from './friendsSync';

const convKey = (userId: string) => `cipherline_conv_cache_${userId}`;
const friendsKey = (userId: string) => `cipherline_friends_cache_${userId}`;
/** Bigger than any real list; past it the cache is skipped, not truncated. */
export const MAX_CACHE_CHARS = 2_000_000;

function read(key: string): unknown {
    try {
        const raw = secureLocalStore.getItem(key);
        if (!raw || raw.length > MAX_CACHE_CHARS) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
function write(key: string, value: unknown): void {
    try {
        const s = JSON.stringify(value);
        if (s.length <= MAX_CACHE_CHARS) secureLocalStore.setItem(key, s);
    } catch { /* store locked / full: next start just waits for the network */ }
}

/** The cached conversation list (an array of conversation rows), or null. */
export function readCachedConversations(userId: string | null | undefined): unknown[] | null {
    if (!userId) return null;
    const v = read(convKey(userId));
    return Array.isArray(v) ? v : null;
}
export function cacheConversations(userId: string | null | undefined, rows: unknown): void {
    if (userId && Array.isArray(rows)) write(convKey(userId), rows);
}

/** The cached friends payload, validated like a fresh one, or null. */
export function readCachedFriends(userId: string | null | undefined): FriendsPayload | null {
    if (!userId) return null;
    const v = read(friendsKey(userId));
    return v === null ? null : parseFriendsPayload(v);
}
export function cacheFriends(userId: string | null | undefined, payload: FriendsPayload): void {
    if (userId) write(friendsKey(userId), payload);
}
