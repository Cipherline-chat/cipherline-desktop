/**
 * Stripe Elements in the ACTIVE theme (desktop only).
 *
 * Elements render inside Stripe's own iframe, so they cannot read our CSS
 * variables: the appearance must be handed over as plain colours. Dark keeps
 * STRIPE_APPEARANCE exactly (the "glow in the deep" look the website shares);
 * every other theme (Light, Midnight, High contrast, custom) is derived from
 * its palette, with Stripe's light base ('stripe') for a light-scheme theme
 * and its dark base ('night') otherwise, so the card field never shows a navy
 * box on a cream checkout (or a navy box on a black one).
 *
 * Kept out of stripeAppearance.ts on purpose: that file is importable by
 * apps/website, which has no theme engine.
 */
import type { Appearance } from '@stripe/stripe-js';
import { DARK_THEME, type Theme } from '../../theme/themes';
import { STRIPE_APPEARANCE } from './stripeAppearance';

export function stripeAppearanceFor(theme: Theme): Appearance {
    if (theme.id === DARK_THEME.id && !theme.customId) return STRIPE_APPEARANCE;
    const p = theme.palette;
    const light = theme.scheme === 'light';
    const high = theme.contrast === 'high';
    // Control edges: the >= 3:1 boundary in light and high-contrast themes, the hairline otherwise (as Dark).
    const edge = light || high ? p['border-strong'] : p.border;
    const field = light ? p.deep : p.sink;
    const ring = `0 0 0 3px ${p['lume-text']}40`;
    return {
        theme: light ? 'stripe' : 'night',
        variables: {
            ...STRIPE_APPEARANCE.variables,
            colorPrimary: light ? p['lume-text'] : p.lume,
            colorBackground: p.deep,
            colorText: p.text,
            colorTextSecondary: p.muted,
            colorTextPlaceholder: p.faint,
            colorDanger: p['danger-text'],
            colorIcon: p.muted,
        },
        rules: {
            '.Input': { backgroundColor: field, border: `1px solid ${edge}`, boxShadow: 'none', color: p.text },
            '.Input:focus': { border: `1px solid ${p['lume-text']}`, boxShadow: ring },
            '.Label': { color: p.muted, fontWeight: '600' },
            '.Tab': { backgroundColor: field, border: `1px solid ${edge}`, color: p.muted },
            '.Tab:hover': { borderColor: p['lume-text'], color: p.text },
            '.Tab--selected': { borderColor: p['lume-text'], boxShadow: `0 0 0 1px ${p['lume-text']}`, color: p.text },
            '.Block': { backgroundColor: field, border: `1px solid ${edge}` },
            '.Error': { color: p['danger-text'] },
        },
    };
}
