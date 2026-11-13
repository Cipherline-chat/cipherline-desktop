import { useEffect, type RefObject } from 'react';
import { toShortcode } from '../utils/emojiNames';
import { isEmptyPlaceholderId } from './emojiPickerTabs';

/**
 * The `:shortcode:` an emoji-mart grid button stands for, else null.
 *
 * Emoji buttons (category grid and search results alike) carry
 * `aria-posinset`, and - because the picker runs with previewPosition none -
 * a `title` that is the emoji's name: "Fire Engine" for a standard emoji, the
 * stored name for My Emojis / server emojis. The shortcode is that name in
 * the same underscore form the composer autocomplete shows and accepts
 * (`:fire_engine:`). Nav tabs, the skin-tone button, the search box's clear
 * button and the hidden empty-tab placeholder are not emojis.
 */
export function pickerButtonShortcode(button: Element | null): string | null {
    if (!button || !button.hasAttribute('aria-posinset')) return null;
    const title = button.getAttribute('title');
    if (!title || isEmptyPlaceholderId(title)) return null;
    const code = toShortcode(title);
    return code ? `:${code}:` : null;
}

/**
 * While the pointer is over an emoji in the picker, its search box shows that
 * emoji's `:shortcode:` in place of the "Search" placeholder, so the code to
 * type next time is right there. Leaving the emoji restores the original
 * placeholder. Only the placeholder changes: a typed query is never touched.
 *
 * emoji-mart lives in a shadow root, so the listeners go there (polling until
 * the custom element upgrades), the same way useMyEmojiContextMenu attaches.
 */
export function useHoverShortcodePlaceholder(wrapRef: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        let root: ShadowRoot | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;
        let original: string | null = null;

        const input = (): HTMLInputElement | null =>
            root?.querySelector<HTMLInputElement>('.search input[type="search"]') ?? null;
        const restore = () => {
            const el = input();
            if (el && original !== null) el.placeholder = original;
        };
        const onOver = (e: Event) => {
            const button = (e.target as Element | null)?.closest?.('button') ?? null;
            const code = pickerButtonShortcode(button);
            if (!code) { restore(); return; }
            const el = input();
            if (!el) return;
            if (original === null) original = el.placeholder;
            el.placeholder = code;
        };
        const onLeave = () => restore();

        const attach = (): boolean => {
            const picker = wrapRef.current?.querySelector('em-emoji-picker') as (Element & { shadowRoot: ShadowRoot | null }) | null;
            if (!picker?.shadowRoot) return false;
            root = picker.shadowRoot;
            root.addEventListener('mouseover', onOver);
            picker.addEventListener('mouseleave', onLeave);
            return true;
        };
        if (!attach()) {
            interval = setInterval(() => { if (attach() && interval) { clearInterval(interval); interval = null; } }, 16);
        }
        return () => {
            if (interval) clearInterval(interval);
            root?.removeEventListener('mouseover', onOver);
            (root?.host as Element | undefined)?.removeEventListener('mouseleave', onLeave);
            restore();
        };
    }, [wrapRef]);
}
