/**
 * React binding for My stickers (utils/personalEmoji/service.ts
 * `personalStickers()`): the library in display order, live. Image URLs come
 * from `usePersonalEmojiUrl` — the blob store is shared, so it resolves a
 * personal sticker's id exactly like a personal emoji's.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { personalStickers } from '../utils/personalEmoji/service';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import type { EmojiEntry } from '../utils/personalEmoji/library';

let snapshot: { entries: EmojiEntry[] } | null = null;
let wired = false;

function ensureWired(): void {
    if (wired) return;
    wired = true;
    personalStickers().subscribe(() => { snapshot = null; });
    // A backup restore writes the library straight to storage under a running app.
    try {
        window.addEventListener(BACKUP_RESTORED_EVENT, () => { personalStickers().notifyExternalChange(); });
    } catch { /* no window in tests */ }
}

function subscribe(cb: () => void): () => void {
    ensureWired();
    return personalStickers().subscribe(() => cb());
}

function getSnapshot(): { entries: EmojiEntry[] } {
    ensureWired();
    if (!snapshot) {
        snapshot = { entries: [...personalStickers().load().entries].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)) };
    }
    return snapshot;
}

export function usePersonalStickerLibrary(): EmojiEntry[] {
    return useSyncExternalStore(subscribe, getSnapshot).entries;
}

export function useIsInMyStickers(id: string | null | undefined): boolean {
    const entries = usePersonalStickerLibrary();
    return useMemo(() => !!id && entries.some(e => e.id === id), [entries, id]);
}
