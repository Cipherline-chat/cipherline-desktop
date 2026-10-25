/**
 * The real `EmojiSyncEnv`: the shared own-slot transport (`createOwnSlotEnv`)
 * plus this device's My Emojis store.
 */
import secureLocalStore from '../utils/secureLocalStore';
import type { SlotView } from '../utils/ownSlotSync';
import type { EmojiLibState } from '../utils/personalEmoji/library';
import { personalEmojis } from '../utils/personalEmoji/service';
import { createOwnSlotEnv, type OwnSlotAuth } from './ownSlotEnv';
import { ownEntranceSound } from '../utils/customEntranceSound/ownStore';
import { exportEntranceSound, importEntranceSound } from '../utils/customEntranceSound/transfer';
import { EMOJI_LIBRARY_SLOT, type EmojiSyncEnv } from './personalEmojiSyncService';

/** What this device last knew about the slot (anti-entropy). Device-specific:
 *  never restored from a backup (see backupRegistry.ts). */
export const emojiViewKey = (uid: string) => `cipherline_emoji_sync_view_${uid}`;

export function getEmojiSlotView(uid: string): SlotView<EmojiLibState> | null {
    try {
        const raw = secureLocalStore.getItem(emojiViewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}

export function setEmojiSlotView(uid: string, view: SlotView<EmojiLibState> | null): void {
    try {
        if (view) secureLocalStore.setItem(emojiViewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(emojiViewKey(uid));
    } catch { /* non-fatal */ }
}

export function createEmojiSyncEnv(auth: OwnSlotAuth): EmojiSyncEnv {
    const lib = personalEmojis();
    return {
        ...createOwnSlotEnv(auth, EMOJI_LIBRARY_SLOT),
        loadLocalState: () => lib.load(),
        readBytes: id => lib.store.read(id),
        hasBytes: id => lib.store.has(id),
        writeBytes: (entry, bytes) => lib.store.put(entry.id, bytes, { mime: entry.mime, animated: entry.animated, name: entry.name }),
        applyRemote: remote => lib.applyRemote(remote),
        // Your custom entrance sound rides in the same snapshot (see personalEmojiSyncService.ts).
        exportEntranceSound: () => exportEntranceSound(ownEntranceSound()),
        importEntranceSound: raw => importEntranceSound(ownEntranceSound(), raw, 'sync'),
    };
}
