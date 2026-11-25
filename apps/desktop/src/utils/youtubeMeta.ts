/**
 * YouTube title + channel for the click-to-play facade, cached per session.
 *
 * Fetched by the main process from YouTube's public oEmbed endpoint
 * (electron/media-embed/youtube-oembed.ts; the renderer passes only the id).
 * Best effort: any failure is "no title" and the facade shows without one.
 * A failure is remembered for a few minutes so a busy channel does not ask
 * again on every remount.
 */

export interface YouTubeMeta { title: string; author: string }

const MAX_ENTRIES = 300;
const FAIL_TTL_MS = 5 * 60_000;

type Entry = { meta: YouTubeMeta | null; at: number };
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<YouTubeMeta | null>>();

function fresh(e: Entry | undefined, now: number): e is Entry {
    return !!e && (e.meta !== null || now - e.at < FAIL_TTL_MS);
}

/** Cached answer: the meta, null (known to have none), or undefined (not asked yet). */
export function peekYouTubeMeta(id: string, now = Date.now()): YouTubeMeta | null | undefined {
    const e = cache.get(id);
    return fresh(e, now) ? e.meta : undefined;
}

export async function loadYouTubeMeta(
    id: string,
    fetchMeta: ((id: string) => Promise<YouTubeMeta | null>) | undefined,
    now = Date.now(),
): Promise<YouTubeMeta | null> {
    const e = cache.get(id);
    if (fresh(e, now)) {
        cache.delete(id);
        cache.set(id, e); // LRU touch
        return e.meta;
    }
    if (!fetchMeta) return null;
    const joined = inFlight.get(id);
    if (joined) return joined;
    const p = (async () => {
        let meta: YouTubeMeta | null = null;
        try {
            const r = await fetchMeta(id);
            if (r && typeof r.title === 'string' && r.title) {
                meta = { title: r.title, author: typeof r.author === 'string' ? r.author : '' };
            }
        } catch { /* best effort: no title */ }
        cache.set(id, { meta, at: Date.now() });
        while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
        return meta;
    })();
    inFlight.set(id, p);
    try { return await p; } finally { inFlight.delete(id); }
}

/** Test-only. */
export function _clearYouTubeMetaCache(): void {
    cache.clear();
    inFlight.clear();
}
