import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { isUserCardStyleMode, normalizeCardStyle, type CardStyle, type UserCardStyleMode } from '@cipherline/shared';
import { secureLocalStore } from '../utils/secureLocalStore';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import {
    buildLocalState, cardStyleMetaKey, metaFromState, parseStyleMeta, serializeStyleMeta, stampLocalEdit, type LocalEditKind,
} from '../utils/cardStyleSync';

/**
 * Message card style preferences (packages/shared/card-style.ts).
 *
 *  - The reader's display mode, Appearance → Message styles: Show all /
 *    Without animation / Plain. A device display preference under a global
 *    key (like Home ambience), default "all".
 *  - "My styles": the sender's LIBRARY of named styles, per account
 *    (`_${userId}`). Styling is a deliberate, per-message act, so nothing
 *    here is ever applied by default. Only written on a user action, never
 *    on mount, and only once the account's encrypted records are bound
 *    (secureLocalStore isAccountReady), so a cold namespace can't overwrite
 *    a real library.
 *  - "Show plain" for single messages: remembered for the session only
 *    (memory), never persisted.
 *
 * All three are classified in services/backupRegistry.ts.
 */

const MODE_KEY = 'cipherline_message_styles_mode';
const MODE_CHANGED = 'cipherline:message-styles-mode-changed';
const LIBRARY_CHANGED = 'cipherline:card-style-library-changed';
/** The library changed under the UI (a sync pull adopted another device's state): re-read, do NOT publish. */
export const CARD_LIBRARY_CHANGED_EVENT = LIBRARY_CHANGED;
/** The USER saved / renamed / edited / deleted a style on this device (`detail.userId`): the sync hook publishes after this. */
export const CARD_STYLE_USER_EDIT_EVENT = 'cipherline:card-style-user-edit';

export function readMessageStylesMode(): UserCardStyleMode {
    try {
        const v = secureLocalStore.getItem(MODE_KEY);
        return isUserCardStyleMode(v) ? v : 'all';
    } catch {
        return 'all';
    }
}

export function useMessageStylesMode(): [UserCardStyleMode, (m: UserCardStyleMode) => void] {
    const [mode, setModeState] = useState<UserCardStyleMode>(readMessageStylesMode);
    useEffect(() => {
        const onChange = () => setModeState(readMessageStylesMode());
        window.addEventListener(MODE_CHANGED, onChange);
        window.addEventListener(BACKUP_RESTORED_EVENT, onChange);
        return () => {
            window.removeEventListener(MODE_CHANGED, onChange);
            window.removeEventListener(BACKUP_RESTORED_EVENT, onChange);
        };
    }, []);
    const setMode = useCallback((m: UserCardStyleMode) => {
        if (!isUserCardStyleMode(m)) return;
        try { secureLocalStore.setItem(MODE_KEY, m); } catch { /* non-fatal */ }
        setModeState(m);
        window.dispatchEvent(new CustomEvent(MODE_CHANGED));
    }, []);
    return [mode, setMode];
}

/** One entry in "My styles": a named, validated style. Never applied by itself. */
export interface LibraryCardStyle {
    id: string;
    name: string;
    style: CardStyle;
}

/** At most this many saved styles, and this long a name. */
export const CARD_LIBRARY_MAX = 24;
export const CARD_LIBRARY_NAME_MAX = 40;

