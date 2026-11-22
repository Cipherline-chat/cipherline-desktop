/**
 * Ambient motes in every theme (utils/ambientPalette.ts): Dark draws exactly
 * what it drew before themes, every other theme gets its own tint, custom
 * themes follow their accent, and no theme's motes can pull body / secondary
 * text below its contrast floor (AA 4.5:1; high contrast 7:1) even with a mote
 * right behind the text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ambientPaletteFor, ambientCount, drawMote, BUBBLE_FILL, CANVAS_MOTE_MAX_ALPHA, type AmbientPalette } from './ambientPalette';
import { THEMES, type Theme } from '../theme/themes';
import { CUSTOM_THEME_PRESETS } from '../theme/customPresets';
import { deriveCustomTheme } from '../theme/customTheme';
import { contrastRatio } from '../theme/contrast';

const SRC = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

const CUSTOM: Theme[] = CUSTOM_THEME_PRESETS.map((p) => deriveCustomTheme(p.def, `t-${p.key}`));
const ALL: Theme[] = [...Object.values(THEMES), ...CUSTOM];
const custom = (key: string) => deriveCustomTheme(CUSTOM_THEME_PRESETS.find((p) => p.key === key)!.def, `t-${key}`);

/** A 2D context that records every call / assignment as a string. */
function recorder() {
    const log: string[] = [];
    const cx = new Proxy({} as Record<string, unknown>, {
        get: (_t, k) => (...args: unknown[]) => { log.push(`${String(k)}(${args.join(',')})`); },
        set: (_t, k, v) => { log.push(`${String(k)}=${String(v)}`); return true; },
    });
    return { cx: cx as unknown as CanvasRenderingContext2D, log };
}

/** The pre-theme draw code, verbatim from SeaBackdrop / DockBackdrop (e109fd380). */
function legacyDraw(cx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number, warm: boolean) {
    cx.beginPath();
    cx.arc(x, y, r, 0, 7);
    cx.fillStyle = warm ? `rgba(255,201,77,${a})` : `rgba(37,224,200,${a})`;
    cx.fill();
}

