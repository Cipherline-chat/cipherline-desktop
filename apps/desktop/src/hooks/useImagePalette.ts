import { useEffect, useState } from 'react';
import { paletteFromImageUrl, type Swatch } from '../utils/palette';

/** One palette per image URL for the session (blob URLs are per-session anyway). */
const cache = new Map<string, Swatch[] | null>();
const pending = new Map<string, Promise<Swatch[] | null>>();

/**
 * The colours of a local image (your decrypted banner / avatar), clustered on
 * this device (utils/palette). `enabled` = false does no work. Returns
 * undefined while reading, null when the image could not be read.
 */
export function useImagePalette(url: string | null | undefined, enabled = true): Swatch[] | null | undefined {
    const key = enabled && url ? url : null;
    const [state, setState] = useState<{ key: string | null; value: Swatch[] | null | undefined }>(() => ({ key, value: key && cache.has(key) ? cache.get(key) : undefined }));
    useEffect(() => {
        if (!key || cache.has(key)) return; // a cached answer is read straight from the cache below
        let alive = true;
        let p = pending.get(key);
        if (!p) {
            p = paletteFromImageUrl(key).then((v) => { cache.set(key, v); return v; }).finally(() => pending.delete(key));
            pending.set(key, p);
        }
        p.then((v) => { if (alive) setState({ key, value: v }); });
        return () => { alive = false; };
    }, [key]);
    if (!key) return undefined;
    if (cache.has(key)) return cache.get(key);
    return state.key === key ? state.value : undefined;
}
