/**
 * The account-scoped MIRROR of which theme THIS device chose, kept only so an
 * encrypted backup can bring it back (owner requirement: themes differ per
 * device, but "restoring a backup brings back the theme templates AND the one
 * that was applied at the time").
 *
 * What it is NOT: the source of truth for what the device shows (that is main's
 * SecureStore `theme` / `themeCustom`, read before first paint) and never part
 * of the `themes` sync slot (utils/customThemeSync.ts only carries the library),
 * so sync can never switch a device's theme.
 *
 * Rules (secure_local_store_account_rebind, same as the library):
 *   - written ONLY from a user action (picking a theme, Save-and-use, import
 *     Save-and-use, Sync-with-system, deleting the theme in use), via
 *     chooseBuiltinTheme / chooseCustomTheme below - never on mount, hydrate,
 *     sync or restore;
 *   - never before the account's records are bound (a cold namespace would
 *     overwrite the real one);
 *   - every read re-validates (a backup or a crafted vault can carry anything).
 * The custom variant carries the theme's normalised DATA, so a restore works
 * even when the library entry is gone.
 */
import secureLocalStore from '../utils/secureLocalStore';
import { safeThemeId } from '../utils/customThemeSync';
import { isThemePreference, type ThemePreference } from './themes';
import { normalizeCustomTheme, type CustomThemeDef } from './customTheme';
import { setCustomTheme, setThemePreference, stopThemePreview } from './engine';

export const activeThemeMirrorKey = (uid: string) => `cipherline_active_theme_${uid}`;

export type ActiveThemeMirror =
    | { kind: 'builtin'; id: ThemePreference }
    | { kind: 'custom'; id: string; snapshot: CustomThemeDef };

/** A parsed mirror: a custom entry whose snapshot did not validate keeps its id (the restored library may still have it). */
export type ParsedActiveThemeMirror =
    | { kind: 'builtin'; id: ThemePreference }
    | { kind: 'custom'; id: string; snapshot: CustomThemeDef | null };

export function parseActiveThemeMirror(raw: string | null | undefined): ParsedActiveThemeMirror | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return null; }
    if (!v || typeof v !== 'object') return null;
    const o = v as { kind?: unknown; id?: unknown; snapshot?: unknown };
    if (o.kind === 'builtin') return isThemePreference(o.id) ? { kind: 'builtin', id: o.id } : null;
    if (o.kind === 'custom') {
        if (!safeThemeId(o.id)) return null;
        const r = normalizeCustomTheme(o.snapshot);
        return { kind: 'custom', id: o.id, snapshot: r.ok ? r.def : null };
    }
    return null;
}

export function readActiveThemeMirror(uid: string | null | undefined): ParsedActiveThemeMirror | null {
    if (!uid) return null;
    try { return parseActiveThemeMirror(secureLocalStore.getItem(activeThemeMirrorKey(uid))); } catch { return null; }
}

/** Write the mirror. Refuses on a cold account store. Returns whether it wrote. */
export function writeActiveThemeMirror(uid: string | null | undefined, m: ActiveThemeMirror): boolean {
    if (!uid || !secureLocalStore.isAccountReady(uid)) return false;
    try { secureLocalStore.setItem(activeThemeMirrorKey(uid), JSON.stringify(m)); return true; } catch { return false; }
}

/** USER action: use a built-in (or Sync with system) on this device and remember it for backups. Ends a live preview. */
export async function chooseBuiltinTheme(uid: string | null | undefined, pref: ThemePreference): Promise<void> {
    stopThemePreview();
    writeActiveThemeMirror(uid, { kind: 'builtin', id: pref });
    await setThemePreference(pref);
}

/** USER action: use a custom theme on this device and remember it (with a snapshot) for backups. Ends a live preview. */
export async function chooseCustomTheme(uid: string | null | undefined, id: string, def: CustomThemeDef): Promise<void> {
    stopThemePreview();
    const r = normalizeCustomTheme(def);
    if (r.ok) writeActiveThemeMirror(uid, { kind: 'custom', id, snapshot: r.def });
    await setCustomTheme(id, def);
}
