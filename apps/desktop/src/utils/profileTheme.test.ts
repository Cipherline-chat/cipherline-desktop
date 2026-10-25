import { describe, it, expect } from 'vitest';
import {
    THEME_PRESETS, CARD_TEXT, CARD_TEXT_MUTED, MIN_TEXT_CONTRAST, contrast, luminance, mix, normalizeHex, readTheme,
    safeTint, themeCardStyle, themeEquals, themeSurface, isThemeHex, THEME_HEX, MAX_TINT, matchTint,
} from './profileTheme';

const WORST = ['#ffffff', '#ffff00', '#00ff00', '#25e0c8', '#ff00ff', '#ffc94d', '#f4f7ff', '#000000', '#0b0f1e'];

describe('contrast maths', () => {
    it('matches the WCAG reference values', () => {
        expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
        expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
        expect(luminance('#ffffff')).toBeCloseTo(1, 5);
        expect(luminance('#000000')).toBeCloseTo(0, 5);
    });
    it('mix is a straight interpolation', () => {
        expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
        expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
        expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    });
});

describe('readability: muted card text stays >= 4.5:1 on every gradient stop', () => {
    it.each(THEME_PRESETS.map((p) => [p.id, p.theme] as const))('preset %s', (_id, theme) => {
        const s = themeSurface(theme);
        expect(contrast(CARD_TEXT_MUTED, s.from)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(contrast(CARD_TEXT_MUTED, s.to)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(contrast(CARD_TEXT, s.from)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(s.minContrast).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
    it.each(WORST.flatMap((a) => WORST.map((b) => [a, b] as const)))('custom %s + %s', (a, b) => {
        const s = themeSurface({ primary: a, accent: b });
        expect(s.minContrast).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
    it('a bright colour is tinted less than a dark one; a dark one gets the full tint', () => {
        expect(safeTint('#ffffff')).toBeLessThan(0.3);
        expect(safeTint('#243056')).toBe(MAX_TINT);
    });
    it('the card style carries the ring variable and a true-colour frame', () => {
        const st = themeCardStyle({ primary: '#25e0c8', accent: '#ffc94d' })!;
        expect(st['--pc-ring']).toMatch(/^#[0-9a-f]{6}$/);
        expect(st.background).toContain('#25e0c8');
        expect(st.background).toContain('border-box');
        expect(themeCardStyle(null)).toBeUndefined();
    });
});

describe('colour parsing', () => {
    it('THEME_HEX is the server regex: lowercase #rrggbb only', () => {
        for (const ok of ['#000000', '#a1b2c3']) expect(THEME_HEX.test(ok)).toBe(true);
        for (const bad of ['#ABCDEF', '#abc', 'abcdef', '#abcdeg', '#abcdef0', 'red', '']) expect(isThemeHex(bad)).toBe(false);
    });
    it('normalizeHex accepts typed variants and nothing else', () => {
        expect(normalizeHex(' #ABCDEF ')).toBe('#abcdef');
        expect(normalizeHex('abcdef')).toBe('#abcdef');
        for (const bad of ['#abc', 'xyzxyz', '', '#abcdef00']) expect(normalizeHex(bad)).toBeNull();
    });
    it('readTheme drops anything malformed', () => {
        expect(readTheme({ primary: '#112233', accent: '#445566' })).toEqual({ primary: '#112233', accent: '#445566' });
        for (const bad of [null, undefined, 'x', {}, { primary: '#112233' }, { primary: '#112233', accent: 'red' }]) expect(readTheme(bad)).toBeNull();
    });
    it('themeEquals', () => {
        const a = { primary: '#112233', accent: '#445566' };
        expect(themeEquals(a, { ...a })).toBe(true);
        expect(themeEquals(a, null)).toBe(false);
        expect(themeEquals(null, null)).toBe(true);
    });
    it('every preset is valid server input', () => {
        for (const p of THEME_PRESETS) { expect(isThemeHex(p.theme.primary)).toBe(true); expect(isThemeHex(p.theme.accent)).toBe(true); }
    });
});

describe('matchTint ("Match theme" decorations and effects)', () => {
    it('no theme keeps the stock teal (null)', () => {
        expect(matchTint(null)).toBeNull();
    });
    it('takes the lighter of the pair', () => {
        expect(matchTint({ primary: '#25e0c8', accent: '#0e8f7c' })).toBe('#25e0c8');
        expect(matchTint({ primary: '#0e8f7c', accent: '#ffc94d' })).toBe('#ffc94d');
    });
    it.each(WORST.flatMap((a) => WORST.map((b) => [a, b] as const)))('lifts a dark pair to something visible: %s + %s', (a, b) => {
        const c = matchTint({ primary: a, accent: b })!;
        expect(THEME_HEX.test(c)).toBe(true);
        expect(luminance(c)).toBeGreaterThanOrEqual(0.2);
    });
});

describe('tint cap', () => {
    it('stays moderate so a busy banner is not fought by the theme wash', () => {
        expect(MAX_TINT).toBeLessThanOrEqual(0.45);
    });
});
