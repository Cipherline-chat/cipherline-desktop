/**
 * The night dive (styles/night-dive.css paints Dark's navy deeper after dark)
 * runs in the built-in Dark theme only: Light, Midnight, both High contrast
 * themes AND every custom theme (whose `data-theme` is its base, "dark" for a
 * dark-base one) keep their own colours all night.
 */
import { describe, expect, it } from 'vitest';
import { nightDiveAppliesTo } from './useNightDive';
import { THEMES, THEME_IDS } from '../theme/themes';
import { customThemeFromBase, deriveCustomTheme } from '../theme/customTheme';
import { CUSTOM_THEME_PRESETS } from '../theme/customPresets';

describe('night dive applies to Dark only', () => {
    it('built-ins: only dark', () => {
        expect(THEME_IDS.filter((id) => nightDiveAppliesTo(THEMES[id]))).toEqual(['dark']);
    });

    it('custom themes never (dark base included, even one seeded from Dark itself)', () => {
        const ocean = CUSTOM_THEME_PRESETS.find((p) => p.key === 'ocean')!.def;
        const fromDark = deriveCustomTheme(customThemeFromBase('dark'), 'c1');
        expect(fromDark.id).toBe('dark'); // control: the base id really is "dark"
        expect(nightDiveAppliesTo(fromDark)).toBe(false);
        expect(nightDiveAppliesTo(deriveCustomTheme(ocean, 'c2'))).toBe(false);
        expect(nightDiveAppliesTo(deriveCustomTheme(customThemeFromBase('light'), 'c3'))).toBe(false);
    });
});
