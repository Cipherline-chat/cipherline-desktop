/**
 * Light theme: a styled message the sender painted dark stays a dark island
 * (headings, code, spoilers inside keep the Dark tokens). cardSurfaceIsDark
 * decides it from the RESOLVED card, so theme() colours resolve per reader first.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cardElementProps, cardSurfaceIsDark } from './cardStyleReact';
import { __resetThemeForTests, applyTheme } from '../../theme/engine';
import { LIGHT_THEME } from '../../theme/themes';

const base = { radius: [12, 12, 12, 12] as [number, number, number, number], padding: [10, 12] as const, edge: true, notes: {} };

describe('cardSurfaceIsDark', () => {
    afterEach(() => __resetThemeForTests());

    it('navy solids and gradients are dark; cream / pastel / transparent are not', () => {
        expect(cardSurfaceIsDark({ backgroundColor: '#131a30' })).toBe(true);
        expect(cardSurfaceIsDark({ backgroundImage: 'linear-gradient(180deg, rgb(21, 29, 54) 0%, rgb(15, 22, 43) 100%)' })).toBe(true);
        expect(cardSurfaceIsDark({ backgroundColor: '#fff0c2' })).toBe(false);
        expect(cardSurfaceIsDark({ backgroundColor: 'rgba(19, 26, 48, 0.2)' })).toBe(false);
        expect(cardSurfaceIsDark({})).toBe(false);
    });

    it('a gradient BORDER layer does not count toward the surface', () => {
        const fill = 'linear-gradient(rgb(21, 29, 54) 0%, rgb(15, 22, 43) 100%)';
        const border = 'linear-gradient(135deg, #a7f3e8 0%, #fde68a 100%)';
        expect(cardSurfaceIsDark({ backgroundImage: `${fill}, ${border}`, backgroundClip: 'padding-box, border-box' })).toBe(true);
    });

    it('only Light marks a dark card as an island (Dark output unchanged)', () => {
        const r = { ...base, backgroundColor: '#131a30' };
        expect(cardElementProps(r).className).toBe('cl-msg-card');
        applyTheme(LIGHT_THEME);
        expect(cardElementProps(r).className).toBe('cl-msg-card cl-island-dark');
        expect(cardElementProps({ ...base, backgroundColor: '#fff0c2' }).className).toBe('cl-msg-card');
    });
});
