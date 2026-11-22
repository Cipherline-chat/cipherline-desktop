/**
 * Guard rails for the theme engine (plan slice T1):
 *   - the static CSS mirrors (index.css `:root`, cl-kit.css `:root`, the
 *     index.html boot backdrop) equal the theme data — the data is the source;
 *   - every `var(--cl-*)` used anywhere is defined: by the theme data, or as a
 *     non-colour design token / component-local variable somewhere in source;
 *   - no colour is defined in index.css `:root` outside the theme data;
 *   - theme tokens nothing uses are listed (UNUSED_THEME_TOKENS).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    ALPHA_TOKENS, DARK_THEME, EFFECT_TOKENS, KIT_TOKENS, LIGHT_THEME, PALETTE_TOKENS, SEMANTIC_TOKENS, TAILWIND_COLORS,
    DARK_ISLAND_SELECTORS, THEMES, THEME_IDS, THEME_PREFERENCES, hexToRgbChannels, themeClVariableNames, themeCssText, themeCssVariables,
    themeIdForPreference, resolveTheme,
} from './themes';
import { BOOT_LIGHT_PLACEHOLDERS, BOOT_PLACEHOLDERS, BOOT_THEMES_PLACEHOLDER, fillBootHtml } from './bootHtml';
import { lightShade, tailwindPaletteBase } from './tailwindPalette';
import { contrastRatio } from './contrast';

const DESKTOP = resolve(__dirname, '..', '..');
const SRC = join(DESKTOP, 'src');
const read = (p: string) => readFileSync(p, 'utf8');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(css|ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
}

/** Declarations of the FIRST `:root {` block of a stylesheet (custom properties only). */
function rootBlock(css: string): Record<string, string> {
    const start = css.search(/(^|\n):root\s*\{/);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
    return out;
}

const norm = (v: string) => v.replace(/\s+/g, '').toLowerCase();

describe('static CSS mirrors equal the theme data', () => {
    const index = rootBlock(read(join(SRC, 'index.css')));

    it('index.css :root palette / alpha / effect / semantic values', () => {
        const vars = themeCssVariables(DARK_THEME);
        const mismatches: string[] = [];
        const names = [
            ...PALETTE_TOKENS.map((t) => `--cl-${t}`),
            ...ALPHA_TOKENS.map((t) => `--cl-${t}`),
            ...EFFECT_TOKENS.map((t) => `--cl-${t}`),
            ...SEMANTIC_TOKENS.map((t) => `--${t}`),
        ];
        for (const n of names) if (norm(index[n] ?? 'MISSING') !== norm(vars[n])) mismatches.push(`${n}: css=${index[n]} data=${vars[n]}`);
        expect(mismatches).toEqual([]);
    });

    it('index.css :root defines no colour that is not a theme token', () => {
        const theme = new Set(Object.keys(themeCssVariables(DARK_THEME)));
        const colourish = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
        const strays = Object.entries(index).filter(([k, v]) => colourish.test(v) && !theme.has(k)).map(([k]) => k);
        expect(strays, 'move these into src/theme/themes.ts').toEqual([]);
    });

    it('index.css :root sets color-scheme to the theme scheme', () => {
        expect(read(join(SRC, 'index.css'))).toMatch(new RegExp(`:root\\s*\\{[^}]*color-scheme:\\s*${DARK_THEME.scheme};`));
    });

    it('cl-kit.css :root kit tokens', () => {
        const kit = rootBlock(read(join(SRC, 'styles', 'cl-kit.css')));
        // --faint: the desktop's Dark faint is #8591B5 since D3 (the engine writes it at runtime);
        // cl-kit.css is shared with apps/website, which keeps the kit's original #5E6B8F (and
        // re-declares --faint for its own light pages), so the static file is left alone.
        const KIT_PINNED: Partial<Record<string, string>> = { faint: '#5E6B8F' };
        const mismatches = KIT_TOKENS.filter((t) => norm(kit[`--${t}`] ?? '') !== norm(KIT_PINNED[t] ?? DARK_THEME.palette[DARK_THEME.kit[t]]));
        expect(mismatches).toEqual([]);
    });

    it('index.html boot backdrop is filled from boot.gradient (and equals the loading screen gradient)', () => {
        const html = read(join(DESKTOP, 'index.html'));
        for (const ph of BOOT_PLACEHOLDERS) expect(html).toContain(ph);
        const filled = fillBootHtml(html);
        expect(filled).toContain('background:linear-gradient(180deg,#131A30 0%,#0F1526 45%,#0B0F1E 100%)');
        expect(filled).not.toMatch(/%CL_BOOT_/);
        // .lo-root (styles/app-loading.css) paints the same backdrop once React is up.
        // A stop may be written as the token whose Dark value it is (the loading screen follows the theme).
        const lo = read(join(SRC, 'styles', 'app-loading.css'));
        const asToken = (c: string) => PALETTE_TOKENS.filter((t) => DARK_THEME.palette[t].toUpperCase() === c.toUpperCase()).map((t) => `var(--cl-${t})`);
        for (const c of DARK_THEME.boot.gradient) {
            expect([c, ...asToken(c)].some((form) => lo.toUpperCase().includes(form.toUpperCase())), `${c} missing from .lo-root`).toBe(true);
        }
        // Light: index.html carries Light's gradient too (painted when the preload marks <html data-theme="light">).
        for (const ph of BOOT_LIGHT_PLACEHOLDERS) expect(html).toContain(ph);
        expect(filled).toContain(`:root[data-theme="light"] #cl-boot{background:linear-gradient(180deg,${LIGHT_THEME.boot.gradient[0]} 0%`);
        expect(() => fillBootHtml('<div></div>')).toThrow(/placeholder/);
        // Every other built-in theme gets its own boot rule (Midnight / High contrast never flash navy).
        expect(html).toContain(BOOT_THEMES_PLACEHOLDER);
        for (const id of THEME_IDS.filter((i) => i !== 'dark' && i !== 'light')) {
            const g = THEMES[id].boot.gradient;
            expect(filled).toContain(`:root[data-theme="${id}"] #cl-boot{background:linear-gradient(180deg,${g[0]} 0%,${g[1]} 45%,${g[2]} 100%)}`);
        }
    });
});

describe('theme data shape', () => {
    it('palette colours are opaque #RRGGBB and derive -rgb channels', () => {
        for (const t of PALETTE_TOKENS) expect(DARK_THEME.palette[t]).toMatch(/^#[0-9A-F]{6}$/);
        expect(hexToRgbChannels('#25E0C8')).toBe('37 224 200');
        expect(themeCssVariables(DARK_THEME)['--cl-deep-rgb']).toBe('19 26 48');
    });

    it('every Tailwind colour name maps to a palette token (the long-standing class names, aliases included)', () => {
        const names = Object.keys(TAILWIND_COLORS).sort();
        expect(names).toEqual([
            'bubble-recv', 'bubble-send', 'cl-abyss', 'cl-border', 'cl-danger', 'cl-deep', 'cl-faint', 'cl-flash', 'cl-flash-deep',
            'cl-flash-press', 'cl-glow', 'cl-lume', 'cl-lume-deep', 'cl-lume-hi', 'cl-lume-press', 'cl-muted', 'cl-ok', 'cl-on-flash',
            'cl-on-lume', 'cl-raise', 'cl-sink', 'cl-surface', 'cl-text', 'flash', 'glow', 'online', 'page-bg', 'panel-bg', 'primary',
            'surface-elevated', 'surface-raised', 'text-body',
            // Light-theme slice
            'black', 'cl-border-strong', 'cl-bright', 'cl-danger-text', 'cl-flash-text', 'cl-glow-text', 'cl-info-text',
            'cl-lume-text', 'cl-lume-ui', 'cl-ok-text', 'cl-shade', 'pure-black', 'pure-white', 'white',
        ].sort());
        for (const t of Object.values(TAILWIND_COLORS)) expect(PALETTE_TOKENS).toContain(t);
        // Tailwind's own white / black follow the theme; pure-* never do.
        expect(TAILWIND_COLORS.white).toBe('bright');
        expect(TAILWIND_COLORS.black).toBe('shade');
        expect(LIGHT_THEME.palette['pure-white']).toBe(DARK_THEME.palette['pure-white']);
        expect(LIGHT_THEME.palette['pure-black']).toBe(DARK_THEME.palette['pure-black']);
    });

    it('Tailwind palette shades: Dark is Tailwind itself, Light a readable shade', () => {
        expect(tailwindPaletteBase()[':root']['--cl-tw-red-400']).toBe('248 113 113');
        expect(tailwindPaletteBase()[':root[data-scheme="light"]']['--cl-tw-red-400']).toBe('185 28 28');   // red-700
        expect(tailwindPaletteBase()[':root[data-scheme="light"]']['--cl-tw-gray-400']).toBe('75 85 99');   // gray-600 (mirrored)
        expect(lightShade('amber', '300')).toBe('700');
        expect(lightShade('slate', '900')).toBe('100');
        // Every light text shade of a chromatic hue clears 4.5:1 on the cream page.
        for (const hue of ['red', 'orange', 'amber', 'yellow', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'purple', 'pink', 'rose']) {
            const ch = tailwindPaletteBase()[':root[data-scheme="light"]'][`--cl-tw-${hue}-400`].split(' ').map(Number);
            const hex = '#' + ch.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
            expect(contrastRatio(hex, LIGHT_THEME.palette.abyss), `${hue}-400 in Light`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('tailwind.config.js builds its colours from the theme data, never literal hex', () => {
        const cfg = read(join(DESKTOP, 'tailwind.config.js'));
        expect(cfg).toMatch(/from '\.\/src\/theme\/themes\.ts'/);
        expect(cfg).toContain('rgb(var(--cl-${token}-rgb) / <alpha-value>)');
        const colours = cfg.slice(cfg.indexOf('colors:'), cfg.indexOf('fontFamily:'));
        expect(colours).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    });

    it('the engine rule targets :root[data-theme] and carries color-scheme', () => {
        const css = themeCssText(DARK_THEME);
        expect(css.startsWith(':root[data-theme="dark"]{')).toBe(true);
        expect(css).toContain('color-scheme:dark');
        expect(css).toContain('--cl-lume:#25E0C8');
        expect(css).toContain('--cl-lume-rgb:37 224 200');
        expect(css).toContain('--surface-page:var(--cl-abyss)');
        expect(css).toContain('--abyss:#0B0F1E');
    });

    it('unknown theme ids resolve to Dark; light resolves to Light', () => {
        expect(resolveTheme('light').id).toBe('light');
        expect(resolveTheme('LIGHT').id).toBe('dark');
        expect(resolveTheme('system').id).toBe('dark');
        expect(resolveTheme(undefined).id).toBe('dark');
        expect(resolveTheme({}).id).toBe('dark');
    });

    it('a preference resolves to a theme id; system follows the OS', () => {
        expect(themeIdForPreference('system', true)).toBe('dark');
        expect(themeIdForPreference('system', false)).toBe('light');
        // The OS asks for more contrast (Windows High Contrast / macOS Increase contrast).
        expect(themeIdForPreference('system', true, true)).toBe('hc-dark');
        expect(themeIdForPreference('system', false, true)).toBe('hc-light');
        expect(themeIdForPreference('midnight', false, true)).toBe('midnight');
        expect(themeIdForPreference('hc-light', true, false)).toBe('hc-light');
        expect(THEME_PREFERENCES).toEqual(['dark', 'light', 'midnight', 'hc-dark', 'hc-light', 'system']);
        expect(themeIdForPreference('light', true)).toBe('light');
        expect(themeIdForPreference('dark', false)).toBe('dark');
        expect(themeIdForPreference('nope', false)).toBe('dark');
    });

    it('Light defines every token and the new Dark tokens equal the colours they replace', () => {
        for (const t of PALETTE_TOKENS) expect(LIGHT_THEME.palette[t], t).toMatch(/^#[0-9A-F]{6}$/);
        // Each new role is an existing Dark colour, so swapping a literal for it never changes Dark.
        const d = DARK_THEME.palette;
        expect([d['lume-text'], d['lume-ui'], d['flash-text'], d['glow-text'], d['ok-text'], d['danger-text']])
            .toEqual([d.lume, d.lume, d.flash, d.glow, d.ok, d.danger]);
        expect([d.bright, d.shade, d['dot-hole']]).toEqual(['#FFFFFF', '#000000', '#000000']);
        expect([d['ok-dot'], d['idle-dot'], d['dnd-dot'], d['offline-dot']]).toEqual(['#4ADE80', '#FFC94D', '#FF6B5E', '#5E6B8F']);
    });

    it('every built-in theme defines every token, with its own id and a valid scheme', () => {
        for (const id of THEME_IDS) {
            const t = THEMES[id];
            expect(t.id).toBe(id);
            expect(['dark', 'light']).toContain(t.scheme);
            for (const k of PALETTE_TOKENS) expect(t.palette[k], `${id} ${k}`).toMatch(/^#[0-9A-F]{6}$/);
            for (const k of ALPHA_TOKENS) expect(t.alpha[k], `${id} ${k}`).toBeTruthy();
            for (const k of EFFECT_TOKENS) expect(t.effects[k], `${id} ${k}`).toBeTruthy();
            for (const k of SEMANTIC_TOKENS) expect(PALETTE_TOKENS).toContain(t.semantic[k]);
            for (const k of KIT_TOKENS) expect(PALETTE_TOKENS).toContain(t.kit[k]);
            for (const k of t.boot.gradient) expect(k).toMatch(/^#[0-9A-F]{6}$/);
            // Effects are box-shadow lists: `none` would break the lists they are appended to.
            for (const k of EFFECT_TOKENS) expect(t.effects[k], `${id} ${k}`).not.toBe('none');
        }
    });

    it('every theme but Dark re-declares the Dark tokens on the dark islands', () => {
        for (const id of THEME_IDS.filter((i) => i !== 'dark')) {
            const css = themeCssText(THEMES[id]);
            expect(css.startsWith(`:root[data-theme="${id}"]{`)).toBe(true);
            for (const s of DARK_ISLAND_SELECTORS) expect(css).toContain(`:root[data-theme="${id}"] ${s}`);
            expect(css.slice(css.indexOf('\n') + 1)).toContain('--cl-deep:#131A30');
        }
    });

    it('Light re-declares the Dark tokens on every dark island (D4), Dark emits no island rule', () => {
        const light = themeCssText(LIGHT_THEME);
        expect(light.startsWith(':root[data-theme="light"]{')).toBe(true);
        expect(light).toContain('color-scheme:light');
        for (const s of DARK_ISLAND_SELECTORS) expect(light).toContain(`:root[data-theme="light"] ${s}`);
        const island = light.slice(light.indexOf('\n') + 1);
        expect(island).toContain('--cl-deep:#131A30');
        expect(island).toContain('--surface-page:var(--cl-abyss)');
        expect(island).toContain('color-scheme:dark');
        expect(themeCssText(DARK_THEME)).not.toContain('\n');
    });
});

// ── Token coverage ─────────────────────────────────────────────────────────

const files = [...walk(SRC), join(DESKTOP, 'index.html')];
const used = new Map<string, string[]>(); // --cl-x -> files
const defined = new Set<string>();
const usesWithoutFallback = new Set<string>();
for (const f of files) {
    const text = read(f);
    const rel = f.slice(DESKTOP.length + 1);
    for (const m of text.matchAll(/var\(\s*(--cl-[a-z0-9-]+)\s*([,)])/gi)) {
        const list = used.get(m[1]) ?? [];
        if (!list.includes(rel)) list.push(rel);
        used.set(m[1], list);
        if (m[2] === ')') usesWithoutFallback.add(m[1]);
    }
    // CSS declarations and JS style keys / setProperty calls.
    for (const m of text.matchAll(/(?:^|[\s;{(])(--cl-[a-z0-9-]+)\s*:/gim)) defined.add(m[1]);
    for (const m of text.matchAll(/['"`](--cl-[a-z0-9-]+)['"`]/g)) defined.add(m[1]);
}
const themeNames = new Set(themeClVariableNames(DARK_THEME));

/**
 * `--cl-*` referenced but defined NOWHERE — each use must carry a fallback.
 * Deliberately NOT added to the theme data: defining them would change what
 * renders today (the fallback is what users see).
 */
const UNDEFINED_WITH_FALLBACK = ['--cl-font-sans', '--cl-warm', '--cl-warn'];

/** Theme tokens nothing references yet (may only shrink; a newly unused token fails). */
const UNUSED_THEME_TOKENS = [
    '--cl-on-glow-rgb', '--cl-shadow-press',
    // Light-theme slice: the dot / overlay / pure tokens are used through Tailwind classes or as
    // whole colours (statusDotColor), so their -rgb channels or plain forms have no reader yet.
    '--cl-dnd-dot-rgb', '--cl-dot-hole-rgb', '--cl-idle-dot-rgb', '--cl-offline-dot-rgb', '--cl-ok-dot-rgb',
    '--cl-overlay-hover', '--cl-overlay-press', '--cl-pure-black', '--cl-shade',
    '--cl-code-add-rgb', '--cl-code-del-rgb', '--cl-code-kw-rgb', '--cl-code-lit-rgb', '--cl-code-num-rgb', '--cl-code-str-rgb',
    '--cl-code-text-rgb', '--cl-code-type-rgb',
    // Keys' colours are whole colours (an SVG stroke / fill), never channels.
    '--cl-keys-alert-rgb', '--cl-keys-ink-rgb',
];

describe('every --cl-* variable used is defined', () => {
    it('referenced variables are theme tokens or defined somewhere in source', () => {
        // --cl-tw-<hue>-<shade>: Tailwind's palette channels, emitted by tailwind.config.js (src/theme/tailwindPalette.ts).
        const twPalette = new Set(Object.keys(tailwindPaletteBase()[':root']));
        const missing = [...used.keys()].filter((v) => !themeNames.has(v) && !defined.has(v) && !twPalette.has(v) && !UNDEFINED_WITH_FALLBACK.includes(v));
        expect(missing.map((v) => `${v} (${used.get(v)!.join(', ')})`), 'add it to src/theme/themes.ts or define it').toEqual([]);
    });

    it('the known-undefined variables are still undefined and every use has a fallback', () => {
        for (const v of UNDEFINED_WITH_FALLBACK) {
            expect(defined.has(v) || themeNames.has(v), `${v} is now defined — drop it from UNDEFINED_WITH_FALLBACK`).toBe(false);
            expect(usesWithoutFallback.has(v), `${v} is used without a fallback`).toBe(false);
        }
    });

    it('theme tokens nothing uses are listed (UNUSED_THEME_TOKENS may only shrink)', () => {
        // -rgb channels count as used through Tailwind's colour classes.
        const tailwindTokens = new Set(Object.values(TAILWIND_COLORS));
        const isUsed = (n: string) => {
            if (used.has(n)) return true;
            const rgb = /^--cl-(.+)-rgb$/.exec(n);
            return !!rgb && (tailwindTokens.has(rgb[1] as never) || used.has(`--cl-${rgb[1]}-rgb`));
        };
        const unused = [...themeNames].filter((n) => !isUsed(n)).sort();
        const newlyUnused = unused.filter((n) => !UNUSED_THEME_TOKENS.includes(n));
        expect(newlyUnused, 'a theme token lost its last use — remove it from usage on purpose or list it').toEqual([]);
        const nowUsed = UNUSED_THEME_TOKENS.filter((n) => !unused.includes(n));
        expect(nowUsed, 'now used — remove from UNUSED_THEME_TOKENS').toEqual([]);
    });
});
