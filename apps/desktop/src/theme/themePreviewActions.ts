/**
 * What the live-preview bar's buttons do (components/themeShare/ThemePreviewBar.tsx).
 * The preview itself lives in engine.ts and stores nothing; these are the
 * USER actions that do store something:
 *
 *   Save          the previewed theme goes into "Your themes" (the library's
 *                 own create: re-validated, unique name, then synced and backed
 *                 up like any theme) and the preview KEEPS running;
 *   Save and use  the same, then activeThemeMirror.chooseCustomTheme - the
 *                 normal way a theme becomes the device's theme (main's store +
 *                 the backup mirror) - which also ends the preview.
 */
import type { CustomThemeDef, StoredCustomTheme } from './customTheme';
import { createCustomTheme, readCustomThemes } from './customThemeLibrary';
import { chooseCustomTheme } from './activeThemeMirror';
import { getThemePreview, type ThemePreviewState } from './engine';
import { sameThemeLook } from './themeLink';

const stripId = ({ id: _id, ...def }: StoredCustomTheme): CustomThemeDef => { void _id; return def; };

/** The library entry a preview corresponds to (its tile id, else the same look), or null. */
export function savedEntryFor(p: ThemePreviewState | null, items: readonly StoredCustomTheme[]): StoredCustomTheme | null {
    if (!p) return null;
    return (p.libraryId ? items.find((t) => t.id === p.libraryId) : undefined) ?? items.find((t) => sameThemeLook(t, p.def)) ?? null;
}

export type SavePreviewResult =
    | { ok: true; entry: StoredCustomTheme; created: boolean }
    | { ok: false };

/** Save: add the previewed theme to the library (once), keep previewing. */
export function savePreviewedTheme(uid: string | null | undefined): SavePreviewResult {
    const p = getThemePreview();
    if (!p) return { ok: false };
    const already = savedEntryFor(p, readCustomThemes(uid));
    if (already) return { ok: true, entry: already, created: false };
    const entry = createCustomTheme(uid, p.def);
    return entry ? { ok: true, entry, created: true } : { ok: false };
}

/** Save and use: save (unless already saved), then make it the device's theme the normal way (ends the preview). */
export async function saveAndUsePreviewedTheme(uid: string | null | undefined): Promise<SavePreviewResult> {
    const r = savePreviewedTheme(uid);
    if (!r.ok) return r;
    await chooseCustomTheme(uid, r.entry.id, stripId(r.entry));
    return r;
}
