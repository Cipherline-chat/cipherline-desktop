/**
 * "Save to My Emojis" - the shared save action and context-menu row used by
 * every place an emoji can be right-clicked (a personal emoji someone sent,
 * a server emoji in a message or reaction).
 */
import { BookmarkPlus, Check } from 'lucide-react';
import type { ToastInput } from '../contexts/ToastContext';
import { personalEmojis } from '../utils/personalEmoji/service';
import { isPersonalEmojiName, PERSONAL_EMOJI_LIBRARY_MAX } from '../utils/personalEmoji/token';
import type { ContextMenuItem } from './primitives/ContextMenu';

/** A name the library will accept: `name`, or `name_2`, `name_3`... if taken. */
export function uniqueEmojiName(taken: ReadonlySet<string>, name: string): string {
    const base = isPersonalEmojiName(name) ? name : 'emoji';
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
        const suffix = `_${n}`;
        const candidate = base.slice(0, 32 - suffix.length) + suffix;
        if (!taken.has(candidate)) return candidate;
    }
    return base;
}

type Push = (t: ToastInput) => void;

/** Save finished emoji bytes to My Emojis, reporting the outcome in a toast. */
export async function saveBytesToMyEmojis(bytes: Uint8Array, name: string, push: Push): Promise<boolean> {
    const lib = personalEmojis();
    const taken = new Set(lib.load().entries.map(e => e.name));
    const res = await lib.add(bytes, uniqueEmojiName(taken, name));
    if (res.ok) {
        push(res.alreadyHad
            ? { kind: 'info', message: 'That emoji is already in My Emojis.' }
            : { kind: 'success', message: `Saved :${res.entry.name}: to My Emojis.` });
        return true;
    }
    push({
        kind: 'error',
        title: "Couldn't save emoji",
        message: res.error === 'full' ? `My Emojis is full (${PERSONAL_EMOJI_LIBRARY_MAX} max). Remove one in Settings > Personalize first.`
            : res.error === 'too_large' ? 'That emoji is too large to save.'
            : res.error === 'signed_out' ? 'Sign in to save emojis.'
            : 'That emoji could not be saved.',
    });
    return false;
}

/** The "Save to My Emojis" menu row for an image whose bytes `getBytes` can supply. */
export function saveToMyEmojisItem(
    inLibrary: boolean,
    getBytes: () => Promise<Uint8Array | null>,
    name: string,
    push: Push,
): ContextMenuItem {
    return inLibrary
        ? { icon: <Check size={14} />, label: 'In My Emojis', disabled: true, onSelect: () => {} }
        : {
            icon: <BookmarkPlus size={14} />,
            label: 'Save to My Emojis',
            onSelect: () => {
                void (async () => {
                    const bytes = await getBytes();
                    if (!bytes) push({ kind: 'error', message: 'That emoji is not available to save.' });
                    else await saveBytesToMyEmojis(bytes, name, push);
                })();
            },
        };
}
