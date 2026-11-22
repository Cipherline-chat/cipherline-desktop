/**
 * electron/theme-custom-boot.ts validates the device copy of the active custom
 * theme that the renderer builds (src/theme/customTheme.ts customBootPayload).
 * A test may import across electron/ and src/ (tsconfig.electron.json
 * excludes tests), so this pins the two sides together.
 */
import { describe, expect, it } from 'vitest';
import {
    CUSTOM_BOOT_JSON_MAX, CUSTOM_BOOT_KNOBS, CUSTOM_THEME_PREF, paletteForState, parseCustomBootPayload, readDeviceThemeStateWithCustom,
} from './theme-custom-boot';
import { bootPalette } from './theme-boot';
import { CUSTOM_THEME_KNOBS, customBootPayload, customThemeFromBase } from '../src/theme/customTheme';
import { CUSTOM_THEME_PRESETS } from '../src/theme/customPresets';

const ocean = CUSTOM_THEME_PRESETS.find((p) => p.key === 'ocean')!.def;
const good = () => JSON.parse(JSON.stringify(customBootPayload('abc-123', ocean)));

describe('custom theme boot payload (main side)', () => {
    it('mirrors the renderer knob list', () => {
        expect([...CUSTOM_BOOT_KNOBS]).toEqual([...CUSTOM_THEME_KNOBS]);
    });

    it('accepts what the renderer builds, as an object or stored JSON', () => {
        const p = parseCustomBootPayload(good());
        expect(p?.id).toBe('abc-123');
        expect(p?.theme.base).toBe('dark');
        expect(p?.boot.windowBackground).toBe(ocean.colors.bg.toUpperCase());
        expect(parseCustomBootPayload(JSON.stringify(good()))).toEqual(p);
        expect(parseCustomBootPayload(customBootPayload('l1', customThemeFromBase('light')))?.theme.base).toBe('light');
    });

    it.each([
        ['a CSS value', (g: any) => { g.theme.colors.bg = 'url(https://x.example/b)'; }],
        ['a named colour', (g: any) => { g.boot.windowBackground = 'red'; }],
        ['an extra knob', (g: any) => { g.theme.colors.css = '#000000'; }],
        ['a missing knob', (g: any) => { delete g.theme.colors.border; }],
        ['a bad id', (g: any) => { g.id = '../../x'; }],
        ['a bad base', (g: any) => { g.theme.base = 'sepia'; }],
        ['a bad gradient', (g: any) => { g.boot.gradient = ['#000000', '#000000']; }],
        ['a bad title bar', (g: any) => { g.boot.titleBar.color = 'expression(1)'; }],
        ['a wrong version', (g: any) => { g.theme.v = 2; }],
        ['a non-boolean glow', (g: any) => { g.theme.glow = 'yes'; }],
    ])('refuses %s', (_why, mutate) => {
        const g = good();
        mutate(g);
        expect(parseCustomBootPayload(g)).toBeNull();
    });

    it('refuses oversize and garbage', () => {
        expect(parseCustomBootPayload('x'.repeat(CUSTOM_BOOT_JSON_MAX + 1))).toBeNull();
        expect(parseCustomBootPayload('{not json')).toBeNull();
        expect(parseCustomBootPayload(null)).toBeNull();
        expect(parseCustomBootPayload({ ...good(), pad: 'y'.repeat(CUSTOM_BOOT_JSON_MAX) })).toBeNull();
    });

    it('never stores the theme name', () => {
        const p = parseCustomBootPayload({ ...good(), name: 'secret' });
        expect(JSON.stringify(p)).not.toContain('secret');
    });
});

describe('device theme state with a custom theme', () => {
    const store = (pref: string | null, custom: string | null) => [() => pref, () => custom] as const;

    it('custom + valid copy: base id, custom palette', () => {
        const [p, c] = store(CUSTOM_THEME_PREF, JSON.stringify(good()));
        const s = readDeviceThemeStateWithCustom(p, c, true);
        expect(s).toMatchObject({ id: 'dark', pref: 'custom' });
        expect(paletteForState(s, bootPalette).windowBackground).toBe(ocean.colors.bg.toUpperCase());
    });

    it('custom + missing / invalid copy: the default built-in, never half-painted', () => {
        for (const bad of [null, '{}', 'garbage']) {
            const [p, c] = store(CUSTOM_THEME_PREF, bad);
            const s = readDeviceThemeStateWithCustom(p, c, true);
            expect(s).toEqual({ id: 'dark', pref: 'dark' });
            expect(paletteForState(s, bootPalette)).toEqual(bootPalette('dark'));
        }
    });

    it('built-ins behave as before (system follows the OS); a locked store reads as default', () => {
        expect(readDeviceThemeStateWithCustom(() => 'light', () => null, true)).toEqual({ id: 'light', pref: 'light' });
        expect(readDeviceThemeStateWithCustom(() => 'system', () => null, false)).toEqual({ id: 'light', pref: 'system' });
        expect(readDeviceThemeStateWithCustom(() => { throw new Error('locked'); }, () => null, true)).toEqual({ id: 'dark', pref: 'dark' });
    });

    it('every built-in reads back as itself; `system` picks High contrast when the OS asks; custom ignores the OS', () => {
        for (const id of ['dark', 'light', 'midnight', 'hc-dark', 'hc-light'] as const) {
            const s = readDeviceThemeStateWithCustom(() => id, () => null, true, true);
            expect(s).toEqual({ id, pref: id });
            expect(paletteForState(s, bootPalette)).toBe(bootPalette(id));
        }
        expect(readDeviceThemeStateWithCustom(() => 'system', () => null, true, true)).toEqual({ id: 'hc-dark', pref: 'system' });
        expect(readDeviceThemeStateWithCustom(() => 'system', () => null, false, true)).toEqual({ id: 'hc-light', pref: 'system' });
        expect(readDeviceThemeStateWithCustom(() => 'system', () => null, false, false)).toEqual({ id: 'light', pref: 'system' });
        // A custom theme is an explicit pick: the OS contrast setting never swaps it.
        const s = readDeviceThemeStateWithCustom(() => CUSTOM_THEME_PREF, () => JSON.stringify(good()), true, true);
        expect(s).toMatchObject({ id: 'dark', pref: 'custom' });
        // A custom payload's base stays dark | light: a built-in id beyond those is refused.
        for (const base of ['midnight', 'hc-dark', 'hc-light', 'system', 'custom']) {
            expect(parseCustomBootPayload({ ...good(), theme: { ...good().theme, base } })).toBeNull();
        }
    });
});
