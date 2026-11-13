/**
 * Friends' album covers for "Listening to" rows - in PROFILE views only (the
 * profile popover, the DM panel card, the full profile: useIntegrationActivity).
 * List surfaces (status lines, the Friends activity panel) show the platform's
 * logo and never call this, so a member list never fetches a cover per row.
 *
 * The record a friend's status carries has an opaque `artRef` the SERVER
 * chose (apps/api/src/integrations/listening-art.ts); the bytes come from
 * GET /v1/friends/:id/listening/art?ref=..., i.e. through our API, so this
 * device never contacts Spotify or archive.org. The answer is image bytes
 * (JPEG / PNG / WebP, sniffed again here) shown through a `blob:` URL that
 * safeImageSrc accepts; anything else, a 404 or a network error is "no
 * cover" (the music note).
 *
 * One request per ref per session (LRU-capped, object URLs revoked on
 * eviction and on sign-out). The bearer token is handed in by the publisher
 * hook (useListeningShare) so the profile views need no auth plumbing of
 * their own.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { apiUrl } from '../apiPath';
import { isListenArtRef } from './listening';

const MAX = 60;
let token: string | null = null;
const urls = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
const subs = new Set<() => void>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emit() { for (const s of subs) s(); }

function revoke(u: string | null | undefined) {
    if (u) { try { URL.revokeObjectURL(u); } catch { /* not a blob URL */ } }
}

function remember(ref: string, url: string | null) {
    if (urls.has(ref)) revoke(urls.get(ref));
    urls.delete(ref);
    urls.set(ref, url);
    while (urls.size > MAX) {
        const oldest = urls.keys().next().value as string;
        revoke(urls.get(oldest));
        urls.delete(oldest);
    }
    emit();
}

/** Set by useListeningShare; a change of account forgets every cover. */
export function setListeningArtToken(t: string | null): void {
    if (t === token) return;
    token = t;
    for (const u of urls.values()) revoke(u);
    urls.clear();
    inflight.clear();
    emit();
}

/** JPEG / PNG / WebP by magic bytes (the server sniffs too; this is the second check). */
export function sniffCover(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
    return null;
}

/** The cover for `ref` (as `userId`'s friend), as a blob: URL, or null. Never throws. */
export function fetchListeningArt(userId: string, ref: string): Promise<string | null> {
    if (!token || !UUID_RE.test(userId) || !isListenArtRef(ref)) return Promise.resolve(null);
    if (urls.has(ref)) return Promise.resolve(urls.get(ref) ?? null);
    let p = inflight.get(ref);
    if (!p) {
        const asked = token;
        // axios is loaded on first use (the profile views import this module).
        p = import('axios')
            .then(({ default: axios }) => axios.get<ArrayBuffer>(apiUrl`/friends/${userId}/listening/art`, {
                headers: { Authorization: `Bearer ${asked}` }, params: { ref }, responseType: 'arraybuffer', timeout: 10_000,
            }))
            .then((res) => {
                const bytes = new Uint8Array(res.data);
                const type = bytes.byteLength <= 512 * 1024 ? sniffCover(bytes) : null;
                return type ? URL.createObjectURL(new Blob([bytes], { type })) : null;
            })
            // A 404 (not a friend any more, track changed, no cover) is remembered for this ref; anything else is retried later.
            .then(
                (u) => { if (token === asked) remember(ref, u); else revoke(u); return token === asked ? u : null; },
                (e) => { if (e?.response?.status === 404 && token === asked) remember(ref, null); return null; },
            )
            .finally(() => inflight.delete(ref));
        inflight.set(ref, p);
    }
    return p;
}

/** A friend's cover for what they are listening to now: blob: URL, or null (show the music note). */
export function useListeningArt(userId: string | null | undefined, ref: string | null | undefined): string | null {
    const want = userId && ref && isListenArtRef(ref) ? ref : null;
    const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
    const snap = useSyncExternalStore(subscribe, () => (want ? urls.get(want) ?? null : null), () => null);
    // The token arrives after first paint on a fresh start: ask again once it does.
    const authed = useSyncExternalStore(subscribe, () => token !== null, () => false);
    useEffect(() => {
        if (want && userId && authed) void fetchListeningArt(userId, want);
    }, [userId, want, authed]);
    return snap;
}

/** Test seam. */
export function __resetListeningArt(): void { setListeningArtToken(null); }
