/**
 * electron/theme-boot.ts is a MIRROR of src/theme/themes.ts (electron/ cannot
 * import src/ — rootDir trap). This test is the link: a test file may import
 * across, and tsconfig.electron.json excludes *.test.ts, so the electron build
 * layout is untouched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    BOOT_PALETTES, BOOT_THEME_IDS, BOOT_THEME_PREFERENCES, DEFAULT_BOOT_THEME_ID, THEME_STORE_KEY, bootPalette, parseStoredThemeId,
    readDeviceThemeId, readDeviceThemeState,
} from './theme-boot';
import { DEFAULT_THEME_ID, THEMES, THEME_IDS, THEME_PREFERENCES } from '../src/theme/themes';

describe('theme-boot mirrors the theme data', () => {
    it('same theme ids and default', () => {
        expect([...BOOT_THEME_IDS]).toEqual([...THEME_IDS]);
        expect(DEFAULT_BOOT_THEME_ID).toBe(DEFAULT_THEME_ID);
    });

    for (const id of BOOT_THEME_IDS) {
        it(`${id}: every boot colour equals the theme data`, () => {
            const t = THEMES[id];
            const b = BOOT_PALETTES[id];
            expect(b).toEqual({
                abyss: t.palette.abyss,
                deep: t.palette.deep,
                surface: t.palette.surface,
                border: t.palette.border,
                sink: t.palette.sink,
                lume: t.palette.lume,
                lumeHi: t.palette['lume-hi'],
                lumeDeep: t.palette['lume-deep'],
                glow: t.palette.glow,
                ok: t.palette.ok,
                text: t.palette.text,
                muted: t.palette.muted,
                faint: t.palette.faint,
                windowBackground: t.palette[t.boot.windowBackground],
                titleBar: { color: t.palette[t.boot.titleBar.color], symbolColor: t.palette[t.boot.titleBar.symbolColor] },
                card: t.palette[t.boot.card],
            });
        });
    }
});

describe('stored theme id', () => {
    it('parses only built-in ids; anything else is the default', () => {
        expect(THEME_STORE_KEY).toBe('theme');
        expect(parseStoredThemeId('dark')).toBe('dark');
        expect(parseStoredThemeId('light')).toBe('light');
        for (const id of ['midnight', 'hc-dark', 'hc-light'] as const) {
            expect(parseStoredThemeId(id)).toBe(id);
            expect(bootPalette(id)).toBe(BOOT_PALETTES[id]);
        }
        for (const bad of [null, undefined, '', 'LIGHT', 'DARK', 'Midnight', 'hc', 'high-contrast', '{"id":"dark"}']) expect(parseStoredThemeId(bad)).toBe('dark');
        expect(bootPalette('nope')).toBe(BOOT_PALETTES.dark);
        expect(bootPalette('light')).toBe(BOOT_PALETTES.light);
    });

    it('a stored `system` follows the OS (nativeTheme.shouldUseDarkColors)', () => {
        expect(parseStoredThemeId('system', true)).toBe('dark');
        expect(parseStoredThemeId('system', false)).toBe('light');
        expect(readDeviceThemeState(() => 'system', false)).toEqual({ id: 'light', pref: 'system' });
        expect(readDeviceThemeState(() => 'light', true)).toEqual({ id: 'light', pref: 'light' });
        expect(readDeviceThemeState(() => 'garbage', false)).toEqual({ id: 'dark', pref: 'dark' });
        expect(readDeviceThemeState(() => { throw new Error('locked'); }, false)).toEqual({ id: 'dark', pref: 'dark' });
        expect([...BOOT_THEME_PREFERENCES]).toEqual([...THEME_PREFERENCES]);
    });

    it('a stored `system` picks High contrast when the OS asks for more contrast; an explicit pick never changes', () => {
        expect(parseStoredThemeId('system', true, true)).toBe('hc-dark');
        expect(parseStoredThemeId('system', false, true)).toBe('hc-light');
        expect(readDeviceThemeState(() => 'system', true, true)).toEqual({ id: 'hc-dark', pref: 'system' });
        for (const id of ['dark', 'light', 'midnight', 'hc-dark', 'hc-light'] as const) {
            expect(readDeviceThemeState(() => id, false, true)).toEqual({ id, pref: id });
        }
    });

    it('a store that throws (locked / not ready) reads as the default', () => {
        expect(readDeviceThemeId(() => { throw new Error('locked'); })).toBe('dark');
        expect(readDeviceThemeId(() => 'dark')).toBe('dark');
    });
});

describe('main-process paint sites read the helper, not literal hex', () => {
    const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

    it('main window backgroundColor and the Windows title-bar overlay', () => {
        const main = read('main.ts');
        // Built-in themes through bootPalette; a custom theme through its validated boot copy (theme-custom-boot.ts).
        expect(main).toContain('const themeColors = paletteForState(deviceThemeState(), bootPalette);');
        expect(main).toContain('readDeviceThemeStateWithCustom(() => secureStore.get(THEME_STORE_KEY), () => secureStore.get(THEME_CUSTOM_STORE_KEY), systemDark, systemMoreContrast)');
        expect(main).toContain('readDeviceThemeStateWithCustom(() => sessionThemePref, () => sessionThemeCustom, systemDark, systemMoreContrast)');
        expect(main).toContain('if (!windowThemePreview.active()) paintWindowColors(paletteForState(state, bootPalette));');
        // Sync with system follows the OS high-contrast setting too.
        expect(main).toContain('nativeTheme.shouldUseHighContrastColors || nativeTheme.inForcedColorsMode === true');
        // Sync with system: main repaints when the OS flips; the preload asks synchronously (no flash).
        expect(main).toContain("nativeTheme.on('updated'");
        expect(main).toContain("ipcMain.on('theme:get-sync'");
        expect(main).toContain('backgroundColor: themeColors.windowBackground,');
        // The caption overlay (Windows + Linux) is built from the theme's title-bar pair (electron/window-chrome.ts).
        expect(main).toContain('titleBarOverlay: titleBarOverlayFor(process.platform, themeColors.titleBar),');
        expect(main).not.toMatch(/backgroundColor: '#0B0F1E'|color: '#0B0F1E'|symbolColor: '#F4F7FF'/);
    });

    it('update popup, wallet notice, splash tokens, tray', () => {
        expect(read('update-applying.ts')).toContain('APPLYING_CARD_BG = bootPalette().card');
        expect(read('keyring-notice.ts')).toContain("backgroundColor: transparent ? '#00000000' : bootPalette().windowBackground");
        expect(read('splash-style.ts')).toContain('--cl-abyss:   ${P.abyss};');
        expect(read('tray.ts')).not.toContain('stroke="#0B0F1E"');
    });

    it("the sandboxed preload's inline theme-id list equals BOOT_THEME_IDS (it cannot import theme-boot.ts)", () => {
        const m = /const PRELOAD_THEME_IDS: readonly string\[\] = (\[[^\]]*\]);/.exec(read('preload.ts'));
        expect(m, 'preload.ts PRELOAD_THEME_IDS').not.toBeNull();
        expect(JSON.parse(m![1].replace(/'/g, '"'))).toEqual([...BOOT_THEME_IDS]);
    });

    it("the preload's light-scheme and high-contrast id lists equal the theme data (data-scheme / data-contrast before first paint)", () => {
        const list = (name: string) => {
            const m = new RegExp(`const ${name}: readonly string\\[\\] = (\\[[^\\]]*\\]);`).exec(read('preload.ts'));
            expect(m, `preload.ts ${name}`).not.toBeNull();
            return JSON.parse(m![1].replace(/'/g, '"'));
        };
        expect(list('PRELOAD_LIGHT_SCHEME_IDS')).toEqual(THEME_IDS.filter((id) => THEMES[id].scheme === 'light'));
        expect(list('PRELOAD_HIGH_CONTRAST_IDS')).toEqual(THEME_IDS.filter((id) => THEMES[id].contrast === 'high'));
    });

    it('no file that reads the helper imports a value from ../src (rootDir trap)', () => {
        const offenders = readdirSync(__dirname)
            .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && read(f).includes("from './theme-boot'"))
            .filter((f) => /^import (?!type\b)[^;]*from '\.\.\/src\//m.test(read(f)));
        expect(offenders).toEqual([]);
        expect(read('theme-boot.ts')).not.toMatch(/^import /m);
    });
});
