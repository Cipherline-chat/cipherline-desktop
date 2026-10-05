/**
 * Remote images linked in messages (ImageLinkEmbed), fetched through the main
 * process (`net:fetch-binary`: CORS/hotlink-proof and SSRF-guarded).
 *
 * PERF: every ChatPane remount (= every conversation switch) used to re-fetch
 * each linked image over IPC, decode its base64 with a per-character callback
 * (`Uint8Array.from(atob(b64), c => c.charCodeAt(0))` — hundreds of ms of
 * main-thread time for a few-MB GIF), and mint a fresh blob URL that it then
 * revoked on unmount. Now:
 *   - one fetch per URL per session while it stays in the bounded cache below
 *     (switching back to a channel shows its images immediately);
 *   - concurrent embeds of the same URL share one in-flight fetch;
 *   - the base64 decode uses the native decoder when there is one;
 *   - the intrinsic size is remembered, so a remount reserves the exact box
 *     (no layout jump while the image decodes).
 * Nothing about WHEN an image auto-loads changes — that is still decided by
 * the user's imageAutoLoad setting in ImageLinkEmbed.
 */
import { BlobUrlCache, type BlobUrlEntry } from './blobUrlCache';
import { bytesFromBinaryPayload, type BinaryPayload } from './binaryPayload';

const cache = new BlobUrlCache(48 * 1024 * 1024, 150);
const inFlight = new Map<string, Promise<void>>();

export type RemoteImage = BlobUrlEntry;

/** Cached entry without a hold — for a render-time seed. */
export function peekRemoteImage(url: string): RemoteImage | null {
    return cache.peek(url);
}

/** Cached entry, held by the caller, or null. */
export function acquireRemoteImage(url: string): RemoteImage | null {
    return cache.acquire(url);
}

export function releaseRemoteImage(url: string): void {
    cache.release(url);
}

export function rememberRemoteImageSize(url: string, width: number, height: number): void {
    cache.setSize(url, width, height);
}

/**
 * Fetches (or joins an in-flight fetch of) `url` and returns the entry, held
 * by the caller. `fetchBinary` is the preload bridge call.
 */
export async function loadRemoteImage(
    url: string,
    fetchBinary: (u: string) => Promise<BinaryPayload>,
): Promise<RemoteImage> {
    const hit = cache.acquire(url);
    if (hit) return hit;
    const joined = inFlight.get(url);
    if (joined) {
        await joined;
        const e = cache.acquire(url);
        if (!e) throw new Error('image evicted before use');
        return e;
    }
    // This caller fetches; the hold `put` takes is this caller's.
    const p = (async () => {
        const res = await fetchBinary(url);
        const bytes = bytesFromBinaryPayload(res);
        const blob = new Blob([bytes as BlobPart], { type: res.mimeType });
        return cache.put(url, URL.createObjectURL(blob), blob.size, { blob });
    })();
    // Joiners await this; a failure reaches them as the real error. The
    // no-op catch only stops it being reported as unhandled when nobody joined.
    const settled = p.then(() => {});
    settled.catch(() => {});
    inFlight.set(url, settled);
    try {
        return await p;
    } finally {
        inFlight.delete(url);
    }
}

export function clearRemoteImageCache(): void {
    cache.clear();
}

/** Test-only. */
export function __remoteImageStats() { return cache.stats(); }
