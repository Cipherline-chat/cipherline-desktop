import { describe, it, expect } from 'vitest';
import { hexToOklch, oklchToHex, paletteFromPixels, suggestedColours, themesFromPalette, displayable } from './palette';
import { themeSurface, contrast, CARD_TEXT_MUTED } from './profileTheme';

/** An image as RGBA pixels: `parts` of [r, g, b, count]. */
const img = (...parts: Array<[number, number, number, number]>) => {
    const out: number[] = [];
    for (const [r, g, b, n] of parts) for (let i = 0; i < n; i++) out.push(r, g, b, 255);
    return out;
};
const HEX = /^#[0-9a-f]{6}$/;

describe('palette', () => {
    it('OKLCH round-trips sRGB colours closely', () => {
        for (const hex of ['#25e0c8', '#ff6b5e', '#5e8ee0', '#808080']) {
            const { L, C, h } = hexToOklch(hex);
            const back = oklchToHex(L, C, h);
            const d = (a: string, b: string, i: number) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16));
            for (const i of [1, 3, 5]) expect(d(hex, back, i)).toBeLessThanOrEqual(1);
        }
    });

    it('clusters a two-colour image into its two colours, heaviest first', () => {
        const p = paletteFromPixels(img([200, 40, 120, 300], [20, 160, 180, 100]), 4);
        expect(p[0].weight).toBeCloseTo(0.75, 2);
        expect(p.reduce((a, s) => a + s.weight, 0)).toBeCloseTo(1, 5);
        expect(p.length).toBe(2); // fewer distinct colours than k: no phantom clusters
    });

    it('ignores transparent pixels and is deterministic', () => {
        const px = img([10, 200, 90, 50], [250, 180, 40, 50]);
        for (let i = 0; i < 40; i++) px.push(255, 0, 0, 0);
        const a = paletteFromPixels(px, 3), b = paletteFromPixels(px, 3);
        expect(a).toEqual(b);
        expect(a.every((s) => s.hex !== '#ff0000')).toBe(true);
    });

    it('a dusk banner proposes a vivid primary and a different-hue accent, all valid hex', () => {
        // big dark navy sky, a magenta band, an orange sun, teal water
        const pal = paletteFromPixels(img([20, 16, 50, 500], [140, 60, 120, 160], [242, 128, 92, 90], [15, 76, 92, 220]));
        const [best] = themesFromPalette(pal);
        expect(best.primary).toMatch(HEX);
        expect(best.accent).toMatch(HEX);
        // The navy sky is the biggest cluster but too dark and dull to lead.
        expect(hexToOklch(best.primary).C).toBeGreaterThan(0.06);
        expect(best.primary).not.toBe(best.accent);
    });

    it('a one-colour image still gets a tonal pair', () => {
        const themes = themesFromPalette(paletteFromPixels(img([60, 140, 220, 200])));
        expect(themes.length).toBeGreaterThan(0);
        const { primary, accent } = themes[0];
        expect(Math.abs(hexToOklch(primary).L - hexToOklch(accent).L)).toBeGreaterThan(0.1);
    });

    it('every proposal keeps the card readable (the theme surface caps the tint)', () => {
        const pal = paletteFromPixels(img([255, 255, 255, 300], [255, 240, 0, 100], [0, 0, 0, 100]));
        for (const t of themesFromPalette(pal)) {
            const s = themeSurface(t);
            expect(contrast(CARD_TEXT_MUTED, s.from)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(CARD_TEXT_MUTED, s.to)).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('lifts near-black colours into a band that reads on the dark card', () => {
        expect(hexToOklch(displayable({ L: 0.12, C: 0.05, h: 260 })).L).toBeGreaterThan(0.55);
    });

    it('suggested colours are distinct and capped', () => {
        const s = suggestedColours(paletteFromPixels(img([200, 40, 120, 30], [20, 160, 180, 30], [240, 200, 60, 30], [90, 90, 255, 30])), 3);
        expect(s).toHaveLength(3);
        expect(new Set(s).size).toBe(3);
    });

    it('an empty image proposes nothing', () => {
        expect(themesFromPalette(paletteFromPixels([]))).toEqual([]);
    });
});
