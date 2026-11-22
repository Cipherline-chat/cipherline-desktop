import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, DARK_THEME, type Theme } from '../../theme/themes';
import { deriveCustomTheme } from '../../theme/customTheme';
import { CUSTOM_THEME_PRESETS } from '../../theme/customPresets';
import { contrastRatio } from '../../theme/contrast';
import { STRIPE_APPEARANCE } from './stripeAppearance';
import { stripeAppearanceFor } from './stripeThemeAppearance';

const ALL: Theme[] = [
    ...Object.values(THEMES),
    ...CUSTOM_THEME_PRESETS.map((p) => deriveCustomTheme(p.def, `p-${p.key}`)),
];

describe('stripeAppearanceFor', () => {
    it('Dark is the shared look, unchanged (same object)', () => {
        expect(stripeAppearanceFor(DARK_THEME)).toBe(STRIPE_APPEARANCE);
    });

    it.each(ALL.filter((t) => t !== DARK_THEME).map((t) => [t.customId ?? t.id, t] as const))('%s: Stripe base follows the scheme, text readable on the field', (_n, t) => {
        const a = stripeAppearanceFor(t);
        expect(a.theme).toBe(t.scheme === 'light' ? 'stripe' : 'night');
        const v = a.variables!;
        expect(contrastRatio(v.colorText!, v.colorBackground!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(v.colorTextSecondary!, v.colorBackground!)).toBeGreaterThanOrEqual(4.5);
        const input = a.rules!['.Input'] as Record<string, string>;
        expect(contrastRatio(t.palette.text, input.backgroundColor)).toBeGreaterThanOrEqual(4.5);
        // No navy box left in a non-Dark theme.
        expect(JSON.stringify(a.rules)).not.toMatch(/#0F1424|#131A30/i);
    });

    it('every Elements surface on desktop goes through it', () => {
        for (const f of ['InAppCheckout.tsx', 'UpdateCardModal.tsx', join('gifts', 'GiftProModal.tsx')]) {
            const src = readFileSync(join(__dirname, f), 'utf8');
            expect(src, f).toContain('stripeAppearanceFor(getTheme())');
            expect(src, f).not.toMatch(/appearance:\s*STRIPE_APPEARANCE/);
        }
    });
});
