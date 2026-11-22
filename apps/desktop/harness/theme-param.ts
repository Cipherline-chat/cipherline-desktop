/* eslint-disable -- visual harness, not shipped */
/**
 * Theme for ANY harness page (theme coverage audit, harness/theme-coverage-scan.mjs):
 * the scanner's vite plugin injects this module before the page's own entry, so
 * every existing harness scene renders in the theme named by the query string,
 * and harness/theme-param-css.ts (injected AFTER the entry, so the cascade order
 * matches src/main.tsx) adds the theme stylesheets.
 *
 *   ?theme=dark|light|midnight|hc-dark|hc-light   a built-in theme
 *   ?theme=custom-<preset key>                    a custom theme preset (ocean, forest, rose, mono)
 */
import * as engine from '../src/theme/engine';
import { CUSTOM_THEME_PRESETS } from '../src/theme/customPresets';

const theme = new URLSearchParams(location.search).get('theme') ?? 'dark';
const custom = /^custom-(.+)$/.exec(theme);
if (custom) {
    const preset = CUSTOM_THEME_PRESETS.find((p) => p.key === custom[1]);
    if (preset) void engine.setCustomTheme(`p-${preset.key}`, preset.def, {});
} else {
    void engine.setThemePreference(theme as never, {});
}
(window as any).__themeParam = theme;
// The harness pages paint <body> a literal navy (a stand-in for the app's
// ground): follow the theme instead, so a light theme is not judged on navy.
const paintBody = () => { document.body.style.background = 'var(--cl-abyss)'; };
if (document.body) paintBody(); else document.addEventListener('DOMContentLoaded', paintBody);
