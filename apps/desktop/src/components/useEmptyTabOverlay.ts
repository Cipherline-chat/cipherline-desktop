import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { emptyTabForLabel, type EmojiTabDef, type EmojiTabId } from './emojiPickerTabs';

export interface EmptyTabOverlay {
    tab: EmojiTabDef;
    /** Offsets (px) inside the picker wrapper that frame the emoji grid, below the search row. */
    top: number;
    bottom: number;
}

/**
 * Watches emoji-mart's shadow-root nav bar: choosing a tab whose category is
 * empty (it only holds the hidden placeholder) yields an overlay frame for the
 * empty-state panel; choosing any other tab, typing in the search box, or
 * `dismiss()` clears it. Keyboard activation of a tab button arrives as a
 * normal click, so no separate key handling is needed.
 */
export function useEmptyTabOverlay(wrapRef: RefObject<HTMLElement | null>, emptyTabs: readonly EmojiTabId[]) {
    const [overlay, setOverlay] = useState<EmptyTabOverlay | null>(null);
    const emptyRef = useRef(emptyTabs);
    useEffect(() => { emptyRef.current = emptyTabs; });
    const dismiss = useCallback(() => setOverlay(null), []);

    useEffect(() => {
        let root: ShadowRoot | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;

        const onClick = (e: Event) => {
            const button = (e.target as Element | null)?.closest?.('#nav button');
            if (!button) return;
            const tab = emptyTabForLabel(button.getAttribute('aria-label'), emptyRef.current);
            const wrap = wrapRef.current;
            const scroll = root?.querySelector('.scroll');
            if (!tab || !wrap || !scroll) { setOverlay(null); return; }
            const w = wrap.getBoundingClientRect();
            const s = scroll.getBoundingClientRect();
            const searchBottom = root?.querySelector('input[type=search]')?.getBoundingClientRect().bottom ?? s.top;
            setOverlay({
                tab,
                top: Math.max(0, Math.max(searchBottom, s.top) + 8 - w.top),
                bottom: Math.max(0, w.bottom - s.bottom),
            });
        };
        const onInput = (e: Event) => {
            if ((e.target as Element | null)?.matches?.('input[type=search]')) setOverlay(null);
        };

        const attach = (): boolean => {
            const picker = wrapRef.current?.querySelector('em-emoji-picker') as (Element & { shadowRoot: ShadowRoot | null }) | null;
            if (!picker?.shadowRoot) return false;
            root = picker.shadowRoot;
            root.addEventListener('click', onClick);
            root.addEventListener('input', onInput);
            return true;
        };
        // The custom element may not have upgraded on the first tick.
        if (!attach()) {
            interval = setInterval(() => { if (attach() && interval) { clearInterval(interval); interval = null; } }, 16);
        }
        return () => {
            if (interval) clearInterval(interval);
            root?.removeEventListener('click', onClick);
            root?.removeEventListener('input', onInput);
        };
    }, [wrapRef]);

    return { overlay, dismiss };
}
