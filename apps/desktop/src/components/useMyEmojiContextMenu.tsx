import React, { useEffect, useRef, type RefObject } from 'react';
import { Trash2 } from 'lucide-react';
import { useContextMenu } from '../hooks/useContextMenu';
import { useToast, type ToastInput } from '../contexts/ToastContext';
import { personalEmojis } from '../utils/personalEmoji/service';
import type { EmojiEntry } from '../utils/personalEmoji/library';
import { MY_EMOJI_TAB } from './emojiPickerTabs';
import { MenuHost } from './primitives/MenuHost';
import type { ContextMenuItem } from './primitives/ContextMenu';

/**
 * Which My Emojis entry an emoji-mart grid button shows, else null.
 *
 * In the category grid the button sits under `.category[data-id=my_emojis]` and
 * its `title` is the emoji's name (the picker runs with previewPosition none).
 * In search results there is no category wrapper, and a server emoji can share
 * a name with a personal one, so there the button's image URL is matched
 * against the resolved blob: URLs instead. Anything else (unicode, server
 * emojis, the empty-tab placeholder) is not a personal emoji.
 */
export function resolveMyEmojiEntry(
    button: Element | null,
    entries: readonly EmojiEntry[],
    urls: Readonly<Record<string, string>>,
): EmojiEntry | null {
    if (!button) return null;
    const category = button.closest('.category');
    if (category) {
        if (category.getAttribute('data-id') !== MY_EMOJI_TAB.categoryId) return null;
        const name = button.getAttribute('title');
        return entries.find(e => e.name === name) ?? null;
    }
    const src = button.querySelector('img')?.getAttribute('src');
    if (!src || !src.startsWith('blob:')) return null;
    const id = Object.keys(urls).find(k => urls[k] === src);
    return id ? entries.find(e => e.id === id) ?? null : null;
}

/** Remove from My Emojis with an Undo toast. Same service call as Settings, so
 *  the tombstone / cross-device sync semantics are identical; Undo restores the
 *  entry at its old position. */
export function removeFromMyEmojisWithUndo(entry: EmojiEntry, push: (t: ToastInput) => void): void {
    const lib = personalEmojis();
    lib.remove(entry.id);
    push({
        kind: 'info',
        message: `Removed :${entry.name}: from My Emojis.`,
        durationMs: 6000,
        action: {
            label: 'Undo',
            onClick: () => {
                void lib.restore(entry).then(res => {
                    if (!res.ok) {
                        push({
                            kind: 'error',
                            message: res.error === 'full'
                                ? 'My Emojis is full, so that emoji could not be restored.'
                                : 'That emoji could not be restored.',
                        });
                    }
                });
            },
        },
    });
}

/**
 * Right-click on a My Emojis emoji inside the emoji-mart grid opens a small
 * menu ("Remove from My Emojis"). The grid lives in emoji-mart's shadow root,
 * so the listener is attached there (polling until the element upgrades).
 * Right-clicks on anything else are left alone.
 */
export function useMyEmojiContextMenu(
    wrapRef: RefObject<HTMLElement | null>,
    entries: readonly EmojiEntry[],
    urls: Readonly<Record<string, string>>,
): { menu: React.ReactNode; isOpen: boolean } {
    const ctx = useContextMenu();
    const { push } = useToast();
    const latest = useRef({ entries, urls, push, ctx });
    useEffect(() => { latest.current = { entries, urls, push, ctx }; });

    useEffect(() => {
        let root: ShadowRoot | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;
        const onContext = (e: Event) => {
            const button = (e.target as Element | null)?.closest?.('button');
            const cur = latest.current;
            const entry = resolveMyEmojiEntry(button ?? null, cur.entries, cur.urls);
            if (!entry) return;
            const items: ContextMenuItem[] = [{
                icon: <Trash2 size={14} />,
                label: 'Remove from My Emojis',
                danger: true,
                onSelect: () => removeFromMyEmojisWithUndo(entry, latest.current.push),
            }];
            cur.ctx.open(e as MouseEvent, items, `:${entry.name}:`);
        };
        const attach = (): boolean => {
            const picker = wrapRef.current?.querySelector('em-emoji-picker') as (Element & { shadowRoot: ShadowRoot | null }) | null;
            if (!picker?.shadowRoot) return false;
            root = picker.shadowRoot;
            root.addEventListener('contextmenu', onContext);
            return true;
        };
        if (!attach()) {
            interval = setInterval(() => { if (attach() && interval) { clearInterval(interval); interval = null; } }, 16);
        }
        return () => {
            if (interval) clearInterval(interval);
            root?.removeEventListener('contextmenu', onContext);
        };
    }, [wrapRef]);

    return { menu: <MenuHost>{ctx.menu}</MenuHost>, isOpen: ctx.isOpen };
}
