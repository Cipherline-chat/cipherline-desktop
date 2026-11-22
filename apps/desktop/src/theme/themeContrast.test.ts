/**
 * Contrast guard for the built-in themes (plan: docs/plans/accessibility-and-themes.md,
 * "Testing strategy → Token contrast").
 *
 * Every text/background pair the app actually paints is listed with its
 * CURRENT ratio. Two things are asserted:
 *   1. the ratio is still what is recorded here (a palette change must update
 *      this table on purpose, so it shows up in review);
 *   2. every pair passes WCAG AA (4.5:1 text, 3:1 UI) UNLESS it is listed in
 *      KNOWN_FAILURES with the decision it is waiting on. A known failure that
 *      starts passing fails the test too, so the list cannot go stale.
 */
import { describe, expect, it } from 'vitest';
import { AA_TEXT, AA_UI, contrastRatio } from './contrast';
import { DARK_THEME, HC_DARK_THEME, HC_LIGHT_THEME, LIGHT_THEME, MIDNIGHT_THEME, type PaletteToken, type Theme } from './themes';

type Pair = { fg: PaletteToken; bg: PaletteToken; min: number; ratio: number };

const SURFACES: PaletteToken[] = ['abyss', 'deep', 'surface', 'raise', 'sink'];

/** Dark theme — ratios measured 2026-11-20 (theme-engine slice). */
const DARK_RATIOS: Record<string, number[]> = {
    // fg: ratios on abyss, deep, surface, raise, sink
    text:   [17.79, 16.09, 14.07, 12.01, 17.59],
    muted:  [9.12, 8.24, 7.21, 6.15, 9.01],
    // D3 (2026-11-20): #8591B5; was #5E6B8F at 3.61 / 3.26 / 2.85 / 2.44 / 3.57.
    faint:  [6.10, 5.51, 4.82, 4.11, 6.03],
    // Accent / status colours used as text (links, mentions, warnings, errors).
    lume:   [11.42, 10.32, 9.03, 7.70, 11.29],
    flash:  [6.83, 6.17, 5.40, 4.61, 6.75],
    glow:   [12.45, 11.26, 9.85, 8.40, 12.31],
    ok:     [10.94, 9.89, 8.65, 7.38, 10.82],
    danger: [6.41, 5.80, 5.07, 4.33, 6.34],
};

const DARK_PAIRS: Pair[] = [
    ...Object.entries(DARK_RATIOS).flatMap(([fg, ratios]) =>
        SURFACES.map((bg, i) => ({ fg: fg as PaletteToken, bg, min: AA_TEXT, ratio: ratios[i] }))),
    // Labels on filled buttons / pills.
    { fg: 'on-lume', bg: 'lume', min: AA_TEXT, ratio: 9.73 },
    { fg: 'on-flash', bg: 'flash', min: AA_TEXT, ratio: 6.03 },
    { fg: 'on-glow', bg: 'glow', min: AA_TEXT, ratio: 7.68 },
    // Hairline border as a UI boundary (decorative dividers are exempt from 1.4.11).
    { fg: 'border', bg: 'abyss', min: AA_UI, ratio: 1.59 },
    { fg: 'border', bg: 'deep', min: AA_UI, ratio: 1.44 },
    { fg: 'border', bg: 'surface', min: AA_UI, ratio: 1.26 },
];

/** Pairs that fail today, each waiting on a recorded decision. Do NOT change values here to make them pass. */
const KNOWN_FAILURES: Record<string, string> = {
    // --cl-faint as text (~630 uses): D3 applied, it passes everywhere but the hover fill.
    'faint/raise': 'D3 leaves 4.11:1 on the hover fill (raise); plan accepted it (a hovered row is transient)',
    // Danger text on a hover fill (e.g. a destructive menu row while hovered).
    'danger/raise': 'found by this test 2026-11-20; fold into the T3/T4 status-text tokens (--cl-danger-text)',
    // The hairline is the ONLY boundary of inputs / unchecked checkboxes in places.
    'border/abyss': 'plan 1a: new --cl-border-strong for control boundaries (T3)',
    'border/deep': 'plan 1a: --cl-border-strong (T3)',
    'border/surface': 'plan 1a: --cl-border-strong (T3)',
};