/** Seeded PRNG so the field is the same every run. */
function seeded(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');
const rgbOf = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** `fg` at `alpha` over the opaque `bg`, composited in sRGB like the browser does. */
function over(fg: string, alpha: number, bg: string): string {
    const f = rgbOf(fg); const b = rgbOf(bg);
    return '#' + f.map((c, i) => hex2(c * alpha + b[i] * (1 - alpha))).join('');
}

describe('Dark is unchanged', () => {
    it('Dark draws byte-for-byte the legacy calls for a seeded field (warm motes included)', () => {
        const pal = ambientPaletteFor(THEMES.dark);
        const rnd = seeded(42);
        const a = recorder(); const b = recorder();
        let warmSeen = 0;
        for (let i = 0; i < 400; i++) {
            const x = rnd() * 1366; const y = rnd() * 768; const r = 0.8 + rnd() * 1.8;
            const al = 0.05 + rnd() * 0.22; const warm = rnd() < 0.1;
            if (warm) warmSeen++;
            drawMote(a.cx, pal, x, y, r, al, warm);
            legacyDraw(b.cx, x, y, r, al, warm);
        }
        expect(warmSeen).toBeGreaterThan(0);
        expect(a.log).toEqual(b.log);
    });

    it('Dark keeps every mote (count multiplier exactly 1)', () => {
        const pal = ambientPaletteFor(THEMES.dark);
        for (const n of [26, 20, 12, 6, 22]) expect(ambientCount(pal, n)).toBe(n);
    });

    it('positive control: the comparison catches a changed tint', () => {
        const pal: AmbientPalette = { ...ambientPaletteFor(THEMES.dark), mote: THEMES.light.palette['lume-ui'] };
        const a = recorder(); const b = recorder();
        drawMote(a.cx, pal, 1, 2, 1.5, 0.2, false);
        legacyDraw(b.cx, 1, 2, 1.5, 0.2, false);
        expect(a.log).not.toEqual(b.log);
    });
});

describe('every theme gets its own tint', () => {
    it('Midnight: dim, fewer, no warm mote', () => {
        const p = ambientPaletteFor(THEMES.midnight);
        expect(p.kind).toBe('glow');
        expect(p.alpha).toBeLessThan(1);
        expect(ambientCount(p, 26)).toBeLessThan(26);
        expect(p.warm).toBeNull();
    });

    it('light-scheme themes: accent bubbles with a lume-ui rim, no warm mote', () => {
        for (const t of [THEMES.light, custom('rose'), custom('light')]) {
            const p = ambientPaletteFor(t);
            expect(p.kind, t.name).toBe('bubble');
            expect(p.mote).toBe(t.palette.lume);
            expect(p.rim).toBe(t.palette['lume-ui']);
            expect(p.warm).toBeNull();
        }
    });

    it('high contrast: sparse, neutral (faint grey), no warm mote', () => {
        for (const t of [THEMES['hc-dark'], THEMES['hc-light']]) {
            const p = ambientPaletteFor(t);
            expect(p.kind).toBe('quiet');
            expect(p.mote).toBe(t.palette.faint);
            expect(p.warm).toBeNull();
            expect(ambientCount(p, 26)).toBeLessThanOrEqual(13);
        }
    });

    it('custom themes take their colours from the theme, not Dark', () => {
        const ocean = custom('ocean');
        expect(ambientPaletteFor(ocean).mote).toBe(ocean.palette.lume);
        expect(ocean.palette.lume).not.toBe(THEMES.dark.palette.lume);
        const rose = custom('rose');
        expect(ambientPaletteFor(rose).rim).toBe(rose.palette['lume-ui']);
    });

    it('a bubble draws a pale fill and a rim, both in the theme colours', () => {
        const t = THEMES.light;
        const { cx, log } = recorder();
        drawMote(cx, ambientPaletteFor(t), 10, 10, 2, 0.2, true);
        expect(log.some((l) => l.startsWith('fillStyle=rgba(37,224,200,'))).toBe(true);
        expect(log).toContain('strokeStyle=rgba(14,143,124,0.22000000000000003)');
        expect(log).toContain('stroke()');
    });
});

describe('motes never pull text below the theme contrast floor', () => {
    const floor = (t: Theme) => (t.contrast === 'high' ? 7 : 4.5);
    const grounds = (t: Theme) => [t.palette.abyss, t.palette.deep];
    /** The colour + alpha of a mote's strongest pixel. */
    const strongest = (p: AmbientPalette, baseMax: number): [string, number][] => {
        const out: [string, number][] = [[p.rim ?? p.mote, Math.min(1, baseMax * p.alpha)]];
        if (p.rim) out.push([p.mote, Math.min(1, baseMax * p.alpha * BUBBLE_FILL)]);
        if (p.warm) out.push([p.warm, Math.min(1, baseMax * p.alpha)]);
        return out;
    };

    // Built-in Dark is exempt: it must stay exactly as it was, and its teal motes
    // already dip muted text on a panel to ~4.36:1 under a 1-3 px mote. Every
    // other theme (custom dark themes included) is held to the full floor.
    it.each(ALL.filter((t) => t !== THEMES.dark).map((t) => [t.name, t] as const))('%s: canvas motes (Settings, Server Settings)', (_n, t) => {
        const p = ambientPaletteFor(t);
        for (const g of grounds(t)) {
            for (const [c, a] of strongest(p, CANVAS_MOTE_MAX_ALPHA)) {
                const bg = over(c, a, g);
                // Only where the theme itself clears the floor on that ground (a mote must not be the reason it fails).
                for (const ink of [t.palette.text, t.palette.muted]) {
                    if (contrastRatio(ink, g) < floor(t)) continue;
                    expect(contrastRatio(ink, bg), `${t.name} ${ink} on ${g} + ${c}@${a}`).toBeGreaterThanOrEqual(floor(t));
                }
            }
        }
    });

    it('home deck motes (home-deck.css): light rim and high-contrast dots stay under the floor', () => {
        const css = read('styles/home-deck.css');
        const PEAK = 0.5; // utils/homeAmbient.ts: peak opacity .2-.5
        const rim = Number(/data-scheme="light"\] \.hd-mote \{[^}]*lume-ui-rgb\) \/ ([\d.]+)\)/.exec(css)?.[1]);
        const hcLayer = Number(/data-contrast="high"\] \.hd-ambient \{ opacity: ([\d.]+); \}/.exec(css)?.[1]);
        expect(rim).toBeGreaterThan(0);
        expect(hcLayer).toBeGreaterThan(0);
        const lightKind = ALL.filter((t) => t.scheme === 'light' && t.contrast !== 'high');
        for (const t of lightKind) {
            const bg = over(t.palette['lume-ui'], rim * PEAK, t.palette.abyss);
            for (const ink of [t.palette.text, t.palette.muted]) {
                if (contrastRatio(ink, t.palette.abyss) < 4.5) continue;
                expect(contrastRatio(ink, bg), t.name).toBeGreaterThanOrEqual(4.5);
            }
        }
        for (const t of [THEMES['hc-dark'], THEMES['hc-light']]) {
            const bg = over(t.palette.faint, hcLayer * PEAK, t.palette.abyss);
            expect(contrastRatio(t.palette.text, bg)).toBeGreaterThanOrEqual(7);
            expect(contrastRatio(t.palette.muted, bg)).toBeGreaterThanOrEqual(7);
        }
    });
});

