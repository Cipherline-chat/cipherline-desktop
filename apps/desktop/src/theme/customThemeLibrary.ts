/**
 * The custom theme LIBRARY (per account, encrypted at rest in
 * secureLocalStore, backed up — services/backupRegistry.ts — and synced across
 * the account's devices through the `themes` own-device slot,
 * hooks/useCustomThemeSync.ts).
 *
 * Rules (same as the "My styles" library, hooks/useCardStylePrefs.ts):
 *   - written ONLY on a user action (create / edit / duplicate / delete /
 *     import), never on mount;
 *   - never before the account's records are bound (secureLocalStore
 *     isAccountReady): a cold namespace reads as empty and must not overwrite
 *     a real library (secure_local_store_account_rebind);
 *   - every read re-validates each theme (customTheme.ts normalizeCustomTheme):
 *     the record can come from a backup restore or another device.
 *
 * Which theme THIS device shows is device-level (main's SecureStore, see
 * engine.setCustomTheme), not in here.
 */
import { useCallback, useEffect, useState } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import {
    THEME_LIBRARY_MAX, buildLocalThemeState, customThemeLibraryKey, customThemeMetaKey, parseThemeLibrary, parseThemeMeta,
    serializeThemeLibrary, serializeThemeMeta, stampThemeEdit, themeMetaFromState, type ThemeEditKind,
} from '../utils/customThemeSync';
import { cleanThemeName, normalizeCustomTheme, type CustomThemeDef, type StoredCustomTheme } from './customTheme';
import { writeActiveThemeMirror } from './activeThemeMirror';
import { getActiveCustomThemeId, getTheme, setCustomTheme, setThemePreference } from './engine';

/** The library changed under the UI (a sync pull, a restore): re-read, do NOT publish. */
export const CUSTOM_THEMES_CHANGED_EVENT = 'cipherline:custom-themes-changed';
/** The USER changed the library on this device (`detail.userId`): the sync hook publishes after this. */
export const CUSTOM_THEME_USER_EDIT_EVENT = 'cipherline:custom-theme-user-edit';

export function readCustomThemes(userId: string | null | undefined): StoredCustomTheme[] {
    if (!userId) return [];
    try { return parseThemeLibrary(secureLocalStore.getItem(customThemeLibraryKey(userId))); } catch { return []; }
}

function dispatch(name: string, detail?: unknown): void {
    try { window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail })); } catch { /* no window (tests) */ }
}

/** Library first, then its stamps (a crash in between leaves an unstamped item: sync treats it as old). */
function writeLibrary(userId: string, items: StoredCustomTheme[], edit: { kind: ThemeEditKind; id: string }): boolean {
    if (!secureLocalStore.isAccountReady(userId)) return false;
    try {
        const before = readCustomThemes(userId);
        secureLocalStore.setItem(customThemeLibraryKey(userId), serializeThemeLibrary(items));
        const now = Date.now();
        const meta0 = parseThemeMeta(secureLocalStore.getItem(customThemeMetaKey(userId)), now);
        const meta1 = themeMetaFromState(buildLocalThemeState(before, meta0));
        secureLocalStore.setItem(customThemeMetaKey(userId), serializeThemeMeta(stampThemeEdit(meta1, edit.kind, edit.id, now)));
    } catch {
        return false;
    }
    dispatch(CUSTOM_THEMES_CHANGED_EVENT);
    dispatch(CUSTOM_THEME_USER_EDIT_EVENT, { userId });
    return true;
}

function newId(): string {
    try { return crypto.randomUUID(); } catch { return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }
}

/** "Ocean" -> "Ocean 2" when taken. */
export function uniqueThemeName(name: string, taken: readonly string[]): string {
    const base = cleanThemeName(name) ?? 'My theme';
    const set = new Set(taken.map((n) => n.toLowerCase()));
    if (!set.has(base.toLowerCase())) return base;
    for (let i = 2; i < 100; i++) {
        const candidate = `${base.slice(0, 36)} ${i}`;
        if (!set.has(candidate.toLowerCase())) return candidate;
    }
    return base;
}

/**
 * Keep THIS device's active custom theme in step with the library: an edit
 * (here or synced from another device) re-applies the new COLOURS of the same
 * theme id (it is the same template). A theme that is MISSING from the library
 * is, by default, KEPT as this device's last copy: a delete on another device
 * (sync) or a restore must never silently switch what this device shows. Only
 * the user deleting the theme HERE passes `onMissing: 'builtin'` (and the
 * mirror is updated to match). Never writes the library.
 */
