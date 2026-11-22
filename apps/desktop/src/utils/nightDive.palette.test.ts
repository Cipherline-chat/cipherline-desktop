import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DARK_THEME, type PaletteToken } from '../theme/themes';

/**
 * Night dive is BACKGROUND ONLY. These tests read the shipped stylesheets and
 * prove three things:
 *   1. no element token (panel, card, input, button, border, accent, text)
 *      is touched at night;
 *   2. every background it does touch is exactly the daylight value by day and
 *      strictly darker at night;
 *   3. text sitting directly on the darker backgrounds keeps >= 4.5:1, even in
 *      the worst case (the brightest point of the sea, under a light shaft
 *      and a mote, seen through the translucent view tint).
 * Contrast is WCAG 2.x relative luminance, computed from the CSS values
 * themselves so the numbers cannot drift from what ships.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const css = read('styles/night-dive.css');
const indexCss = read('index.css');
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

type RGBA = [number, number, number, number];
const parse = (c: string): RGBA => {
    c = c.trim();
    if (c.startsWith('#')) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
    const m = c.match(/rgba?\(([^)]+)\)/)!;
    const p = m[1].split(',').map(s => parseFloat(s));
    return [p[0], p[1], p[2], p[3] ?? 1];
};
/** `top` composited over an opaque `under`. */
const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
};
const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (c: RGBA) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a: RGBA, b: RGBA) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const day = (name: string) => indexCss.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`))![1];

/** Registered property → its initial (daylight) value. */
const registered: Record<string, string> = {};
for (const m of css.matchAll(/@property (--nd-[a-z0-9-]+)\s*\{[^}]*initial-value:\s*([^;]+);/g)) registered[m[1]] = m[2].trim();
/** Night value of an --nd-* property (first `--nd-x: value;` under a :root[data-depth="night"] rule). */
const night = (name: string) => {
    for (const rule of noComments(css).matchAll(/:root\[data-depth="night"\][^{]*\{([^}]*)\}/g)) {
        const m = rule[1].match(new RegExp(`${name}:\\s*([^;]+);`));
        if (m) return m[1].trim();
    }
    throw new Error(`no night value for ${name}`);
};

/* The sea, from the stylesheet. */
const seaStops = css.match(/\.nds-night \{[^}]*linear-gradient\(180deg, (#[0-9A-Fa-f]{6}) 0%, (#[0-9A-Fa-f]{6}) \d+%, (#[0-9A-Fa-f]{6}) 100%\)/)!.slice(1).map(parse);
const moonA = parse(css.match(/\.nds-moon \{[^}]*?(rgba\([^)]+\))/)![1]);
const shaftPeak = parse(css.match(/\.nds-shafts i \{[^}]*?transparent 0, (rgba\([^)]+\))/)![1]);
const motePeakOpacity = 0.4; // moteSpecs(): peak .22 … .40
const moteCore = parse(css.match(/\.nds-motes i \{[^}]*?radial-gradient\(circle, (rgba\([^)]+\))/)![1]);
/** The brightest point anywhere in the sea during the descent: top stop + moon
 *  glow + a light shaft + a mote, all at full strength. */
const seaWorst = (): RGBA => {
    let c = over(moonA, seaStops[0]);
    c = over(shaftPeak, c);
    c = over([moteCore[0], moteCore[1], moteCore[2], moteCore[3] * motePeakOpacity], c);
    return c;
};

const TEXT = parse(day('--cl-text'));
const MUTED = parse(day('--cl-muted'));
const FAINT = parse(day('--cl-faint'));

describe('night dive touches backgrounds only', () => {
    const ELEMENT_TOKENS = ['deep', 'surface', 'raise', 'border', 'sink', 'lume', 'lume-hi', 'lume-press', 'lume-deep', 'on-lume',
        'flash', 'flash-press', 'flash-deep', 'on-flash', 'glow', 'ok', 'danger', 'text', 'muted', 'faint'];
    it('never declares an element token (panels, cards, inputs, buttons, borders, accents, text)', () => {
        const decls = noComments(css);
        for (const t of ELEMENT_TOKENS) expect(decls, `--cl-${t}`).not.toMatch(new RegExp(`--cl-${t}\\s*:`));
        // nor the kit's own aliases of them
        for (const t of ['deep', 'surface', 'raise', 'border', 'lume', 'flash', 'glow', 'ok', 'text', 'muted', 'faint'])
            expect(decls, `--${t}`).not.toMatch(new RegExp(`(^|[\\s;{])--${t}\\s*:`, 'm'));
    });
    it('the page-background token is re-pointed only inside the rail (for the rings cut out of its water)', () => {
        const decls = noComments(css);
        const hits = [...decls.matchAll(/([^{}]*)\{[^}]*--cl-abyss\s*:/g)].map(m => m[1].trim().replace(/\s+/g, ' '));
        // Dark's rail water, and every other theme handing the rail its own page colour back.
        expect(hits).toEqual([
            '[data-layout="drift"] .app-rail',
            ':root:not([data-theme="dark"]) [data-layout="drift"] .app-rail, :root[data-custom-theme] [data-layout="drift"] .app-rail',
        ]);
        expect(decls).toMatch(/:root\[data-custom-theme\] \[data-layout="drift"\] \.app-rail \{\s*--cl-abyss: inherit;\s*\}/);
        expect(decls).not.toMatch(/:root\s*\{[^}]*--cl-abyss\s*:/);
    });
    it('registers nothing but its own --nd-* background properties', () => {
        const all = [...css.matchAll(/@property (--[a-z0-9-]+)/g)].map(m => m[1]);
        expect(all.length).toBeGreaterThan(8);
        for (const p of all) expect(p).toMatch(/^--nd-/);
    });
    // History: night dive v1 routed every cl-* utility through var(--cl-*) and re-pointed
    // the element tokens at night; v2 reverted that to plain hex so night darkens
    // backgrounds only. The theme engine (src/theme, claude/theme-engine) routes Tailwind
    // through the separate `--cl-*-rgb` channel variables instead. Night dive never
    // declares those, so a Tailwind class still paints its daylight value at night
    // (including inside the rail, where --cl-abyss itself IS re-pointed).
    it('Tailwind colours never follow night dive: they read --cl-*-rgb channels, which night-dive.css never declares', () => {
        const tw = readFileSync(join(SRC, '..', 'tailwind.config.js'), 'utf8');
        const colors = tw.slice(tw.indexOf('colors:'), tw.indexOf('fontFamily'));
        expect(colors).not.toMatch(/var\(--cl-[a-z-]+\)|tok\(/);
        expect(colors).toContain('rgb(var(--cl-${token}-rgb) / <alpha-value>)');
        expect(noComments(css)).not.toMatch(/--cl-[a-z-]+-rgb\s*:/);
        for (const t of ['abyss', 'deep', 'surface', 'raise', 'border', 'lume', 'flash', 'text', 'muted', 'faint'])
            expect(DARK_THEME.palette[t as PaletteToken].toUpperCase(), t).toBe(day(`--cl-${t}`).toUpperCase());
    });
});

describe('by day nothing changes', () => {
    it('every registered property starts at the exact daylight value it replaces', () => {
        expect(registered['--nd-bar']).toBe(day('--cl-abyss'));
        expect(registered['--nd-rail']).toBe(day('--cl-abyss'));
        expect(registered['--nd-friends']).toBe(day('--cl-abyss'));
        expect(registered['--nd-feed-bot']).toBe(day('--cl-abyss'));
        expect(registered['--nd-feed-top']).toBe(day('--cl-deep'));
        expect(registered['--nd-home']).toBe(day('--cl-deep'));
        expect(registered['--nd-sun']).toBe('1');
        const tint = read('styles/home-deck.css').match(/color-mix\(in oklab, var\(--cl-deep\) 94%, (#[0-9a-fA-F]{6})\)/)![1];
        expect(registered['--nd-home-tint'].toUpperCase()).toBe(tint.toUpperCase());
        // settings-descent.css spells the middle stop as the abyss token (value-identical in Dark).
        const stops = read('styles/settings-descent.css').match(/\.sd-sea-grad\{[^}]*linear-gradient\(180deg,\s*([^;]*)\);/)![1]
            .replace(/var\(--cl-abyss\)/g, day('--cl-abyss'))
            .match(/#[0-9A-Fa-f]{6}/g)!;
        expect([0, 1, 2, 3, 4].map(i => registered[`--nd-sea-${i}`].toUpperCase())).toEqual(stops.map(s => s.toUpperCase()));
    });
    const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase().replace(/(^|[^0-9])0\./g, '$1.');
    it('the Home deck background it re-declares is home-deck.css\'s, value for value (so a change there is not silently shadowed)', () => {
        const base = read('styles/home-deck.css').match(/\.hd-host \{[\s\S]*?background:([\s\S]*?);\s*background-color: var\(--cl-deep\);/)![1];
        const mine = css.match(/:root \.hd-host \{\s*background:([\s\S]*?);\s*background-color: var\(--nd-home\);/)![1]
            .replace(/calc\((\.\d+) \* var\(--nd-sun\)\)/g, '$1')
            .replace(/var\(--nd-home-tint\)/g, registered['--nd-home-tint'])
            .replace(/var\(--nd-home\)/g, 'var(--cl-deep)');
        expect(squash(mine)).toBe(squash(base));
    });
    it('the Settings water column it re-declares is settings-descent.css\'s, stop for stop', () => {
        const base = read('styles/settings-descent.css').match(/\.sd-sea-grad\{[^}]*background:(linear-gradient\([^;]*\));/)![1]
            .replace(/var\(--cl-abyss\)/g, day('--cl-abyss'));
        const mine = css.match(/:root \.sd-sea-grad \{\s*background: (linear-gradient\([^;]*\));/)![1]
            .replace(/var\((--nd-sea-\d)\)/g, (_, p) => registered[p]);
        expect(squash(mine)).toBe(squash(base));
        // and it keeps the descent's own transform transition
        expect(css).toMatch(/:root \.sd-sea-grad \{[^}]*transition:\s*transform 1100ms cubic-bezier\(\.45, \.05, \.2, 1\)/);
    });
    it('the chat feed reads the properties with the old gradient as its fallback', () => {
        expect(read('components/ChatPane.tsx')).toContain(
            "background: 'linear-gradient(180deg, var(--nd-feed-top, var(--cl-deep)) 0%, var(--nd-feed-bot, var(--cl-abyss)) 100%)'");
    });
    it('the sea layer\'s resting day look is the drift water exactly (abyss + the row\'s surface glow)', () => {
        expect(css).toMatch(new RegExp(`\\.nds \\{[^}]*background: ${day('--cl-abyss')};`));
        const drift = read('styles/layout-drift.css').match(/\.app-mainrow \{[^}]*background:\s*(radial-gradient\([^;]*?\)),\s*var\(--cl-abyss\);/)![1];
        const glow = css.match(/\.nds-dayglow \{[^}]*background: (radial-gradient\([^;]*\));/)![1];
        expect(squash(glow)).toBe(squash(drift));
    });
});

describe('every theme except plain Dark paints these backgrounds from its own tokens', () => {
    // 0.1.3-staging.257: the --nd-* properties start at Dark's navy and the
    // rules painted from them by day in EVERY theme, so Light kept a navy title
    // bar and chat feed behind its dark ink. The harnesses never loaded this
    // file, so only the real app showed it.
    const decls = noComments(css);
    const NOT_DARK = [':root:not([data-theme="dark"])', ':root[data-custom-theme]'];
    const rule = (target: string) => {
        const m = [...decls.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(r => {
            const sel = r[1].replace(/\s+/g, ' ').trim();
            return sel.includes(`${NOT_DARK[0]} ${target}`);
        });
        return m ? { sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] } : null;
    };
    it.each([
        ['[data-layout="drift"] > .drag-region', /background-color: var\(--cl-abyss\)/],
        ['.chat-pane-root', /background: linear-gradient\(180deg, var\(--cl-deep\) 0%, var\(--cl-abyss\) 100%\) !important/],
        ['.friends-pane-root', /background-color: var\(--cl-abyss\)/],
    ])('%s', (target, paint) => {
        const r = rule(target);
        expect(r, target).not.toBeNull();
        for (const p of NOT_DARK) expect(r!.sel).toContain(`${p} ${target}`);
        expect(r!.body).toMatch(paint);
        expect(r!.body).not.toMatch(/--nd-/);
    });
    it('Home in the other dark-scheme themes is home-deck.css\'s atmosphere on tokens (light-scheme keeps its flat page)', () => {
        const m = decls.match(/:root\[data-scheme="dark"\]:not\(\[data-theme="dark"\]\) \.hd-host,\s*:root\[data-scheme="dark"\]\[data-custom-theme\] \.hd-host \{([^}]*)\}/);
        expect(m).not.toBeNull();
        expect(m![1]).not.toMatch(/--nd-|#[0-9a-fA-F]{3,6}/);
        expect(m![1]).toMatch(/background-color: var\(--cl-deep\)/);
        expect(read('styles/home-deck.css')).toMatch(/:root\[data-scheme="light"\] \.hd-host \{ background: var\(--cl-abyss\); \}/);
    });
    it('none of these overrides can match plain Dark, and none touches an --nd-* property (no 5 s fade on a theme switch)', () => {
        const block = decls.slice(decls.indexOf(':root:not([data-theme="dark"]) [data-layout="drift"] > .drag-region'), decls.indexOf(':root[data-depth="night"]'));
        expect(block.length).toBeGreaterThan(200);
        expect(block).not.toMatch(/--nd-[a-z0-9-]+\s*:/);
        for (const sel of [...block.matchAll(/([^{}]+)\{/g)].map(m => m[1])) {
            for (const part of sel.split(',')) expect(part.trim(), part).toMatch(/^:root(:not\(\[data-theme="dark"\]\)|\[data-custom-theme\]|\[data-scheme="dark"\](:not\(\[data-theme="dark"\]\)|\[data-custom-theme\]))/);
        }
    });
    it('the theme harness loads every stylesheet the real renderer loads (so a harness can no longer hide a desktop-only rule)', () => {
        const imports = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^import '([^']+\.css)';/gm)].map(m => m[1].replace(/^(\.\.\/src\/|\.\/)/, ''));
        const app = imports(join(SRC, 'main.tsx'));
        const harness = imports(join(SRC, '..', 'harness', 'light-theme-main.tsx'));
        expect(app.length).toBeGreaterThan(8);
        for (const f of app) expect(harness, f).toContain(f);
    });
});

describe('at night the backgrounds are darker', () => {
    const SEA_MID = () => seaStops[1];
    const cases: [string, RGBA, RGBA][] = [
        ['title bar', parse(night('--nd-bar')), parse(registered['--nd-bar'])],
        ['rail water', parse(night('--nd-rail')), parse(registered['--nd-rail'])],
        ['feed top', over(parse(night('--nd-feed-top')), SEA_MID()), parse(registered['--nd-feed-top'])],
        ['feed bottom', over(parse(night('--nd-feed-bot')), SEA_MID()), parse(registered['--nd-feed-bot'])],
        ['friends', over(parse(night('--nd-friends')), SEA_MID()), parse(registered['--nd-friends'])],
        ['home', over(parse(night('--nd-home')), SEA_MID()), parse(registered['--nd-home'])],
        ...[0, 1, 2, 3, 4].map(i => [`settings sea ${i}`, parse(night(`--nd-sea-${i}`)), parse(registered[`--nd-sea-${i}`])] as [string, RGBA, RGBA]),
        // vs the daylight water at ITS brightest (abyss under the drift row's surface glow)
        ['open water (sea layer, top)', over(moonA, seaStops[0]), over([37, 224, 200, 0.05], parse(day('--cl-abyss')))],
    ];
    it.each(cases)('%s', (_n, n, d) => {
        expect(lum(n)).toBeLessThan(lum(d));
    });
    it('the views stay a shade above the open water, so the cards still read as cards', () => {
        for (const v of ['--nd-feed-top', '--nd-home'])
            expect(lum(over(parse(night(v)), SEA_MID())), v).toBeGreaterThan(lum(SEA_MID()));
    });
    it('the title bar matches the top of the sea it sits on (no seam)', () => {
        expect(ratio(parse(night('--nd-bar')), seaStops[0])).toBeLessThan(1.05);
    });
});

describe('contrast of text sitting directly on the night backgrounds', () => {
    const SURFACES: [string, RGBA][] = [
        ['feed top (brightest case)', over(parse(night('--nd-feed-top')), seaWorst())],
        ['feed bottom (brightest case)', over(parse(night('--nd-feed-bot')), seaWorst())],
        ['friends (brightest case)', over(parse(night('--nd-friends')), seaWorst())],
        ['home (brightest case)', over(parse(night('--nd-home')), seaWorst())],
        ['settings sea top', parse(night('--nd-sea-0'))],
        // (The open water between the cards carries no text: the rail's tiles and
        // badges are opaque elements with their own, unchanged fills.)
    ];
    it.each(SURFACES)('body + secondary text >= 4.5:1 on %s', (_n, bg) => {
        expect(ratio(TEXT, bg)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(MUTED, bg)).toBeGreaterThanOrEqual(4.5);
    });
    it('no text pair is less legible at night than by day (faint included)', () => {
        const pairs: [RGBA, RGBA][] = [
            [over(parse(night('--nd-feed-top')), seaStops[1]), parse(registered['--nd-feed-top'])],
            [over(parse(night('--nd-feed-bot')), seaStops[1]), parse(registered['--nd-feed-bot'])],
            [over(parse(night('--nd-friends')), seaStops[1]), parse(registered['--nd-friends'])],
        ];
        for (const [n, d] of pairs) for (const t of [TEXT, MUTED, FAINT]) expect(ratio(t, n)).toBeGreaterThanOrEqual(ratio(t, d));
    });
});