describe('the CSS layers', () => {
    const blockOf = (css: string, start: string, end: string) => {
        const i = css.indexOf(start);
        expect(i, start).toBeGreaterThanOrEqual(0);
        return css.slice(i, css.indexOf(end, i));
    };
    const selectors = (block: string) => [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());

    it('no theme rule for the home motes or marine snow matches plain Dark', () => {
        const home = blockOf(read('styles/home-deck.css'), 'The ambient motes in the other themes', '/* ── Light theme');
        const snow = blockOf(read('index.css'), 'Marine snow in the other themes', '/* Composer paperclip');
        const sels = [...selectors(home), ...selectors(snow)];
        expect(sels.length).toBeGreaterThanOrEqual(10);
        for (const s of sels) expect(s, s).toMatch(/data-theme="midnight"|data-scheme="light"|data-contrast="high"/);
    });

    it("Dark's own mote rule is untouched", () => {
        expect(read('styles/home-deck.css')).toContain(
            'background: radial-gradient(circle, rgb(var(--cl-lume-rgb) / .9) 0%, rgb(var(--cl-lume-rgb) / .25) 55%, transparent 75%);',
        );
    });

    it('high contrast drops marine snow (the one layer drawn over text)', () => {
        expect(read('index.css')).toMatch(/:root\[data-contrast="high"\] \.season-layer \{ display: none; \}/);
    });
});

describe('the contrast cap', () => {
    it('built-in themes are never capped (their look is the designed one)', () => {
        expect(ambientPaletteFor(THEMES.light).alpha).toBe(1.1);
        expect(ambientPaletteFor(THEMES.midnight).alpha).toBe(0.6);
        expect(ambientPaletteFor(THEMES['hc-dark']).alpha).toBe(0.5);
        expect(ambientPaletteFor(THEMES['hc-light']).alpha).toBe(0.5);
        expect(ambientPaletteFor(THEMES.dark).alpha).toBe(1);
    });

    it('a near-white accent on a near-black custom page is dimmed, not dropped', () => {
        const mono = ambientPaletteFor(custom('mono'));
        expect(mono.alpha).toBeLessThan(1);
        expect(mono.alpha).toBeGreaterThan(0.2);
    });
});

describe('canvas wiring', () => {
    it.each(['components/settings/SeaBackdrop.tsx', 'components/server/DockBackdrop.tsx'])('%s draws through the palette and the ambient gate', (f) => {
        const src = read(f);
        expect(src).toMatch(/ambientPaletteFor\(theme\)/);
        expect(src).toMatch(/drawMote\(/);
        expect(src).toMatch(/useAmbientActive\(\)/);
        expect(src).not.toMatch(/rgba\(/);
        expect(src).not.toMatch(/isLight|scheme === 'light'/);
    });
});
