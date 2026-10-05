/**
 * Session cache of DECRYPTED attachment object URLs, keyed by attachment id.
 *
 * Why: ChatPane remounts on every conversation switch, and its `objectUrls`
 * map started empty each time — so going back to a channel re-read every
 * attachment from IndexedDB, re-ran AES-GCM on it, minted a new blob URL and
 * re-rendered the pane once per image as each finished. Worse, those blob URLs
 * were never revoked, so every visit leaked another decrypted copy of every
 * image for the rest of the session.
 *
 * Now a pane takes ("acquires") the URL from here when it already exists and
 * releases it on unmount. Released entries stay for instant reuse until the
 * byte/entry budget pushes them out, at which point the URL is REVOKED — so
 * decrypted media is held for strictly less time than before (bounded, instead
 * of until the window closes), and `clearDecryptedMediaCache()` drops it all at
 * sign-out. An entry a mounted pane is still showing is never evicted.
 */
import { BlobUrlCache } from './blobUrlCache';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200;

const cache = new BlobUrlCache(MAX_BYTES, MAX_ENTRIES);

/** The cached URL without taking a hold (marks it recently used). For a
 *  render-time seed; the caller must `acquire` it in an effect before relying
 *  on it, and treat a different answer there as a miss. */
export function peekDecryptedMedia(attachmentId: string): string | null {
    return cache.peek(attachmentId)?.url ?? null;
}

/** The cached URL for `attachmentId`, now held by the caller (release it), or
 *  null. */
export function acquireDecryptedMedia(attachmentId: string): string | null {
    return cache.acquire(attachmentId)?.url ?? null;
}

/**
 * Hands a freshly decrypted object URL to the cache, held by the caller.
 * Returns the URL the caller must use: if another pane cached the same
 * attachment meanwhile, that one wins and `url` is revoked. `blob`, when given,
 * is kept beside the URL (it pins the same bytes the URL already does) so a
 * saved GIF can be re-sent without reading and decrypting its file again.
 */
export function putDecryptedMedia(attachmentId: string, url: string, size: number, blob?: Blob): string {
    return cache.put(attachmentId, url, size, blob ? { blob } : undefined).url;
}

/**
 * The one way callers register a decrypted (or locally-held) Blob: mints the
 * object URL, caches it under `key` held by the caller, and returns the URL to
 * use. Also how a file the user just uploaded is shown straight from the local
 * File — no download, no decrypt.
 */
export function putDecryptedMediaBlob(key: string, blob: Blob): string {
    return putDecryptedMedia(key, URL.createObjectURL(blob), blob.size, blob);
}

/** The cached Blob behind `key`, without a hold (used synchronously). */
export function peekDecryptedMediaBlob(key: string): Blob | null {
    return cache.peek(key)?.blob ?? null;
}

/** The caller no longer shows this attachment. */
export function releaseDecryptedMedia(attachmentId: string): void {
    cache.release(attachmentId);
}

// ── Inline thumbnails (FileViewer) ──────────────────────────────────────────
// The down-scaled JPEG FileViewer shows inline for a large image, keyed by the
// full-size object URL it was made from. Re-making it meant decoding the full
// image and re-encoding a JPEG on every remount (= every chat switch); with
// the full-size URL now stable across remounts (above), its thumbnail can be
// too. Same hold/evict/revoke rules; small, so a generous entry cap.
const thumbs = new BlobUrlCache(16 * 1024 * 1024, 300);

export interface MediaThumb { url: string; width?: number; height?: number }

/** Cached thumbnail for a full-size URL, held by the caller, or null. */
export function acquireMediaThumb(sourceUrl: string): MediaThumb | null {
    const e = thumbs.acquire(sourceUrl);
    return e ? { url: e.url, width: e.width, height: e.height } : null;
}

/** Without a hold — for a render-time seed (acquire it in an effect). */
export function peekMediaThumb(sourceUrl: string): MediaThumb | null {
    const e = thumbs.peek(sourceUrl);
    return e ? { url: e.url, width: e.width, height: e.height } : null;
}

/** Store a freshly made thumbnail, held by the caller. Returns the one to use. */
export function putMediaThumb(sourceUrl: string, url: string, size: number, width: number, height: number): MediaThumb {
    const e = thumbs.put(sourceUrl, url, size, { width, height });
    return { url: e.url, width: e.width, height: e.height };
}

export function releaseMediaThumb(sourceUrl: string): void {
    thumbs.release(sourceUrl);
}

/** Revoke everything (sign-out), held entries included: nothing decrypted
 *  outlives the session. Panes still mounted lose their images. */
export function clearDecryptedMediaCache(): void {
    cache.clear();
    thumbs.clear();
}

/** Test-only view of the cache state. */
export function __decryptedMediaStats(): { entries: number; bytes: number; held: number } {
    return cache.stats();
}

export const __decryptedMediaBudget = { MAX_BYTES, MAX_ENTRIES } as const;
