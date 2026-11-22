/**
 * "Add to My stickers" — saving a sticker someone sent (personal or server)
 * into the user's own library. Same shape as "Save to My Emojis"
 * (personalEmojiSaveItem.tsx), over personalStickers().
 */
import { BookmarkPlus } from 'lucide-react';
import type { ToastInput } from '../../contexts/ToastContext';
import { personalStickers } from '../../utils/personalEmoji/service';
import { PERSONAL_STICKER_LIBRARY_MAX } from '@cipherline/shared';
import { stickerBytes } from '../../utils/stickers/bytes';
import { uniqueEmojiName } from '../personalEmojiSaveItem';
import type { StickerRef } from '../../utils/stickers/wire';
import type { ContextMenuItem } from '../primitives/ContextMenu';

type Push = (t: ToastInput) => void;

/** Save finished sticker bytes (<= 320 px, <= 512 KB) to My stickers, with a toast. */
export async function saveBytesToMyStickers(bytes: Uint8Array, name: string, push: Push): Promise<boolean> {
    const lib = personalStickers();
    const taken = new Set(lib.load().entries.map(e => e.name));
    const res = await lib.add(bytes, uniqueEmojiName(taken, name));
    if (res.ok) {
        push(res.alreadyHad
            ? { kind: 'info', message: `That sticker is already in My stickers as "${res.entry.name}".` }
            : { kind: 'success', message: `Added "${res.entry.name}" to My stickers.` });
        return true;
    }
    push({
        kind: 'error',
        title: "Couldn't add sticker",
        message: res.error === 'full' ? `My stickers is full (${PERSONAL_STICKER_LIBRARY_MAX} max). Remove one in Settings > Activity & Style first.`
            : res.error === 'too_large' ? 'That sticker is too large to save.'
            : res.error === 'signed_out' ? 'Sign in to save stickers.'
            : 'That sticker could not be saved.',
    });
    return false;
}

/** The message-menu row. */
export function addToMyStickersItem(ref: StickerRef, token: string | null, push: Push): ContextMenuItem {
    const inLibrary = ref.source === 'personal' && personalStickers().load().entries.some(e => e.id === ref.id);
    return {
        icon: <BookmarkPlus size={14} />,
        label: inLibrary ? 'In My stickers' : 'Add to My stickers',
        disabled: inLibrary,
        onSelect: () => {
            if (inLibrary) return;
            void (async () => {
                const bytes = await stickerBytes(ref, token);
                if (!bytes) push({ kind: 'error', message: 'That sticker is not available to save.' });
                else await saveBytesToMyStickers(bytes, ref.name, push);
            })();
        },
    };
}