describe('Dark theme contrast', () => {
    for (const p of DARK_PAIRS) {
        const key = `${p.fg}/${p.bg}`;
        const actual = contrastRatio(DARK_THEME.palette[p.fg], DARK_THEME.palette[p.bg]);
        it(`${key} is still ${p.ratio}:1`, () => {
            expect(actual).toBeCloseTo(p.ratio, 2);
        });
        if (KNOWN_FAILURES[key]) {
            it(`${key} is a KNOWN failure (${KNOWN_FAILURES[key]}) and still fails ${p.min}:1`, () => {
                expect(actual).toBeLessThan(p.min);
            });
        } else {
            it(`${key} passes ${p.min}:1`, () => {
                expect(actual).toBeGreaterThanOrEqual(p.min);
            });
        }
    }

    it('every known failure names a pair that is actually measured', () => {
        const measured = new Set(DARK_PAIRS.map((p) => `${p.fg}/${p.bg}`));
        expect(Object.keys(KNOWN_FAILURES).filter((k) => !measured.has(k))).toEqual([]);
    });

    it('--cl-faint is the D3 value (#8591B5); offline dots keep the old grey (a dot, not text)', () => {
        expect(DARK_THEME.palette.faint).toBe('#8591B5');
        expect(DARK_THEME.palette['offline-dot']).toBe('#5E6B8F');
    });
});

/**
 * Light (2026-11-20, light-theme slice). Every text colour on every surface it
 * can sit on clears 4.5:1; every control boundary / indicator clears 3:1
 * (WCAG 1.4.11). The decorative hairline and the brand-teal FILL are the only
 * sub-3:1 colours, and they are pinned as such so nobody starts using them as
 * a boundary or as text.
 */
describe('Light theme contrast', () => {
    const L = LIGHT_THEME.palette;
    const ALL: PaletteToken[] = ['abyss', 'deep', 'surface', 'raise', 'sink'];
    const PANELS: PaletteToken[] = ['abyss', 'deep', 'surface', 'sink'];
    const TEXT: PaletteToken[] = ['text', 'muted', 'faint', 'lume-text', 'flash-text', 'glow-text', 'ok-text', 'danger-text', 'info-text', 'bright'];
    const CODE: PaletteToken[] = ['code-text', 'code-kw', 'code-str', 'code-num', 'code-lit', 'code-type', 'code-add', 'code-del'];
    // Indicators: control edges, the "on" teal, presence dots, and the focus ring (lume-text).
    const UI: PaletteToken[] = ['border-strong', 'lume-ui', 'lume-text', 'ok-dot', 'idle-dot', 'dnd-dot', 'offline-dot'];

    for (const fg of TEXT) for (const bg of ALL) {
        it(`text ${fg} on ${bg} >= ${AA_TEXT}:1`, () => {
            expect(contrastRatio(L[fg], L[bg])).toBeGreaterThanOrEqual(AA_TEXT);
        });
    }
    // Code blocks sit on the sand well (sink); a styled message can put one on a surface.
    for (const fg of CODE) for (const bg of ['sink', 'surface', 'abyss'] as PaletteToken[]) {
        it(`code ${fg} on ${bg} >= ${AA_TEXT}:1`, () => {
            expect(contrastRatio(L[fg], L[bg])).toBeGreaterThanOrEqual(AA_TEXT);
        });
    }
    // Indicators sit on panels; `raise` is a hover fill, not a home for dots or edges.
    for (const fg of UI) for (const bg of PANELS) {
        it(`UI ${fg} on ${bg} >= ${AA_UI}:1`, () => {
            expect(contrastRatio(L[fg], L[bg])).toBeGreaterThanOrEqual(AA_UI);
        });
    }
    it('labels on filled buttons / pills >= 4.5:1', () => {
        expect(contrastRatio(L['on-lume'], L.lume)).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrastRatio(L['on-flash'], L.flash)).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrastRatio(L['on-glow'], L.glow)).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it('KNOWN sub-3:1 colours stay decorative-only: the hairline and the brand-teal fill', () => {
        // If one of these starts passing, the palette changed: update this test on purpose.
        expect(contrastRatio(L.border, L.deep)).toBeLessThan(AA_UI);
        expect(contrastRatio(L.lume, L.deep)).toBeLessThan(AA_UI);
        // ...which is exactly why the boundary / indicator / text roles exist.
        expect(contrastRatio(L['border-strong'], L.deep)).toBeGreaterThanOrEqual(AA_UI);
        expect(contrastRatio(L['lume-ui'], L.deep)).toBeGreaterThanOrEqual(AA_UI);
    });
    it('the website-matching values (D1): cream page, white panels, ink text', () => {
        expect([L.abyss, L.deep, L.text, L['lume-text']]).toEqual(['#FFF8EE', '#FFFFFF', '#1C2240', '#0A6B60']);
    });
});

