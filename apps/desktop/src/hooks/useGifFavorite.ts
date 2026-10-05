import { useCallback, useEffect, useRef, useState } from 'react';
import {
    GIF_LIBRARY_CHANGED,
    addFavorite,
    findFavoriteByHash,
    findLocalByHash,
    hashBlob,
    loadFavorites,
    removeFavorite,
} from '../utils/gifStorage';

/**
 * Favorite state for a GIF shown in chat, keyed on its CONTENT rather than on
 * a flag the embed remembers for itself. A GIF you sent from your own
 * favorites (or any copy of one already in the library) shows as favorited,
 * tapping it again removes it, and it can't be saved twice.
 *
 * `blob` is the decrypted/fetched GIF; pass null until it is available.
 */
export function useGifFavorite(blob: Blob | null, label: string) {
    const [favId, setFavId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const hashRef = useRef<string | null>(null);

    // Hash once per blob.
    useEffect(() => {
        hashRef.current = null;
        setFavId(null);
        if (!blob) return;
        let cancelled = false;
        hashBlob(blob).then(async (h) => {
            if (cancelled) return;
            hashRef.current = h;
            // Cheap check first so the common case paints immediately, then the
            // (possibly decrypting) one for libraries not hashed yet.
            const quick = findLocalByHash(loadFavorites(), h);
            if (quick) { setFavId(quick.id); return; }
            const full = await findFavoriteByHash(h);
            if (!cancelled) setFavId(full?.id ?? null);
        }).catch(() => { /* hashing unavailable — behave as not favorited */ });
        return () => { cancelled = true; };
    }, [blob]);

    // Follow changes made elsewhere (picker removal, sync, another embed).
    useEffect(() => {
        const onChange = () => {
            const h = hashRef.current;
            if (!h) return;
            setFavId(findLocalByHash(loadFavorites(), h)?.id ?? null);
        };
        window.addEventListener(GIF_LIBRARY_CHANGED, onChange);
        return () => window.removeEventListener(GIF_LIBRARY_CHANGED, onChange);
    }, []);

    const toggle = useCallback(async () => {
        if (busy || !blob) return;
        setBusy(true);
        try {
            if (favId) {
                await removeFavorite(favId);
                setFavId(null);
            } else {
                const entry = await addFavorite(blob, 'local', { label });
                setFavId(entry.id);
            }
        } catch (err) {
            console.error('[useGifFavorite] toggle failed', err);
        } finally {
            setBusy(false);
        }
    }, [busy, blob, favId, label]);

    return { saved: favId !== null, busy, toggle };
}
