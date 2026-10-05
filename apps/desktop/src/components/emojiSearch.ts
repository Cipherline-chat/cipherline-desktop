import type { EmojiMartData, Emoji } from '@emoji-mart/data';

/**
 * The `:query` autocomplete's emoji search, with the emoji dataset loaded on
 * demand instead of at startup.
 *
 * WHY (startup performance): `@emoji-mart/data` is ~0.5 MB of JSON and was
 * imported statically by EmojiPicker.tsx, which ChatPane imports — so it, the
 * emoji-mart library and its `init()` (which walks the whole dataset) were all
 * parsed and run before the app's first paint, on every launch, for a feature
 * that is only needed once someone types `:sm…` or opens the picker. The
 * dataset now loads once the app is idle after boot (prefetchEmojiPicker
 * below) or on first use, whichever comes first.
 *
 * Same results as before once loaded. Before it has loaded, a search starts
 * the load and returns nothing — the composer re-runs the search on the very
 * next keystroke, and in practice the idle prefetch has long finished by then.
 */

let data: EmojiMartData | null = null;
let loading: Promise<EmojiMartData> | null = null;

export function loadEmojiData(): Promise<EmojiMartData> {
    if (data) return Promise.resolve(data);
    if (!loading) {
        loading = import('@emoji-mart/data').then((m) => {
            data = ((m as { default?: unknown }).default ?? m) as EmojiMartData;
            return data;
        });
        // A failed chunk load must not be cached forever — the next call retries.
        loading.catch(() => { loading = null; });
    }
    return loading;
}

/** The picker module itself (emoji-mart + its React wrapper) — see
 *  emojiPickerLazy.tsx, which renders it through React.lazy. */
export const loadEmojiPickerModule = () => import('./EmojiPicker');

let prefetched = false;
/** Warm the picker module and the emoji dataset in the background (idle
 *  prefetch after boot — utils/bootPrefetch.ts). Never throws. */
export function prefetchEmojiPicker(): void {
    if (prefetched) return;
    prefetched = true;
    loadEmojiPickerModule().catch(() => { prefetched = false; });
    loadEmojiData().catch(() => { /* retried on first use */ });
}

/** The dataset if it has finished loading, else null (never triggers a load). */
export function getLoadedEmojiData(): EmojiMartData | null {
    return data;
}

// ── Programmatic emoji search (used by the :query autocomplete) ───────────────
export interface EmojiSuggestion {
    id: string;
    /** Empty string for a custom-server-emoji suggestion — see `custom` below.
     *  Never rendered directly for those; callers branch on `custom`. */
    native: string;
    name: string;
    /** Present only for a custom-server-emoji suggestion (see ChatPane's
     *  searchEmojiWithCustom). Carries what EmojiImage needs to render it. */
    custom?: { attachmentId: string; keyB64: string; nonceB64: string };
}

// emoji-mart's own `SearchIndex.search()` is async (always returns a Promise,
// even though the :query autocomplete needs a synchronous result on every
// keystroke), so the search is done directly against the dataset instead.
export function searchEmoji(query: string, limit = 8): EmojiSuggestion[] {
    if (!query || query.length < 2) return [];
    const emojiData = data;
    if (!emojiData) {
        loadEmojiData().catch(() => { /* retried on the next keystroke */ });
        return [];
    }
    try {
        const q = query.toLowerCase();
        const scored: { emoji: Emoji; score: number }[] = [];
        for (const emoji of Object.values(emojiData.emojis)) {
            const id = emoji.id.toLowerCase();
            let score = -1;
            if (id === q) score = 0;
            else if (id.startsWith(q)) score = 1;
            else if (id.includes(q)) score = 2;
            else if (emoji.keywords?.some(k => k.toLowerCase().startsWith(q))) score = 3;
            else if (emoji.name.toLowerCase().includes(q)) score = 4;
            if (score >= 0) scored.push({ emoji, score });
        }
        scored.sort((a, b) => a.score - b.score || a.emoji.id.localeCompare(b.emoji.id));
        return scored.slice(0, limit).map(({ emoji }) => ({
            id: emoji.id,
            native: emoji.skins[0].native,
            name: emoji.name,
        }));
    } catch {
        return [];
    }
}
