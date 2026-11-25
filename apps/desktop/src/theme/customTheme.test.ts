import { describe, expect, it } from 'vitest';
import {
    ALPHA_TOKENS, DARK_THEME, EFFECT_TOKENS, LIGHT_THEME, PALETTE_TOKENS, THEMES, THEME_IDS, themeCssText, themeCssVariables,
} from './themes';
import { contrastRatio, relativeLuminance } from './contrast';
import {
    CUSTOM_THEME_JSON_MAX, CUSTOM_THEME_KNOBS, CUSTOM_THEME_SHARE_PREFIX,
    customBootPayload, customThemeFromBase, customThemeFromTheme, decodeShareCode, defFromBootPayload, deriveCustomTheme,
    encodeShareCode, knobsFromTheme, mixHex, normalizeCustomTheme, nudgeToContrast, parseThemeColor,
    parseThemeImport, themeFileJson, type CustomThemeColors, type CustomThemeDef,
} from './customTheme';
import { CUSTOM_THEME_PRESETS } from './customPresets';

const HEX = /^#[0-9a-f]{6}$/i;

/** Deterministic PRNG (mulberry32) for the fuzz cases. */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const randHex = (r: () => number) => '#' + Math.floor(r() * 0x1000000).toString(16).padStart(6, '0');

function def(over: Omit<Partial<CustomThemeDef>, 'colors'> & { colors?: Partial<CustomThemeDef['colors']> } = {}): CustomThemeDef {
    const b = customThemeFromBase(over.base ?? 'dark');
    return { ...b, ...over, colors: { ...b.colors, ...(over.colors ?? {}) } };
}

describe('derivation: a complete theme from nine knobs', () => {
    for (const base of ['dark', 'light'] as const) {
        it(`${base}: every palette / alpha / effect token is present and well-formed`, () => {
            const t = deriveCustomTheme(def({ base, colors: { accent: '#ff8800', bg: base === 'dark' ? '#101820' : '#fbfaf5' } }), 'abc');
            for (const tok of PALETTE_TOKENS) expect(t.palette[tok], tok).toMatch(HEX);
            for (const tok of ALPHA_TOKENS) expect(typeof t.alpha[tok], tok).toBe('string');
            for (const tok of EFFECT_TOKENS) expect(t.effects[tok].length, tok).toBeGreaterThan(0);
            expect(t.id).toBe(base);
            expect(t.customId).toBe('abc');
            expect(t.scheme).toBe(base);
            // The CSS the engine writes has every variable a built-in has (+ the light extras).
            const builtIn = Object.keys(themeCssVariables(base === 'dark' ? DARK_THEME : LIGHT_THEME));
            const custom = Object.keys(themeCssVariables(t));
            for (const k of builtIn) expect(custom).toContain(k);
            if (base === 'light') expect(custom).toContain('--lt-line');
        });
    }

    it('the knobs land on their tokens; derived tokens follow them (hover, tints, rgb channels)', () => {
        const t = deriveCustomTheme(def({ colors: { bg: '#05070a', panel: '#0a0f14', surface: '#111a22', accent: '#22aaff' } }));
        expect(t.palette.abyss).toBe('#05070a');
        expect(t.palette.deep).toBe('#0a0f14');
        expect(t.palette.lume).toBe('#22aaff');
        expect(t.alpha['lume-tint']).toBe('rgba(34,170,255,0.12)');
        expect(themeCssVariables(t)['--cl-lume-rgb']).toBe('34 170 255');
        // hover sits between the inset and the text
        expect(relativeLuminance(t.palette.raise)).toBeGreaterThan(relativeLuminance(t.palette.surface));
        expect(t.effects['glow-lume']).toContain('rgba(34,170,255,');
    });

    it('starting from a built-in reproduces its knob colours exactly', () => {
        for (const b of [DARK_THEME, LIGHT_THEME]) {
            const t = deriveCustomTheme(customThemeFromBase(b.id as 'dark' | 'light'));
            const k = knobsFromTheme(b);
            expect(t.palette.abyss).toBe(k.bg);
            expect(t.palette.text).toBe(k.text);
            expect(t.palette.lume).toBe(k.accent);
            expect(t.palette['on-lume']).toBe(k.onAccent);
        }
    });

    it('glow on/off changes only the accent glows', () => {
        const on = deriveCustomTheme(def({ glow: true }));
        const off = deriveCustomTheme(def({ glow: false }));
        expect(on.effects['glow-lume']).toMatch(/^0 0 14px rgba\(/);
        expect(off.effects['glow-lume']).not.toBe(on.effects['glow-lume']);
        expect(off.palette).toEqual(on.palette);
    });

    it('light custom themes re-tint the warm shadows from their own ground', () => {
        const t = deriveCustomTheme(def({ base: 'light', colors: { bg: '#f2f7ff', panel: '#ffffff', surface: '#e8eefa' } }));
        expect(t.effects['shadow-card']).not.toContain('rgba(60,44,20,');
        expect(t.effects['shadow-card']).not.toContain('rgba(92,64,24,');
    });

    it('the CSS rule is scoped to base + data-custom-theme and dark islands keep Dark', () => {
        const css = themeCssText(deriveCustomTheme(def({ colors: { bg: '#020304' } }), 'x1'));
        expect(css.startsWith(':root[data-theme="dark"][data-custom-theme]{')).toBe(true);
        expect(css).toContain(':root[data-theme="dark"][data-custom-theme] .pcd');
        expect(css).toContain(`--cl-abyss:${DARK_THEME.palette.abyss}`); // the island re-declaration
        // Built-in Dark is untouched by all of this.
        expect(themeCssText(DARK_THEME).startsWith(':root[data-theme="dark"]{')).toBe(true);
        expect(themeCssText(DARK_THEME)).not.toContain('.pcd');
    });

    it('security colours keep the base hue (verified stays green, compromised red)', () => {
        const t = deriveCustomTheme(normOk(def({ colors: { accent: '#ff0000', danger: '#00ff00', panel: '#1a1a40' } })));
        const hueOf = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return r > g && r > b ? 'r' : g > r && g > b ? 'g' : 'b'; };
        expect(hueOf(t.palette['ok-text'])).toBe('g');
        expect(hueOf(t.palette['flash-text'])).toBe('r');
    });
});

