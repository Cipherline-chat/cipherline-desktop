import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useHydrationGeneration } from '../contexts/HydrationContext';
import {
    loadEmojiUrl,
    loadEmojiUrls,
    peekEmojiUrl,
    subscribeEmojiUrl,
    type EmojiImageRef,
} from '../utils/serverEmojiLoader';
import { createUrlBatcher } from '../utils/emojiUrlBatcher';

/** A failed load (network blip, expired URL) gets a few more goes. */
const RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

/**
 * One custom emoji → object URL, through serverEmojiLoader's batched,
 * concurrency-capped pipeline. Read with useSyncExternalStore straight from
 * the loader's memory cache, so an emoji seen before (this session, or warmed
 * from the encrypted disk cache) paints solid on the first render, and every
 * <EmojiImage> of the same emoji updates together when it resolves.
 */
export function useServerEmojiUrl(ref: EmojiImageRef | null, token: string | null): string | null {
    const hydrationGeneration = useHydrationGeneration();
    const id = ref?.attachmentId ?? null;

    const subscribe = useCallback(
        (onChange: () => void) => (id ? subscribeEmojiUrl(id, onChange) : () => {}),
        [id],
    );
    const url = useSyncExternalStore(subscribe, () => peekEmojiUrl(id));

    useEffect(() => {
        if (!ref || !token || peekEmojiUrl(ref.attachmentId)) return;
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let attempt = 0;
        const load = () => {
            void loadEmojiUrl(ref, token, 'visible').then(u => {
                // A hit reaches the component through the subscription above.
                if (!alive || u) return;
                if (attempt < RETRY_DELAYS_MS.length) timer = setTimeout(load, RETRY_DELAYS_MS[attempt++]);
            });
        };
        load();
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
        };
    }, [ref, token, hydrationGeneration]);

    return token ? url : null;
}

/**
 * Many emojis → `{ [attachmentId]: url }`, for a consumer that must rebuild
 * something expensive whenever the map changes (emoji-mart's whole grid is
 * re-initialised on every `custom` change). Resolutions are coalesced by
 * createUrlBatcher: republished at most once per `flushMs`, and immediately
 * once every requested emoji has settled — so 100 cold emojis cost a handful
 * of rebuilds instead of one per emoji.
 */
export function useServerEmojiUrls(
    refs: EmojiImageRef[],
    token: string | null,
    flushMs = 150,
): Record<string, string> {
    // Only the emoji SET matters, not the array identity a parent re-render
    // produces — key on the ids so an unrelated render does not restart this.
    const key = refs.map(r => `${r.attachmentId}:${r.keyB64}`).join(',');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const stableRefs = useMemo(() => refs, [key]);

    const [published, setPublished] = useState<{ key: string; urls: Record<string, string> } | null>(null);

    useEffect(() => {
        if (!token || stableRefs.length === 0) return;
        const batcher = createUrlBatcher(
            stableRefs.map(r => r.attachmentId),
            flushMs,
            urls => setPublished({ key, urls }),
        );
        const unsubs = stableRefs.map(r => subscribeEmojiUrl(r.attachmentId, u => batcher.resolve(r.attachmentId, u)));
        const toLoad = stableRefs.filter(r => !peekEmojiUrl(r.attachmentId));
        for (const r of stableRefs) {
            const u = peekEmojiUrl(r.attachmentId);
            if (u) batcher.resolve(r.attachmentId, u);
        }
        void loadEmojiUrls(toLoad, token, 'visible').then(results => {
            // Failures still count as settled, so the final publish is not
            // held back waiting for an emoji that will never arrive.
            results.forEach((u, i) => { if (!u) batcher.fail(toLoad[i].attachmentId); });
        });
        return () => { unsubs.forEach(u => u()); batcher.dispose(); };
    }, [stableRefs, key, token, flushMs]);

    // Before the first publish for this emoji set, whatever is already in
    // memory — a picker reopened later paints complete on its first frame.
    return useMemo(() => {
        if (published?.key === key) return published.urls;
        const initial: Record<string, string> = {};
        for (const r of stableRefs) {
            const u = peekEmojiUrl(r.attachmentId);
            if (u) initial[r.attachmentId] = u;
        }
        return initial;
    }, [published, key, stableRefs]);
}
