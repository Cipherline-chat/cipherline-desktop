/**
 * index.html's instant-first-paint backdrop reads its colours from the theme
 * data. index.html carries placeholders; vite.config.ts's `themeBootHtml`
 * plugin (dev server and build) fills them from the Dark and Light themes
 * before Vite does anything else with the page. Which one paints is decided by
 * `data-theme` on <html>, which the preload sets from the stored theme before
 * the page is parsed (electron/preload.ts bootThemeId).
 *
 * Pure string work, no DOM, no imports beyond the theme data, so the Vite
 * config can load it.
 */
import { DARK_THEME, LIGHT_THEME, THEMES, THEME_IDS, resolveTheme, type Theme } from './themes';

export const BOOT_PLACEHOLDERS = ['%CL_BOOT_TOP%', '%CL_BOOT_MID%', '%CL_BOOT_BOTTOM%'] as const;
export const BOOT_LIGHT_PLACEHOLDERS = ['%CL_BOOT_L_TOP%', '%CL_BOOT_L_MID%', '%CL_BOOT_L_BOTTOM%'] as const;
/** One `:root[data-theme="<id>"] #cl-boot{...}` rule per built-in theme beyond Dark and Light. */
export const BOOT_THEMES_PLACEHOLDER = '%CL_BOOT_THEMES%';

/** The boot backdrop rules for every built-in theme other than Dark (the default) and Light (its own placeholders). */
export function bootThemeRules(): string {
    return THEME_IDS.filter((id) => id !== DARK_THEME.id && id !== LIGHT_THEME.id).map((id) => {
        const [a, b, c] = THEMES[id].boot.gradient;
        return `:root[data-theme="${id}"] #cl-boot{background:linear-gradient(180deg,${a} 0%,${b} 45%,${c} 100%)}`;
    }).join('');
}

function fill(html: string, placeholders: readonly string[], gradient: readonly string[]): string {
    let out = html;
    placeholders.forEach((ph, i) => {
        if (!out.includes(ph)) throw new Error(`index.html is missing the theme boot placeholder ${ph}`);
        out = out.split(ph).join(gradient[i]);
    });
    return out;
}

/** Replace every boot placeholder: Dark's (or `theme`'s) gradient, then Light's when present, then the other themes' rules. */
export function fillBootHtml(html: string, theme: Theme = resolveTheme(undefined)): string {
    let out = fill(html, BOOT_PLACEHOLDERS, (theme ?? DARK_THEME).boot.gradient);
    if (out.includes(BOOT_LIGHT_PLACEHOLDERS[0])) out = fill(out, BOOT_LIGHT_PLACEHOLDERS, LIGHT_THEME.boot.gradient);
    return out.split(BOOT_THEMES_PLACEHOLDER).join(bootThemeRules());
}