export function reconcileActiveCustomTheme(userId: string | null | undefined, opts: { onMissing?: 'keep' | 'builtin' } = {}): void {
    const activeId = getActiveCustomThemeId();
    if (!activeId || !userId || !secureLocalStore.isAccountReady(userId)) return;
    const items = readCustomThemes(userId);
    const hit = items.find((t) => t.id === activeId);
    if (!hit) {
        if (opts.onMissing === 'builtin') {
            const id = getTheme().id === 'light' ? 'light' : 'dark';
            writeActiveThemeMirror(userId, { kind: 'builtin', id });
            void setThemePreference(id);
        }
        return;
    }
    const { id, ...def } = hit;
    void setCustomTheme(id, def);
}

/** USER action: add a theme to the library (re-validated, unique name). Null when refused (cold store, full, invalid). */
export function createCustomTheme(userId: string | null | undefined, def: CustomThemeDef): StoredCustomTheme | null {
    if (!userId) return null;
    const r = normalizeCustomTheme(def);
    if (!r.ok) return null;
    const cur = readCustomThemes(userId);
    if (cur.length >= THEME_LIBRARY_MAX) return null;
    const entry: StoredCustomTheme = { id: newId(), ...r.def, name: uniqueThemeName(r.def.name, cur.map((t) => t.name)) };
    return writeLibrary(userId, [...cur, entry], { kind: 'create', id: entry.id }) ? entry : null;
}

/** USER action: replace a library theme's data (re-validated). False when refused (cold store, gone, invalid). */
export function updateCustomTheme(userId: string | null | undefined, id: string, def: CustomThemeDef): boolean {
    if (!userId) return false;
    const r = normalizeCustomTheme(def);
    if (!r.ok) return false;
    const cur = readCustomThemes(userId);
    if (!cur.some((t) => t.id === id)) return false;
    const ok = writeLibrary(userId, cur.map((t) => (t.id === id ? { id, ...r.def } : t)), { kind: 'edit', id });
    if (ok) reconcileActiveCustomTheme(userId);
    return ok;
}

export interface CustomThemeLibrary {
    items: StoredCustomTheme[];
    /** False until the account's records are readable (actions are refused meanwhile). */
    ready: boolean;
    full: boolean;
    create: (def: CustomThemeDef) => StoredCustomTheme | null;
    update: (id: string, def: CustomThemeDef) => boolean;
    duplicate: (id: string) => StoredCustomTheme | null;
    remove: (id: string) => boolean;
}

export function useCustomThemes(userId: string | null | undefined): CustomThemeLibrary {
    // The list for `userId`; re-seeded during render when the account changes (no setState in an effect).
    const [state, setState] = useState(() => ({ uid: userId ?? null, items: readCustomThemes(userId) }));
    if (state.uid !== (userId ?? null)) setState({ uid: userId ?? null, items: readCustomThemes(userId) });
    const items = state.uid === (userId ?? null) ? state.items : readCustomThemes(userId);
    // Bumped when the account's store becomes readable, so `ready` (read from the store) re-renders.
    const [, setReadyTick] = useState(0);
    const ready = !!userId && secureLocalStore.isAccountReady(userId);
    useEffect(() => {
        let cancelled = false;
        const reread = () => { if (!cancelled) setState({ uid: userId ?? null, items: readCustomThemes(userId) }); };
        if (userId && !secureLocalStore.isAccountReady(userId)) {
            void secureLocalStore.whenAccountReady().then(() => { if (!cancelled) { setReadyTick((n) => n + 1); reread(); } }, () => {});
        }
        window.addEventListener(CUSTOM_THEMES_CHANGED_EVENT, reread);
        window.addEventListener(BACKUP_RESTORED_EVENT, reread);
        return () => {
            cancelled = true;
            window.removeEventListener(CUSTOM_THEMES_CHANGED_EVENT, reread);
            window.removeEventListener(BACKUP_RESTORED_EVENT, reread);
        };
    }, [userId]);

    const create = useCallback((def: CustomThemeDef): StoredCustomTheme | null => createCustomTheme(userId, def), [userId]);

    const update = useCallback((id: string, def: CustomThemeDef): boolean => updateCustomTheme(userId, id, def), [userId]);

    const duplicate = useCallback((id: string): StoredCustomTheme | null => {
        const src = readCustomThemes(userId).find((t) => t.id === id);
        if (!src) return null;
        const { id: _drop, ...def } = src;
        void _drop;
        return create({ ...def, name: `${def.name.slice(0, 33)} copy` });
    }, [userId, create]);

    const remove = useCallback((id: string): boolean => {
        if (!userId) return false;
        const cur = readCustomThemes(userId);
        if (!cur.some((t) => t.id === id)) return false;
        const ok = writeLibrary(userId, cur.filter((t) => t.id !== id), { kind: 'remove', id });
        if (ok) reconcileActiveCustomTheme(userId, { onMissing: 'builtin' });
        return ok;
    }, [userId]);

    return { items, ready, full: items.length >= THEME_LIBRARY_MAX, create, update, duplicate, remove };
}