function normOk(input: unknown): CustomThemeDef {
    const r = normalizeCustomTheme(input);
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    return r.def;
}

describe('validation: data only', () => {
    it('accepts hex / rgb() / hsl() and stores opaque lowercase hex', () => {
        expect(parseThemeColor('#ABC')).toBe('#aabbcc');
        expect(parseThemeColor('rgb(255, 0, 0)')).toBe('#ff0000');
        expect(parseThemeColor('hsl(120 100% 50%)')).toBe('#00ff00');
        expect(parseThemeColor('#ff000080')).toBe('#ff0000'); // alpha dropped
    });

    it.each([
        'url(https://evil.example/x.png)', 'var(--cl-lume)', 'theme(accent)', 'expression(alert(1))', 'red;background:url(x)',
        'linear-gradient(red, blue)', 'javascript:alert(1)', '', '#ggg', '#12345', 'rgb(1,2)', 'K', 42, null, {},
        '#fff}body{display:none', 'attr(data-x)', 'calc(1px)', 'rgb(var(--x))',
    ])('rejects %j', (bad) => {
        expect(parseThemeColor(bad)).toBeNull();
        const r = normalizeCustomTheme({ v: 1, base: 'dark', colors: { accent: bad } });
        expect(r.ok).toBe(false);
    });

    it('rejects wrong shapes, versions and bases; caps the size', () => {
        expect(normalizeCustomTheme(null)).toMatchObject({ ok: false, error: 'not-an-object' });
        expect(normalizeCustomTheme([])).toMatchObject({ ok: false, error: 'not-an-object' });
        expect(normalizeCustomTheme({ v: 2, base: 'dark' })).toMatchObject({ ok: false, error: 'bad-version' });
        expect(normalizeCustomTheme({ v: 1, base: 'sepia' })).toMatchObject({ ok: false, error: 'bad-base' });
        expect(normalizeCustomTheme({ v: 1, base: 'dark', colors: [] })).toMatchObject({ ok: false, error: 'bad-colour' });
        expect(normalizeCustomTheme({ v: 1, base: 'dark', kind: 'something-else' })).toMatchObject({ ok: false });
        const big = { v: 1, base: 'dark', name: 'x', pad: 'y'.repeat(CUSTOM_THEME_JSON_MAX) };
        expect(normalizeCustomTheme(big)).toMatchObject({ ok: false, error: 'too-large' });
    });

    it('cleans the name: control / bidi characters out, whitespace collapsed, capped at 40', () => {
        expect(normalizeCustomTheme({ v: 1, base: 'dark', name: '  Ocean‮\u0000  night  ' })).toMatchObject({ ok: true, def: { name: 'Ocean night' } });
        const long = normOk({ v: 1, base: 'dark', name: 'é'.repeat(80) });
        expect(Array.from(long.name)).toHaveLength(40);
        expect(normOk({ v: 1, base: 'light', name: '   ' }).name).toBe('My theme');
    });

    it('fills missing knobs from the base and ignores unknown keys (no CSS can ride along)', () => {
        const d = normOk({ v: 1, base: 'light', colors: { accent: '#0a6b60', css: 'body{}' }, css: '* { color: red }', style: 'x' });
        expect(Object.keys(d.colors).sort()).toEqual([...CUSTOM_THEME_KNOBS].sort());
        expect(d.colors.bg).toBe(LIGHT_THEME.palette.abyss.toLowerCase());
        expect(JSON.stringify(d)).not.toContain('{}');
        expect(JSON.stringify(d)).not.toContain('color: red');
    });
});

