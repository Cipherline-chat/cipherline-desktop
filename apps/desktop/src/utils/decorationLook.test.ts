import { describe, it, expect } from 'vitest';
import { decorationLook, NO_DECORATION_LOOK } from './decorationLook';
import { matchTint } from './profileTheme';

const THEME = { primary: '#112233', accent: '#ff5599' };

describe('decorationLook - the card\'s decoration look from any payload row', () => {
    it('no decoration -> nothing to draw (and nothing else leaks through)', () => {
        expect(decorationLook(null)).toBe(NO_DECORATION_LOOK);
        expect(decorationLook(undefined)).toBe(NO_DECORATION_LOOK);
        expect(decorationLook({ avatar_decoration: null, profile_theme: THEME, cosmetic_options: { d: { h: 200 } } })).toBe(NO_DECORATION_LOOK);
    });

    it('decoration + hue option + theme = the id, the owner\'s knobs and the Match-theme tint (exactly what the card builds)', () => {
        const look = decorationLook({ avatar_decoration: 'lume-ring', profile_theme: THEME, cosmetic_options: { d: { h: 300, i: 3 } } });
        expect(look).toEqual({ decoration: 'lume-ring', tint: matchTint(THEME), options: { h: 300, i: 3 } });
    });

    it('no theme -> no tint (stock colour); no options -> an empty knob set, never undefined garbage', () => {
        const look = decorationLook({ avatar_decoration: 'lume-ring' });
        expect(look.tint).toBeNull();
        expect(look.options).toEqual({});
    });

    it('options for keys the decoration does not take, or out of range, are dropped; the effect slot is ignored', () => {
        const look = decorationLook({ avatar_decoration: 'lume-ring', cosmetic_options: { d: { h: 999, i: 2, s: 3 }, e: { n: 3 } } as never });
        expect(look.options).toEqual({ i: 2 });
    });

    it('a garbage theme is no theme', () => {
        const look = decorationLook({ avatar_decoration: 'lume-ring', profile_theme: { primary: 'red', accent: 'blue' } });
        expect(look.tint).toBeNull();
    });

    describe('fallback (a friends row from an API that predates the theme / options fields)', () => {
        const cached = { avatar_decoration: 'lume-ring', profile_theme: THEME, cosmetic_options: { d: { h: 40 } } };

        it('completes ONLY the fields the row does not carry at all', () => {
            const row = { avatar_decoration: 'lume-ring' };
            expect(decorationLook(row, cached)).toEqual({ decoration: 'lume-ring', tint: matchTint(THEME), options: { h: 40 } });
        });
        it('a field that is present - even null, "cleared" - is never replaced by an older cached value', () => {
            const row = { avatar_decoration: 'lume-ring', profile_theme: null, cosmetic_options: null };
            expect(decorationLook(row, cached)).toEqual({ decoration: 'lume-ring', tint: null, options: {} });
        });
        it('a row that says "no decoration" wins over a cached one', () => {
            expect(decorationLook({ avatar_decoration: null }, cached)).toBe(NO_DECORATION_LOOK);
        });
        it('with no row at all the cache alone still works', () => {
            expect(decorationLook(null, cached).decoration).toBe('lume-ring');
        });
    });
});
