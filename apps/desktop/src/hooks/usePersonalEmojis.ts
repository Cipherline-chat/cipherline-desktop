/**
 * React bindings for My Emojis (utils/personalEmoji/service.ts).
 *
 *   usePersonalEmojiLibrary()  the user's emojis in display order, live
 *   usePersonalEmojiUrl(id)    a blob: URL for any personal emoji on this
 *                              device (own or received), or its loading /
 *                              missing state - re-resolves when the image
 *                              arrives later (a message's bytes land just after
 *                              its text renders)
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { personalEmojis } from '../utils/personalEmoji/service';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import { isPersonalEmojiId } from '../utils/personalEmoji/token';
import type { EmojiEntry } from '../utils/personalEmoji/library';

// useSyncExternalStore needs a stable snapshot between changes.
let libSnapshot: { entries: EmojiEntry[] } | null = null;
let libVersion = 0;
let wired = false;

function ensureWired(): void {
    if (wired) return;
    wired = true;
    personalEmojis().subscribe(() => { libSnapshot = null; libVersion++; });
    // A backup restore writes the library straight to storage under a running app.
    try {
        window.addEventListener(BACKUP_RESTORED_EVENT, () => { personalEmojis().notifyExternalChange(); });
    } catch { /* no window in tests */ }
}

function subscribeLib(cb: () => void): () => void {
    ensureWired();
    return personalEmojis().subscribe(() => cb());
}

function getLibSnapshot(): { entries: EmojiEntry[] } {
    ensureWired();
    if (!libSnapshot) {
        libSnapshot = { entries: [...personalEmojis().load().entries].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)) };
    }
    return libSnapshot;
}

export function usePersonalEmojiLibrary(): { entries: EmojiEntry[]; version: number } {
    const snap = useSyncExternalStore(subscribeLib, getLibSnapshot);
    return { entries: snap.entries, version: libVersion };
}

export type PersonalEmojiUrlState =
    | { status: 'loading'; url: null }
    | { status: 'ready'; url: string }
    | { status: 'missing'; url: null };

export function usePersonalEmojiUrl(id: string | null | undefined): PersonalEmojiUrlState {
    const store = personalEmojis().store;
    const valid = !!id && isPersonalEmojiId(id);
    // The async lookup's answer, tagged with the id it was for (so a stale
    // answer for a previous id is never shown). Only set from callbacks.
    const [resolved, setResolved] = useState<{ id: string; url: string | null } | null>(null);
    const [tick, setTick] = useState(0);

    const cached = valid ? store.peekUrl(id!) : null;

    useEffect(() => {
        if (!valid || store.peekUrl(id!)) return;
        let live = true;
        void store.getUrl(id!).then(url => { if (live) setResolved({ id: id!, url }); });
        return () => { live = false; };
    }, [id, valid, store, tick]);

    // The bytes of a just-received message are filed a moment AFTER its text
    // renders. Subscribe from mount (same commit as the first lookup) rather than
    // after that lookup misses, or a put landing in between would be missed.
    const waiting = valid && !cached;
    useEffect(() => {
        if (!waiting) return;
        return store.subscribe(changed => { if (changed === null || changed === id) setTick(t => t + 1); });
    }, [id, waiting, store]);

    if (!valid) return { status: 'missing', url: null };
    if (cached) return { status: 'ready', url: cached };
    if (resolved?.id === id) return resolved.url ? { status: 'ready', url: resolved.url } : { status: 'missing', url: null };
    return { status: 'loading', url: null };
}

/** Library lookup by id, memoised on the live library. */
export function useIsInMyEmojis(id: string | null | undefined): boolean {
    const { entries } = usePersonalEmojiLibrary();
    return useMemo(() => !!id && entries.some(e => e.id === id), [entries, id]);
}