/**
 * Owner, 2026-11-23: "make it so for themes they don't automatically adjust
 * colors to improve contrast. let people do whatever they want". A custom
 * theme renders EXACTLY the colours the person picked: no nudge, no ground
 * clamp, no refusal, no "adjusted" report — and the tokens derived from the
 * picks are plain mixes / aliases of them.
 */
/** Deliberately awful: grey-on-grey text, invisible secondary text, label = accent. */
const LOW_DARK: CustomThemeColors = {
    bg: '#101010', panel: '#141414', surface: '#1c1c1c', text: '#2a2a2a', muted: '#202020',
    accent: '#181818', onAccent: '#1a1a1a', danger: '#151515', border: '#141414',
};
/** A "dark" theme with white grounds and white text: the old guard clamped the grounds dark and moved the text. */
const LOW_LIGHT_ON_DARK_BASE: CustomThemeColors = {
    bg: '#ffffff', panel: '#fefefe', surface: '#fdfdfd', text: '#ffffff', muted: '#f8f8f8',
    accent: '#ffffe0', onAccent: '#ffffff', danger: '#fff0f0', border: '#ffffff',
};
/** A light theme with near-black grounds and black text. */
const LOW_DARK_ON_LIGHT_BASE: CustomThemeColors = {
    bg: '#000000', panel: '#050505', surface: '#0a0a0a', text: '#000000', muted: '#030303',
    accent: '#0b0b0b', onAccent: '#000000', danger: '#100000', border: '#000000',
};
const LOW_CASES = [
    ['dark base, grey on grey', 'dark', LOW_DARK],
    ['dark base, white on white', 'dark', LOW_LIGHT_ON_DARK_BASE],
    ['light base, black on black', 'light', LOW_DARK_ON_LIGHT_BASE],
    ['light base, grey on grey', 'light', LOW_DARK],
] as const;

