/**
 * The real sync env for "My stickers": the same own-slot snapshot sync as My
 * Emojis (services/personalEmojiSyncService.ts — pull, publish, anti-entropy,
 * all unchanged), over its own slot, container magic and image cap. The
 * images live in the one shared personal blob store (utils/personalEmoji/store.ts).
 */
import secureLocalStore from '../utils/secureLocalStore';
import type { SlotView } from '../utils/ownSlotSync';
import type { EmojiLibState } from '../utils/personalEmoji/library';
import { personalStickers } from '../utils/personalEmoji/service';
import { PERSONAL_BLOB_MAX_BYTES } from '../utils/personalEmoji/token';
import { createOwnSlotEnv, type OwnSlotAuth } from './ownSlotEnv';
import type { EmojiSyncEnv } from './personalEmojiSyncService';

/** The `/v1/history` slot. Must match apps/api/src/history/backup-slots.ts. */
export const STICKER_LIBRARY_SLOT = 'personal_stickers';
export const STICKER_SNAPSHOT_MAGIC = 'CLSTK1';

/** What this device last knew about the slot (anti-entropy). Device-specific:
 *  never restored from a backup (see backupRegistry.ts). */
export const stickerViewKey = (uid: string) => `cipherline_sticker_sync_view_${uid}`;

export function getStickerSlotView(uid: string): SlotView<EmojiLibState> | null {
    try {
        const raw = secureLocalStore.getItem(stickerViewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}

export function setStickerSlotView(uid: string, view: SlotView<EmojiLibState> | null): void {
    try {
        if (view) secureLocalStore.setItem(stickerViewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(stickerViewKey(uid));
    } catch { /* non-fatal */ }
}

export function createStickerSyncEnv(auth: OwnSlotAuth): EmojiSyncEnv {
    const lib = personalStickers();
    return {
        ...createOwnSlotEnv(auth, STICKER_LIBRARY_SLOT),
        snapshotMagic: STICKER_SNAPSHOT_MAGIC,
        maxBytes: PERSONAL_BLOB_MAX_BYTES,
        loadLocalState: () => lib.load(),
        readBytes: id => lib.store.read(id),
        hasBytes: id => lib.store.has(id),
        writeBytes: (entry, bytes) => lib.store.put(entry.id, bytes, { mime: entry.mime, animated: entry.animated, name: entry.name }),
        applyRemote: remote => lib.applyRemote(remote),
        log: (m: string, e?: unknown) => console.warn(`[stickerSync] ${m}`, e),
    };
}
