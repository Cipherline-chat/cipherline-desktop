/**
 * A friend's END-TO-END ENCRYPTED Spotify cover, on the VIEWER's device.
 *
 * Profile views only (preview popover, DM profile panel, full profile - all
 * through hooks/useIntegrationActivity.ts): status lines and friends lists
 * never call this, so opening the app or scrolling a list fetches nothing.
 *
 * GET /v1/friends/:id/listening/cover?id=<cover_id> returns ciphertext (the
 * server serves it only to the sharer's accepted friends, only for the id on
 * their current record); it is decrypted here with the key that friend
 * delivered to this device end to end (activityKeys.ts), checked to be a
 * JPEG / PNG / WebP, and shown through a `blob:` URL. No key yet (not
 * delivered, or rotated away because you are no longer friends), a 404, or
 * anything that does not authenticate -> null, and the caller shows the
 * catalogue cover / the platform logo instead. When a key arrives later the
 * cover is tried again.
 *
 * One fetch per (friend, cover id) per session; LRU-capped, object URLs
 * revoked on eviction and on sign-out. The decrypted bytes are kept (bounded)
 * only so a report can attach them as evidence (coverReport.ts).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { apiUrl } from '../apiPath';
import { decryptCover, isCoverId, type DecryptedCover } from './activityCover';
import { activityKeysVersion, friendActivityKey, subscribeActivityKeys } from './activityKeys';

const MAX = 24;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FriendCover extends DecryptedCover { url: string }

type Entry =
    | { state: 'ok'; cover: FriendCover }
    | { state: 'gone' } // 404: not a friend any more / track changed - not asked again this session
    | { state: 'nokey'; ciphertext: Uint8Array; keysAt: number };

let session: { token: string; userId: string } | null = null;
const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const subs = new Set<() => void>();
let snapshotVersion = 0;

function emit() { snapshotVersion += 1; for (const s of subs) s(); }
const keyOf = (userId: string, coverId: string) => `${userId}:${coverId}`;

function revoke(e: Entry | undefined) {
    if (e?.state === 'ok') { try { URL.revokeObjectURL(e.cover.url); } catch { /* not a blob URL */ } }
}

function remember(k: string, e: Entry) {
    revoke(entries.get(k));
    entries.delete(k);
    entries.set(k, e);
    while (entries.size > MAX) {
        const oldest = entries.keys().next().value as string;
        revoke(entries.get(oldest));
        entries.delete(oldest);
    }
    emit();
}

/** Set by useActivityKeyShare (mounted once, in Dashboard); a change of account forgets everything. */
export function setFriendCoverSession(s: { token: string; userId: string } | null): void {
    if (s?.token === session?.token && s?.userId === session?.userId) return;
    session = s;
    for (const e of entries.values()) revoke(e);
    entries.clear();
    inflight.clear();
    emit();
}

async function decryptInto(k: string, sharerId: string, coverId: string, ciphertext: Uint8Array, viewerId: string): Promise<void> {
    const cover = await decryptCover({
        sharerUserId: sharerId, coverId, blob: ciphertext,
        keyFor: kid => friendActivityKey(viewerId, sharerId, kid),
    });
    if (session?.userId !== viewerId) return;
    if (cover) {
        const url = URL.createObjectURL(new Blob([cover.bytes as BlobPart], { type: cover.type }));
        remember(k, { state: 'ok', cover: { ...cover, url } });
    } else {
        // Kept so a key that lands later decrypts without a second download.
        remember(k, { state: 'nokey', ciphertext, keysAt: activityKeysVersion() });
    }
}

/** Fetch + decrypt `sharerId`'s cover `coverId`. Never throws; the result lands in the store. */
export function loadFriendCover(sharerId: string, coverId: string): Promise<void> {
    const s = session;
    if (!s || !UUID_RE.test(sharerId) || !isCoverId(coverId) || sharerId === s.userId) return Promise.resolve();
    const k = keyOf(sharerId, coverId);
    const have = entries.get(k);
    if (have?.state === 'ok' || have?.state === 'gone') return Promise.resolve();
    if (have?.state === 'nokey' && have.keysAt === activityKeysVersion()) return Promise.resolve();
    let p = inflight.get(k);
    if (!p) {
        p = (async () => {
            if (have?.state === 'nokey') { await decryptInto(k, sharerId, coverId, have.ciphertext, s.userId); return; }
            try {
                const { default: axios } = await import('axios');
                const res = await axios.get<ArrayBuffer>(apiUrl`/friends/${sharerId}/listening/cover`, {
                    headers: { Authorization: `Bearer ${s.token}` }, params: { id: coverId }, responseType: 'arraybuffer', timeout: 10_000,
                });
                if (session !== s) return;
                await decryptInto(k, sharerId, coverId, new Uint8Array(res.data), s.userId);
            } catch (e) {
                if ((e as { response?: { status?: number } })?.response?.status === 404 && session === s) remember(k, { state: 'gone' });
            }
        })().catch(() => undefined).finally(() => inflight.delete(k));
        inflight.set(k, p);
    }
    return p;
}

/** The decrypted cover (url + bytes) when this device holds it, else null. */
export function peekFriendCover(sharerId: string, coverId: string): FriendCover | null {
    const e = entries.get(keyOf(sharerId, coverId));
    return e?.state === 'ok' ? e.cover : null;
}

/**
 * A friend's end-to-end encrypted Spotify cover for a PROFILE VIEW, or null
 * (none / loading / no key / not a friend). Re-tries when a key arrives.
 */
export function useFriendCover(sharerId: string | null | undefined, coverId: string | null | undefined): FriendCover | null {
    const want = sharerId && coverId && isCoverId(coverId) ? keyOf(sharerId, coverId) : null;
    const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
    const cover = useSyncExternalStore(subscribe, () => {
        const e = want ? entries.get(want) : undefined;
        return e?.state === 'ok' ? e.cover : null;
    }, () => null);
    const authed = useSyncExternalStore(subscribe, () => session !== null, () => false);
    const keys = useSyncExternalStore(subscribeActivityKeys, activityKeysVersion, () => 0);
    useEffect(() => {
        if (want && sharerId && coverId && authed) void loadFriendCover(sharerId, coverId);
    }, [want, sharerId, coverId, authed, keys]);
    return cover;
}

/** Test seams. */
export function __resetFriendCovers(): void { setFriendCoverSession(null); }
export const __friendCoverVersion = (): number => snapshotVersion;