describe('your colours, exactly as picked (no contrast adjustment)', () => {
    it('positive control: the test themes really are unreadable', () => {
        expect(contrastRatio(LOW_DARK.text, LOW_DARK.panel)).toBeLessThan(1.5);
        expect(contrastRatio(LOW_DARK.muted, LOW_DARK.panel)).toBeLessThan(1.5);
        expect(contrastRatio(LOW_DARK.onAccent, LOW_DARK.accent)).toBeLessThan(1.5);
        expect(contrastRatio(LOW_LIGHT_ON_DARK_BASE.text, LOW_LIGHT_ON_DARK_BASE.panel)).toBeLessThan(1.1);
        expect(contrastRatio(LOW_DARK_ON_LIGHT_BASE.text, LOW_DARK_ON_LIGHT_BASE.panel)).toBeLessThan(1.1);
        // ...and the nudge still exists (it serves the NON-pick tokens): it WOULD have moved these.
        expect(nudgeToContrast(LOW_DARK.text, [LOW_DARK.panel], 4.5)).not.toBe(LOW_DARK.text);
    });

    it.each(LOW_CASES)('%s: normalise keeps every colour and reports nothing', (_n, base, colors) => {
        const r = normalizeCustomTheme({ v: 1, name: 'Low', base, colors, glow: false });
        expect(r).toEqual({ ok: true, def: { v: 1, name: 'Low', base, colors, glow: false } });
        expect(r).not.toHaveProperty('adjustments');
    });

    it.each(LOW_CASES)('%s: every knob lands on its token unchanged', (_n, base, colors) => {
        const t = deriveCustomTheme(normOk({ v: 1, base, colors }));
        const p = t.palette;
        expect(p.abyss).toBe(colors.bg);
        expect(p.deep).toBe(colors.panel);
        expect(p.surface).toBe(colors.surface);
        expect(p.text).toBe(colors.text);
        expect(p.bright).toBe(colors.text);
        expect(p['code-text']).toBe(colors.text);
        expect(p.muted).toBe(colors.muted);
        expect(p.lume).toBe(colors.accent);
        expect(p['on-lume']).toBe(colors.onAccent);
        expect(p.danger).toBe(colors.danger);
        expect(p.border).toBe(colors.border);
    });

    it.each(LOW_CASES)('%s: tokens derived from the picks are plain mixes / aliases, never nudged', (_n, base, colors) => {
        const t = deriveCustomTheme(normOk({ v: 1, base, colors }));
        const p = t.palette;
        expect(p.faint).toBe(mixHex(colors.muted, colors.panel, 0.22));
        expect(p['border-strong']).toBe(colors.border);
        expect(p['lume-text']).toBe(colors.accent);
        expect(p['lume-ui']).toBe(colors.accent);
        expect(p['danger-text']).toBe(colors.danger);
        if (base === 'light') {
            expect(p['lume-deep']).toBe(colors.accent);
            expect(t.extra?.['--lt-mint-ink']).toBe(colors.accent);
            expect(t.extra?.['--lt-mint']).toBe(mixHex(colors.accent, colors.panel, 0.88));
        }
    });

    it('grounds are not pushed into a dark / light band', () => {
        const d = normOk({ v: 1, base: 'dark', colors: { bg: '#ffffff', panel: '#eeeeee', surface: '#dddddd' } });
        expect([d.colors.bg, d.colors.panel, d.colors.surface]).toEqual(['#ffffff', '#eeeeee', '#dddddd']);
        const l = normOk({ v: 1, base: 'light', colors: { bg: '#000000', panel: '#111111', surface: '#222222' } });
        expect([l.colors.bg, l.colors.panel, l.colors.surface]).toEqual(['#000000', '#111111', '#222222']);
    });

    it('is idempotent: a normalised theme normalises to itself', () => {
        const once = normOk({ v: 1, base: 'light', colors: { text: '#dddddd', muted: '#eeeeee', onAccent: '#25e0c8' } });
        expect(once.colors.text).toBe('#dddddd');
        expect(normalizeCustomTheme(once)).toEqual({ ok: true, def: once });
    });

    // Its own budget so a loaded box (several sessions running suites) reports a real failure, never a 5 s timeout.
    it('fuzz: 300 random themes on both bases are all accepted with their colours unchanged', { timeout: 60_000 }, () => {
        const r = rng(20261123);
        for (let i = 0; i < 300; i++) {
            const colors = Object.fromEntries(CUSTOM_THEME_KNOBS.map(k => [k, randHex(r)])) as CustomThemeColors;
            const base = r() < 0.5 ? 'dark' : 'light';
            const res = normalizeCustomTheme({ v: 1, base, colors, glow: r() < 0.5 });
            expect(res.ok, JSON.stringify(colors)).toBe(true);
            if (!res.ok) continue;
            expect(res.def.colors, `${base} ${JSON.stringify(colors)}`).toEqual(colors);
            const p = deriveCustomTheme(res.def).palette;
            expect([p.text, p.muted, p['on-lume'], p['lume-text'], p['danger-text'], p['border-strong']])
                .toEqual([colors.text, colors.muted, colors.onAccent, colors.accent, colors.danger, colors.border]);
        }
    });

    it('a low-contrast theme survives a share code, a file and the device boot copy unchanged', () => {
        const d = normOk({ v: 1, name: 'Fog', base: 'dark', colors: LOW_DARK, glow: false });
        expect(decodeShareCode(encodeShareCode(d))).toEqual({ ok: true, def: d });
        expect(parseThemeImport(themeFileJson(d))).toEqual({ ok: true, def: d });
        const back = defFromBootPayload(JSON.parse(JSON.stringify(customBootPayload('fog-1', d))));
        expect(back?.def.colors).toEqual(LOW_DARK);
        expect(customBootPayload('fog-1', d).boot.text).toBe(LOW_DARK.text.toUpperCase());
        expect(customBootPayload('fog-1', d).boot.faint).toBe(mixHex(LOW_DARK.muted, LOW_DARK.panel, 0.22).toUpperCase());
    });

    it('presets are accepted exactly as written', () => {
        for (const p of CUSTOM_THEME_PRESETS) expect(normalizeCustomTheme(p.def), p.key).toEqual({ ok: true, def: p.def });
    });

    it('nudgeToContrast (used only for the non-pick status / code colours) keeps a passing colour and moves a failing one the shortest way', () => {
        expect(nudgeToContrast('#ffffff', ['#000000'], 4.5)).toBe('#ffffff');
        const n = nudgeToContrast('#3355ff', ['#0b0f1e'], 4.5);
        expect(contrastRatio(n, '#0b0f1e')).toBeGreaterThanOrEqual(4.5);
        expect(relativeLuminance(n)).toBeGreaterThan(relativeLuminance('#3355ff'));
    });
});

