/**
 * A thumbnail fetched through the main process (`net:fetch-binary`: SSRF-
 * guarded, no cookies, no referrer) into the session image cache
 * (utils/remoteImageCache), trying each candidate URL in order.
 *
 * Returns a `blob:` URL or null. An image already cached this session shows on
 * the first paint of a remount; new fetches go through the auto-load limiter
 * so a busy channel never fires dozens at once.
 */
import { useEffect, useState } from 'react';
import { acquireRemoteImage, loadRemoteImage, peekRemoteImage, releaseRemoteImage } from '../../utils/remoteImageCache';
import { acquireAutoLoadSlot } from '../../utils/autoLoadLimiter';

function firstCached(list: readonly string[]): string | null {
    for (const u of list) {
        const e = peekRemoteImage(u);
        if (e) return e.url;
    }
    return null;
}

export function useRemoteThumb(urls: readonly string[] | null, enabled: boolean): string | null {
    const key = urls ? urls.join('\n') : '';
    // The loaded src for THIS candidate list.
    const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(null);

    useEffect(() => {
        const list = key ? key.split('\n') : [];
        const fetchBinary = typeof window !== 'undefined' ? window.electronAPI?.fetchBinary : undefined;
        if (!enabled || list.length === 0) return;
        let cancelled = false;
        let held: string | null = null;
        const take = (u: string, src: string) => {
            if (cancelled) { releaseRemoteImage(u); return; }
            held = u;
            setLoaded({ key, src });
        };
        (async () => {
            for (const u of list) {
                const hit = acquireRemoteImage(u);
                if (hit) { take(u, hit.url); return; }
            }
            if (!fetchBinary) return;
            const release = await acquireAutoLoadSlot();
            try {
                for (const u of list) {
                    if (cancelled) return;
                    try {
                        const e = await loadRemoteImage(u, (x) => fetchBinary(x));
                        take(u, e.url);
                        return;
                    } catch { /* next candidate */ }
                }
            } finally {
                release();
            }
        })();
        return () => {
            cancelled = true;
            if (held) releaseRemoteImage(held);
        };
    }, [key, enabled]);

    if (!enabled || !key) return null;
    return loaded?.key === key ? loaded.src : firstCached(key.split('\n'));
}