describe('Dark theme: the light-slice roles keep Dark readable too', () => {
    const D = DARK_THEME.palette;
    for (const fg of ['code-text', 'code-kw', 'code-str', 'code-num', 'code-lit', 'code-type', 'code-add', 'code-del'] as PaletteToken[]) {
        it(`code ${fg} on abyss >= ${AA_TEXT}:1`, () => {
            expect(contrastRatio(D[fg], D.abyss)).toBeGreaterThanOrEqual(AA_TEXT);
        });
    }
    it('border-strong is a 3:1 control edge on the panels', () => {
        for (const bg of ['abyss', 'deep', 'surface', 'sink'] as PaletteToken[]) expect(contrastRatio(D['border-strong'], D[bg])).toBeGreaterThanOrEqual(AA_UI);
    });
});

/**
 * Midnight, High contrast dark, High contrast light (themes-midnight-contrast
 * slice, 2026-11-20). One table of roles for all three; the thresholds differ:
 *   Midnight       text >= 4.5:1 (AA) on EVERY surface, hover fill included;
 *   High contrast  text >= 7:1 (AAA) on every surface, hover fill included.
 * Controls / indicators (control edges, the "on" teal, presence dots, the
 * focus ring) >= 3:1 on the panels in all three, and >= 4.5:1 in the high
 * contrast themes. In the high contrast themes the hairline itself is a
 * control-grade edge (>= 3:1 on the panels, >= 4.5:1 on the page), since
 * theme-contrast.css draws every panel and control edge with it.
 */
const TEXT_ROLES: PaletteToken[] = ['text', 'muted', 'faint', 'lume-text', 'flash-text', 'glow-text', 'ok-text', 'danger-text', 'info-text', 'bright'];
const CODE_ROLES: PaletteToken[] = ['code-text', 'code-kw', 'code-str', 'code-num', 'code-lit', 'code-type', 'code-add', 'code-del'];
const UI_ROLES: PaletteToken[] = ['border-strong', 'lume-ui', 'lume-text', 'ok-dot', 'idle-dot', 'dnd-dot', 'offline-dot'];
const EVERY_SURFACE: PaletteToken[] = ['abyss', 'deep', 'surface', 'raise', 'sink'];
const PANEL_SURFACES: PaletteToken[] = ['abyss', 'deep', 'surface', 'sink'];

