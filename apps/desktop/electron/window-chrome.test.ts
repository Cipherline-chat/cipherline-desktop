/**
 * Who draws the main window's caption buttons (electron/window-chrome.ts), and
 * that main.ts actually routes both the BrowserWindow option and the live
 * theme repaint through it. 2026-11-21: Linux now uses the native overlay
 * like Windows (the HTML buttons were swallowed by a drag strip in 1.0.23).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { usesNativeCaptionOverlay, titleBarOverlayFor, TITLE_BAR_HEIGHT_PX } from './window-chrome';
import { BOOT_THEME_IDS, bootPalette } from './theme-boot';

const main = readFileSync(resolve(__dirname, 'main.ts'), 'utf8');

describe('usesNativeCaptionOverlay', () => {
    it.each([
        ['win32', true],
        ['linux', true],
        ['darwin', false],   // traffic lights, never an overlay
        ['freebsd', false],
        ['', false],
    ])('%s -> %s', (platform, expected) => {
        expect(usesNativeCaptionOverlay(platform)).toBe(expected);
    });
});

describe('titleBarOverlayFor', () => {
    const colours = { color: '#0B0F1E', symbolColor: '#F4F7FF' };

    it('is the theme colours at the title bar height on Windows and Linux', () => {
        for (const p of ['win32', 'linux']) {
            expect(titleBarOverlayFor(p, colours)).toEqual({ ...colours, height: 34 });
        }
        expect(TITLE_BAR_HEIGHT_PX).toBe(34);
    });

    it('is undefined on macOS (no overlay option at all)', () => {
        expect(titleBarOverlayFor('darwin', colours)).toBeUndefined();
    });

    it('carries every built-in theme through unchanged on Linux', () => {
        for (const id of BOOT_THEME_IDS) {
            const pal = bootPalette(id);
            expect(titleBarOverlayFor('linux', pal.titleBar)).toEqual({ color: pal.titleBar.color, symbolColor: pal.titleBar.symbolColor, height: 34 });
        }
    });
});

describe('main.ts wiring', () => {
    it('the main BrowserWindow takes its overlay from titleBarOverlayFor', () => {
        expect(main).toContain('titleBarOverlay: titleBarOverlayFor(process.platform, themeColors.titleBar),');
    });

    it('the live theme repaint uses the same helper (no win32-only branch left)', () => {
        const fn = main.slice(main.indexOf('function paintWindowColors('), main.indexOf('\n}\n', main.indexOf('function paintWindowColors(')));
        expect(fn).toContain('titleBarOverlayFor(process.platform, colors.titleBar)');
        expect(fn).toContain('setTitleBarOverlay(overlay)');
        expect(fn).not.toMatch(/platform === 'win32'/);
    });

    it('no other titleBarOverlay option is scoped to win32 only', () => {
        expect(main).not.toMatch(/titleBarOverlay:\s*process\.platform === 'win32'/);
    });

    it('positive control: the pre-fix option would fail the wiring check', () => {
        const before = main.replace('titleBarOverlay: titleBarOverlayFor(process.platform, themeColors.titleBar),', "titleBarOverlay: process.platform === 'win32' ? {");
        expect(before).toMatch(/titleBarOverlay:\s*process\.platform === 'win32'/);
    });
});
