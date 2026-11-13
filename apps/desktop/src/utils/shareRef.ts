/**
 * `share_ref` - a way to say "this sharer report and that viewer report are
 * the same screen share" without naming anything.
 *
 * It is the first 8 hex characters of SHA-256 over a domain tag plus the
 * LiveKit TRACK SID of the share (both ends hold the same SID: the sharer's
 * local publication, the viewer's remote publication). 32 bits is enough to
 * tell two shares apart inside one support inbox's time window, and far too
 * little to look the SID up or to recognise a person: a SID is not an identity
 * (it carries no user id, name or room), it is also never logged - only this
 * digest is. The raw SID is a function argument and a cache key in this
 * module's memory, nowhere else.
 *
 * Async because WebCrypto is; callers resolve it once per share and keep the
 * string (resolveShareRef is memoised, peekShareRef reads the cache).
 */

const DOMAIN = 'cipherline.share-ref.v1:';
export const SHARE_REF_RE = /^[0-9a-f]{8}$/;

const cache = new Map<string, string>();
const MAX_CACHE = 64;

/** Pure formatting half (tested): first 8 hex chars of a digest. */
export function shareRefFromDigest(digest: ArrayBuffer | Uint8Array): string {
    const b = digest instanceof Uint8Array ? digest : new Uint8Array(digest);
    let out = '';
    for (let i = 0; i < 4 && i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
    return out;
}

/** The share's ref, or null when WebCrypto is unavailable (the field is then simply omitted). */
export async function resolveShareRef(sid: string | null | undefined): Promise<string | null> {
    if (!sid) return null;
    const hit = cache.get(sid);
    if (hit) return hit;
    try {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) return null;
        const digest = await subtle.digest('SHA-256', new TextEncoder().encode(DOMAIN + sid));
        const ref = shareRefFromDigest(digest);
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
        cache.set(sid, ref);
        return ref;
    } catch {
        return null;
    }
}

/** Already-resolved ref (sync), or undefined. */
export function peekShareRef(sid: string | null | undefined): string | undefined {
    return sid ? cache.get(sid) : undefined;
}

const claimed = new Set<string>();

/**
 * True the first time a (tag, share_ref) pair is seen, false after: lets an effect that
 * re-runs for the same publication (a retune re-creates it) log a once-per-share fact once.
 */
export function claimShareOnce(tag: string, ref: string): boolean {
    const key = `${tag}|${ref}`;
    if (claimed.has(key)) return false;
    if (claimed.size >= MAX_CACHE) claimed.delete(claimed.values().next().value as string);
    claimed.add(key);
    return true;
}

/** Sign-out / call end: forget the SIDs. */
export function clearShareRefs(): void {
    cache.clear();
    claimed.clear();
}