function contrastSuite(theme: Theme, text: number, ui: number) {
    const P = theme.palette;
    describe(`${theme.name} contrast (text >= ${text}:1, controls >= ${ui}:1)`, () => {
        for (const fg of TEXT_ROLES) for (const bg of EVERY_SURFACE) {
            it(`text ${fg} on ${bg} >= ${text}:1`, () => {
                expect(contrastRatio(P[fg], P[bg])).toBeGreaterThanOrEqual(text);
            });
        }
        for (const fg of CODE_ROLES) for (const bg of ['sink', 'surface', 'abyss', 'deep'] as PaletteToken[]) {
            it(`code ${fg} on ${bg} >= ${text}:1`, () => {
                expect(contrastRatio(P[fg], P[bg])).toBeGreaterThanOrEqual(text);
            });
        }
        for (const fg of UI_ROLES) for (const bg of PANEL_SURFACES) {
            it(`UI ${fg} on ${bg} >= ${ui}:1`, () => {
                expect(contrastRatio(P[fg], P[bg])).toBeGreaterThanOrEqual(ui);
            });
        }
        it(`labels on filled buttons / pills >= ${text}:1`, () => {
            expect(contrastRatio(P['on-lume'], P.lume)).toBeGreaterThanOrEqual(text);
            expect(contrastRatio(P['on-flash'], P.flash)).toBeGreaterThanOrEqual(text);
            expect(contrastRatio(P['on-glow'], P.glow)).toBeGreaterThanOrEqual(text);
        });
    });
}

contrastSuite(MIDNIGHT_THEME, AA_TEXT, AA_UI);
contrastSuite(HC_DARK_THEME, 7, AA_TEXT);
contrastSuite(HC_LIGHT_THEME, 7, AA_TEXT);

describe('Midnight: true black, Cipherline accents', () => {
    const M = MIDNIGHT_THEME.palette;
    it('the page is #000000 and the panels are a hair above it', () => {
        expect(M.abyss).toBe('#000000');
        expect(contrastRatio(M.deep, M.abyss)).toBeGreaterThan(1);
        expect(contrastRatio(M.deep, M.abyss)).toBeLessThan(1.15);
    });
    it('the hairline separates panels from the black (>= 1.5:1 on the page and the panels; Dark is 1.59 / 1.44)', () => {
        expect(contrastRatio(M.border, M.abyss)).toBeGreaterThanOrEqual(1.5);
        expect(contrastRatio(M.border, M.deep)).toBeGreaterThanOrEqual(1.5);
    });
    it('keeps the brand fills and status colours of Dark', () => {
        for (const t of ['lume', 'lume-hi', 'lume-press', 'lume-deep', 'on-lume', 'flash', 'glow', 'ok', 'danger', 'keys-alert', 'keys-ink'] as PaletteToken[]) {
            expect(M[t], t).toBe(DARK_THEME.palette[t]);
        }
    });
    it('glows are reduced, not Dark\'s', () => {
        expect(MIDNIGHT_THEME.effects['glow-lume']).not.toBe(DARK_THEME.effects['glow-lume']);
        expect(MIDNIGHT_THEME.effects['glow-lume-hot']).not.toBe(DARK_THEME.effects['glow-lume-hot']);
    });
});

describe('High contrast: edges never depend on transparency, and there are no glows', () => {
    for (const t of [HC_DARK_THEME, HC_LIGHT_THEME]) {
        const P = t.palette;
        it(`${t.name}: the hairline is a real edge (>= 3:1 on every panel, >= 4.5:1 on the page)`, () => {
            for (const bg of PANEL_SURFACES) expect(contrastRatio(P.border, P[bg]), bg).toBeGreaterThanOrEqual(AA_UI);
            expect(contrastRatio(P.border, P.abyss)).toBeGreaterThanOrEqual(AA_TEXT);
        });
        it(`${t.name}: no glow effects`, () => {
            expect(t.effects['glow-lume']).toBe('0 0 0 0 transparent');
            expect(t.effects['glow-lume-hot']).toBe('0 0 0 0 transparent');
        });
        it(`${t.name}: flagged high-contrast (theme-contrast.css)`, () => {
            expect(t.contrast).toBe('high');
        });
    }
});
