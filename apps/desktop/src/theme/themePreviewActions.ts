/**
 * What the live-preview bar's buttons do (components/themeShare/ThemePreviewBar.tsx).
 * The preview itself lives in engine.ts, stores nothing and reverts by itself
 * after PREVIEW_REVERT_MS; these are the USER actions that do store something:
 *
 *   Keep          keepPreviewedTheme: makes the previewed theme the device's
 *                 theme the normal way (activeThemeMirror chooseBuiltinTheme /
 *                 chooseCustomTheme: main's store + the backup mirror), which
 *                 also ends the preview. A built-in uses chooseBuiltinTheme; a
 *                 library theme uses its entry (writing a pending edit first);
 *                 a shared theme not in the library is saved first.
 *   Save          savePreviewedTheme: the previewed theme goes into "Your
 *                 themes" (the library's own create: re-validated, unique name,
 *                 then synced and backed up like any theme) and the preview
 *                 KEEPS running. Used by Keep and by tests.
 */
import type { CustomThemeDef, StoredCustomTheme } from './customTheme';
import { createCustomTheme, readCustomThemes, updateCustomTheme } from './customThemeLibrary';
import { chooseBuiltinTheme, chooseCustomTheme } from './activeThemeMirror';
import { getThemePreview, markThemePreviewKept, type ThemePreviewState } from './engine';
import { sameThemeLook } from './themeLink';

const stripId = ({ id: _id, ...def }: StoredCustomTheme): CustomThemeDef => { void _id; return def; };

/** The library entry a custom preview corresponds to (its tile id, else the same look), or null. */
export function savedEntryFor(p: ThemePreviewState | null, items: readonly StoredCustomTheme[]): StoredCustomTheme | null {
    if (!p || !p.def) return null;
    const def = p.def;
    return (p.libraryId ? items.find((t) => t.id === p.libraryId) : undefined) ?? items.find((t) => sameThemeLook(t, def)) ?? null;
}

export type SavePreviewResult =
    | { ok: true; entry: StoredCustomTheme; created: boolean }
    | { ok: false };

/** Save: add the previewed custom theme to the library (once), keep previewing. */
export function savePreviewedTheme(uid: string | null | undefined): SavePreviewResult {
    const p = getThemePreview();
    if (!p || !p.def) return { ok: false };
    const already = savedEntryFor(p, readCustomThemes(uid));
    if (already) return { ok: true, entry: already, created: false };
    const entry = createCustomTheme(uid, p.def);
    return entry ? { ok: true, entry, created: true } : { ok: false };
}

/** Save and use: save (unless already saved), then make it the device's theme the normal way (ends the preview). */
export async function saveAndUsePreviewedTheme(uid: string | null | undefined): Promise<SavePreviewResult> {
    const r = savePreviewedTheme(uid);
    if (!r.ok) return r;
    markThemePreviewKept();
    await chooseCustomTheme(uid, r.entry.id, stripId(r.entry));
    return r;
}

export type KeepPreviewResult = { ok: true } | { ok: false };

/**
 * Keep: whatever is previewed becomes the device's theme. A refusal (no
 * account, library full / still loading for a theme that is not saved yet, a
 * pending edit whose entry is gone) changes nothing and the preview keeps
 * running, countdown included.
 */
export async function keepPreviewedTheme(uid: string | null | undefined): Promise<KeepPreviewResult> {
    const p = getThemePreview();
    if (!p) return { ok: false };
    if (p.builtin) {
        markThemePreviewKept();
        await chooseBuiltinTheme(uid, p.builtin);
        return { ok: true };
    }
    if (!p.def) return { ok: false };
    if (p.pendingEdit && p.libraryId) {
        if (!updateCustomTheme(uid, p.libraryId, p.def)) return { ok: false };
        markThemePreviewKept();
        await chooseCustomTheme(uid, p.libraryId, p.def);
        return { ok: true };
    }
    const r = await saveAndUsePreviewedTheme(uid);
    return r.ok ? { ok: true } : { ok: false };
}
