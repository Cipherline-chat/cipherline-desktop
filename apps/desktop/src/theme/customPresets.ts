/**
 * Starting points for the custom theme editor (Settings → Appearance → Theme →
 * Create theme). Plain data, like themes.ts (exempt from the colour-literal
 * ratchet for the same reason). Like every custom theme, a preset's colours
 * are used exactly as written.
 */
import { CUSTOM_THEME_VERSION, customThemeFromBase, type CustomThemeDef } from './customTheme';

export interface CustomThemePreset {
    key: string;
    def: CustomThemeDef;
    blurb: string;
}

const preset = (key: string, blurb: string, def: Omit<CustomThemeDef, 'v'>): CustomThemePreset => ({ key, blurb, def: { v: CUSTOM_THEME_VERSION, ...def } });

export const CUSTOM_THEME_PRESETS: readonly CustomThemePreset[] = [
    { key: 'dark', blurb: 'Start from Dark', def: customThemeFromBase('dark', 'My dark theme') },
    { key: 'light', blurb: 'Start from Light', def: customThemeFromBase('light', 'My light theme') },
    preset('ocean', 'Deep blue, sea-glass accent', {
        name: 'Ocean', base: 'dark', glow: true,
        colors: {
            bg: '#06141f', panel: '#0b2030', surface: '#12304a', text: '#eaf6ff', muted: '#9dbad0',
            accent: '#38bdf8', onAccent: '#04223a', danger: '#ff6b81', border: '#1d4260',
        },
    }),
    preset('forest', 'Moss and pine, fern accent', {
        name: 'Forest', base: 'dark', glow: false,
        colors: {
            bg: '#0c140f', panel: '#132019', surface: '#1b2d23', text: '#eef5ec', muted: '#a9bfae',
            accent: '#7fd18b', onAccent: '#0b2412', danger: '#ff7a6b', border: '#29402f',
        },
    }),
    preset('rose', 'Blush paper, rose ink', {
        name: 'Rose', base: 'light', glow: false,
        colors: {
            bg: '#fff5f6', panel: '#ffffff', surface: '#fbe9ec', text: '#3a1d27', muted: '#6e4a56',
            accent: '#c93a62', onAccent: '#ffffff', danger: '#c0263a', border: '#f0d3da',
        },
    }),
    preset('mono', 'Graphite, no colour but white', {
        name: 'Mono', base: 'dark', glow: false,
        colors: {
            bg: '#0e0e10', panel: '#161618', surface: '#202023', text: '#f2f2f3', muted: '#a8a8ad',
            accent: '#e8e8ea', onAccent: '#111113', danger: '#ff6b6b', border: '#2c2c30',
        },
    }),
];