export function readCardStyleLibrary(userId: string | null | undefined): LibraryCardStyle[] {
    if (!userId) return [];
    try {
        const raw = secureLocalStore.getItem(`cipherline_card_styles_${userId}`);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as { items?: unknown };
        if (!Array.isArray(parsed?.items)) return [];
        const out: LibraryCardStyle[] = [];
        for (const it of parsed.items.slice(0, CARD_LIBRARY_MAX)) {
            const e = it as { id?: unknown; name?: unknown; style?: unknown };
            // Re-validated on read: the local copy can come from a backup restore.
            const style = normalizeCardStyle(e?.style);
            if (typeof e?.id !== 'string' || typeof e?.name !== 'string' || !style) continue;
            out.push({ id: e.id.slice(0, 64), name: e.name.slice(0, CARD_LIBRARY_NAME_MAX), style });
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * Persist the library after a USER action and stamp it for sync (per-item
 * created/at, tombstone on delete; utils/cardStyleSync.ts). Library first, then
 * its stamps: a crash in between leaves an unstamped item, which sync treats as
 * old (it can only lose to a newer remote edit, never destroy anything).
 */
function writeLibrary(userId: string, items: LibraryCardStyle[], edit?: { kind: LocalEditKind; id: string }): boolean {
    if (!secureLocalStore.isAccountReady(userId)) return false;
    try {
        const before = readCardStyleLibrary(userId);
        secureLocalStore.setItem(`cipherline_card_styles_${userId}`, JSON.stringify({ v: 1, items: items.slice(0, CARD_LIBRARY_MAX) }));
        if (edit) {
            const now = Date.now();
            // Materialise legacy (unstamped) items first so an edit never reorders them.
            const meta0 = parseStyleMeta(secureLocalStore.getItem(cardStyleMetaKey(userId)), now);
            const meta1 = metaFromState(buildLocalState(before, meta0));
            secureLocalStore.setItem(cardStyleMetaKey(userId), serializeStyleMeta(stampLocalEdit(meta1, edit.kind, edit.id, now)));
        }
    } catch {
        return false;
    }
    window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED));
    if (edit) window.dispatchEvent(new CustomEvent(CARD_STYLE_USER_EDIT_EVENT, { detail: { userId } }));
    return true;
}

function newId(): string {
    try { return crypto.randomUUID(); } catch { return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
}

/**
 * "My styles": a per-account library of named styles. Saving, renaming and
 * deleting are explicit user actions; a style is only ever applied to the
 * message being written when the user picks it.
 */
export function useCardStyleLibrary(userId: string | null | undefined): {
    items: LibraryCardStyle[];
    save: (name: string, style: CardStyle) => LibraryCardStyle | null;
    update: (id: string, style: CardStyle) => boolean;
    rename: (id: string, name: string) => boolean;
    remove: (id: string) => boolean;
} {
    const [items, setItems] = useState<LibraryCardStyle[]>(() => readCardStyleLibrary(userId));
    useEffect(() => {
        let cancelled = false;
        const reload = () => { if (!cancelled) setItems(readCardStyleLibrary(userId)); };
        reload();
        // Right after a sign-in the account's records may still be cold.
        void secureLocalStore.whenAccountReady().catch(() => undefined).then(reload);
        window.addEventListener(LIBRARY_CHANGED, reload);
        window.addEventListener(BACKUP_RESTORED_EVENT, reload);
        return () => {
            cancelled = true;
            window.removeEventListener(LIBRARY_CHANGED, reload);
            window.removeEventListener(BACKUP_RESTORED_EVENT, reload);
        };
    }, [userId]);
    const commit = useCallback((next: LibraryCardStyle[], edit: { kind: LocalEditKind; id: string }): boolean => {
        if (!userId || !writeLibrary(userId, next, edit)) return false;
        setItems(next);
        return true;
    }, [userId]);
    const save = useCallback((name: string, style: CardStyle): LibraryCardStyle | null => {
        const s = normalizeCardStyle(style);
        const n = name.trim().slice(0, CARD_LIBRARY_NAME_MAX);
        const cur = readCardStyleLibrary(userId);
        if (!s || !n || cur.length >= CARD_LIBRARY_MAX) return null;
        const entry = { id: newId(), name: n, style: s };
        return commit([...cur, entry], { kind: 'create', id: entry.id }) ? entry : null;
    }, [userId, commit]);
    const update = useCallback((id: string, style: CardStyle): boolean => {
        const s = normalizeCardStyle(style);
        if (!s) return false;
        return commit(readCardStyleLibrary(userId).map(e => (e.id === id ? { ...e, style: s } : e)), { kind: 'edit', id });
    }, [userId, commit]);
    const rename = useCallback((id: string, name: string): boolean => {
        const n = name.trim().slice(0, CARD_LIBRARY_NAME_MAX);
        if (!n) return false;
        return commit(readCardStyleLibrary(userId).map(e => (e.id === id ? { ...e, name: n } : e)), { kind: 'edit', id });
    }, [userId, commit]);
    const remove = useCallback((id: string): boolean => commit(readCardStyleLibrary(userId).filter(e => e.id !== id), { kind: 'remove', id }), [userId, commit]);
    return { items, save, update, rename, remove };
}

// ── "Show plain" for one message, for this session ──────────────────────────

const plainIds = new Set<string>();
let plainVersion = 0;
const plainListeners = new Set<() => void>();

export function isShownPlain(id: string | null | undefined): boolean {
    return !!id && plainIds.has(id);
}

export function setShownPlain(id: string, plain: boolean): void {
    if (plain === plainIds.has(id)) return;
    if (plain) plainIds.add(id); else plainIds.delete(id);
    plainVersion++;
    for (const l of plainListeners) l();
}

/** Re-renders when any message's "Show plain" changes; returns a version number. */
export function useShownPlainVersion(): number {
    return useSyncExternalStore(
        (cb) => { plainListeners.add(cb); return () => { plainListeners.delete(cb); }; },
        () => plainVersion,
        () => plainVersion,
    );
}

/** Test seam: forget every "Show plain". */
export function __resetShownPlainForTests(): void {
    plainIds.clear();
    plainVersion++;
    for (const l of plainListeners) l();
}