describe('NOT the person\'s colours: trust / status / code colours stay visible on their grounds', () => {
    it.each(LOW_CASES)('%s: verified / warning / compromised / info text and presence dots are moved for contrast', (_n, base, colors) => {
        const p = deriveCustomTheme(normOk({ v: 1, base, colors })).palette;
        // Each one is nudged against the person's grounds (bg/panel/surface for text, bg/panel for dots).
        for (const t of ['flash-text', 'glow-text', 'ok-text', 'info-text'] as const) {
            expect(p[t], t).toBe(nudgeToContrast((base === 'dark' ? DARK_THEME : LIGHT_THEME).palette[t], [colors.bg, colors.panel, colors.surface], 4.5));
            expect(contrastRatio(p[t], colors.panel), t).toBeGreaterThanOrEqual(4.5);
        }
        for (const t of ['ok-dot', 'idle-dot', 'dnd-dot'] as const) expect(contrastRatio(p[t], colors.panel), t).toBeGreaterThanOrEqual(3);
    });
});

describe('sharing: codes and files', () => {
    const ocean = CUSTOM_THEME_PRESETS.find(p => p.key === 'ocean')!.def;

    it('a share code round-trips exactly (unicode names included)', () => {
        const d = normOk({ ...ocean, name: 'Océan 🌊 night' });
        const code = encodeShareCode(d);
        expect(code.startsWith(CUSTOM_THEME_SHARE_PREFIX)).toBe(true);
        expect(code).toMatch(/^clth1\.[A-Za-z0-9_-]+$/);
        expect(decodeShareCode(code)).toEqual({ ok: true, def: d });
        expect(decodeShareCode(`  ${code}\n`)).toMatchObject({ ok: true });
    });

    it('a file round-trips through parseThemeImport, and so does a pasted code', () => {
        const d = normOk(ocean);
        expect(parseThemeImport(themeFileJson(d))).toEqual({ ok: true, def: d });
        expect(parseThemeImport(encodeShareCode(d))).toMatchObject({ ok: true, def: d });
    });

    it('refuses bad codes: wrong prefix, non-base64url, bad JSON, CSS inside, oversize', () => {
        expect(decodeShareCode('clth2.abc')).toMatchObject({ ok: false, error: 'bad-code' });
        expect(decodeShareCode('clth1.@@@')).toMatchObject({ ok: false, error: 'bad-code' });
        expect(decodeShareCode('clth1.' + btoa('not json'))).toMatchObject({ ok: false });
        const evil = 'clth1.' + btoa(JSON.stringify({ v: 1, base: 'dark', colors: { bg: 'url(https://x.example/beacon)' } })).replace(/=+$/, '');
        expect(decodeShareCode(evil)).toMatchObject({ ok: false, error: 'bad-colour' });
        expect(decodeShareCode('clth1.' + 'A'.repeat(5000))).toMatchObject({ ok: false, error: 'too-large' });
        expect(parseThemeImport('<script>')).toMatchObject({ ok: false });
    });
});

