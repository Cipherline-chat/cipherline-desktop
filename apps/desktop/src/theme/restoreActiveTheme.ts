/**
 * After a backup restore / device transfer: put the theme that was applied at
 * backup time on THIS device (and only this one: nothing is published, the
 * `themes` sync slot never carries the choice).
 *
 * Order: the restored library entry with the same id (it is at least as new as
 * the snapshot: sync edits update the library but not the mirror) -> the
 * mirror's own snapshot (the library entry may be gone) -> Dark. Each custom
 * def is re-validated through normalizeCustomTheme. A backup without the
 * mirror (older build) leaves the device's theme alone.
 */
import { setCustomTheme, setThemePreference } from './engine';
import { normalizeCustomTheme, type CustomThemeDef } from './customTheme';
import { readCustomThemes } from './customThemeLibrary';
import { readActiveThemeMirror, writeActiveThemeMirror } from './activeThemeMirror';
import { THEME_PREFERENCE_LABELS as BUILTIN_LABEL } from './themes';

let lastRestored: string | null = null;
/** The name to show in the restore summary ("Theme restored: <name>"); read once. */
export function takeRestoredThemeName(): string | null {
    const n = lastRestored;
    lastRestored = null;
    return n;
}

/** Returns the applied theme's display name, or null when the backup carries no theme choice. */
export async function applyRestoredActiveTheme(uid: string): Promise<string | null> {
    lastRestored = null;
    const m = readActiveThemeMirror(uid);
    if (!m) return null;
    if (m.kind === 'builtin') {
        await setThemePreference(m.id);
        return (lastRestored = BUILTIN_LABEL[m.id]);
    }
    const hit = readCustomThemes(uid).find((t) => t.id === m.id);
    let libDef: CustomThemeDef | null = null;
    if (hit) {
        const { id: _id, ...rest } = hit;
        void _id;
        const r = normalizeCustomTheme(rest);
        if (r.ok) libDef = r.def;
    }
    const def = libDef ?? m.snapshot;
    if (!def) {
        // Neither a library entry nor the snapshot is usable: Dark, and make the mirror say so.
        await setThemePreference('dark');
        writeActiveThemeMirror(uid, { kind: 'builtin', id: 'dark' });
        return (lastRestored = BUILTIN_LABEL.dark);
    }
    await setCustomTheme(m.id, def);
    return (lastRestored = def.name);
}