describe('device boot payload', () => {
    it('carries colours + boot palette, never the name, and reads back', () => {
        const d = normOk({ ...customThemeFromBase('light'), name: 'Secret name' });
        const p = customBootPayload('t-1', d);
        expect(JSON.stringify(p)).not.toContain('Secret');
        expect(p.boot.windowBackground).toBe(d.colors.bg.toUpperCase());
        expect(p.boot.gradient).toHaveLength(3);
        const back = defFromBootPayload(JSON.parse(JSON.stringify(p)));
        expect(back?.id).toBe('t-1');
        expect(back?.def.colors).toEqual(d.colors);
        expect(defFromBootPayload({ ...p, id: '../x' })).toBeNull();
        expect(defFromBootPayload({ ...p, theme: { ...p.theme, colors: { ...p.theme.colors, bg: 'url(x)' } } })).toBeNull();
    });
});

describe('custom themes next to Midnight / High contrast (themes-merge)', () => {
    const keysOf = (t: ReturnType<typeof deriveCustomTheme>) => ({
        palette: Object.keys(t.palette).sort(), alpha: Object.keys(t.alpha).sort(), effects: Object.keys(t.effects).sort(),
        semantic: Object.keys(t.semantic).sort(), kit: Object.keys(t.kit).sort(),
    });

    it('a derived custom theme carries every token every built-in has (both bases)', () => {
        const derived = [deriveCustomTheme(customThemeFromBase('dark')), deriveCustomTheme(customThemeFromBase('light'))];
        for (const id of THEME_IDS) {
            for (const d of derived) expect(keysOf(d), `${id} vs custom ${d.id}`).toEqual(keysOf(THEMES[id]));
        }
        for (const d of derived) {
            for (const t of PALETTE_TOKENS) expect(d.palette[t]).toMatch(HEX);
            for (const t of ALPHA_TOKENS) expect(typeof d.alpha[t]).toBe('string');
            for (const t of EFFECT_TOKENS) expect(typeof d.effects[t]).toBe('string');
        }
    });

    it('a custom theme is never high contrast and keeps its base scheme', () => {
        for (const p of CUSTOM_THEME_PRESETS) {
            const t = deriveCustomTheme(p.def, p.key);
            expect(t.contrast).toBeUndefined();
            expect(t.scheme).toBe(p.def.base);
            expect(t.id).toBe(p.def.base);
        }
    });

    it('Create theme from ANY built-in: base = its scheme, validates with its colours unchanged', () => {
        for (const id of THEME_IDS) {
            const seed = customThemeFromTheme(THEMES[id]);
            expect(seed.base).toBe(THEMES[id].scheme);
            expect(seed.colors).toEqual(knobsFromTheme(THEMES[id]));
            const r = normalizeCustomTheme(seed);
            expect(r.ok, id).toBe(true);
            if (r.ok) expect(r.def.colors, id).toEqual(seed.colors);
        }
        // Dark / Light: identical to the base seeds (no behaviour change for them).
        expect(customThemeFromTheme(DARK_THEME)).toEqual(customThemeFromBase('dark'));
        expect(customThemeFromTheme(LIGHT_THEME)).toEqual(customThemeFromBase('light'));
    });

    it('the validator takes dark and light bases only (built-in ids are not bases)', () => {
        for (const base of ['dark', 'light']) expect(normalizeCustomTheme({ ...customThemeFromBase('dark'), base }).ok).toBe(true);
        for (const base of ['midnight', 'hc-dark', 'hc-light', 'system', 'custom']) {
            expect(normalizeCustomTheme({ ...customThemeFromBase('dark'), base }).ok).toBe(false);
        }
    });
});
