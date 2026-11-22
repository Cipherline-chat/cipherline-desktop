/**
 * Main's side of the live theme preview (theme-custom-boot.ts
 * createWindowThemePreview; main.ts theme:preview / theme:preview-end): paint
 * the window from a validated payload, store nothing, put the real colours
 * back on end and on any page (re)load.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWindowThemePreview } from './theme-custom-boot';
import { bootPalette, type BootPalette } from './theme-boot';

const real = bootPalette('dark');
const payload = {
    id: 'preview',
    theme: { v: 1, base: 'light', colors: { bg: '#fff5f7', panel: '#ffe4ea', surface: '#ffffff', text: '#3a1020', muted: '#7a4a5a', accent: '#c2185b', onAccent: '#ffffff', danger: '#b00020', border: '#f0c0cc' }, glow: false },
    boot: {
        abyss: '#FFF5F7', deep: '#FFE4EA', surface: '#FFFFFF', border: '#F0C0CC', sink: '#FFF0F3', lume: '#C2185B', lumeHi: '#D81B60',
        lumeDeep: '#880E4F', glow: '#FFC94D', ok: '#2E7D32', text: '#3A1020', muted: '#7A4A5A', faint: '#8A5A6A', windowBackground: '#FFF5F7',
        titleBar: { color: '#FFF5F7', symbolColor: '#3A1020' }, card: '#FFFFFF', gradient: ['#FFF5F7', '#FFE4EA', '#FFFFFF'],
    },
};

function harness() {
    const painted: BootPalette[] = [];
    const p = createWindowThemePreview((c) => painted.push(c), () => real);
    return { p, painted };
}

describe('createWindowThemePreview', () => {
    it('start paints the payload\'s boot colours; end puts the real colours back', () => {
        const { p, painted } = harness();
        expect(p.start(payload)).toBe(true);
        expect(p.active()).toBe(true);
        expect(painted.at(-1)!.windowBackground).toBe('#FFF5F7');
        expect(painted.at(-1)!.titleBar).toEqual({ color: '#FFF5F7', symbolColor: '#3A1020' });
        expect(p.end()).toBe(true);
        expect(p.active()).toBe(false);
        expect(painted.at(-1)).toBe(real);
    });

    it('an invalid payload is refused and paints nothing', () => {
        const { p, painted } = harness();
        expect(p.start({ ...payload, boot: { ...payload.boot, windowBackground: 'red' } })).toBe(false);
        expect(p.start('not json')).toBe(false);
        expect(p.active()).toBe(false);
        expect(painted).toEqual([]);
    });

    it('end with no preview up does nothing (a reload with no preview never repaints)', () => {
        const { p, painted } = harness();
        expect(p.end()).toBe(false);
        expect(painted).toEqual([]);
    });
});

describe('main.ts wiring (source)', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const block = (start: string) => {
        const i = main.indexOf(start);
        expect(i, start).toBeGreaterThan(0);
        return main.slice(i, main.indexOf('});', i) + 3);
    };

    it('theme:preview validates and paints, and STORES NOTHING (no SecureStore, no session preference, no theme:changed)', () => {
        const h = block("ipcMain.handle('theme:preview',");
        expect(h).toContain('windowThemePreview.start(payload)');
        expect(h).not.toMatch(/secureStore|sessionTheme|theme:changed|paintWindowTheme/);
        const end = block("ipcMain.handle('theme:preview-end',");
        expect(end).toContain('windowThemePreview.end()');
        expect(end).not.toMatch(/secureStore|sessionTheme/);
    });

    it('a page (re)load ends a preview: the preload\'s synchronous boot ask drops it first', () => {
        expect(main).toContain("ipcMain.on('theme:get-sync', (e) => { windowThemePreview.end(); e.returnValue = deviceThemeState(); });");
    });

    it('a real theme change during a preview keeps the window on the preview colours but still tells the renderer', () => {
        expect(main).toContain('if (!windowThemePreview.active()) paintWindowColors(paletteForState(state, bootPalette));');
        expect(main).toContain("mainWindow.webContents.send('theme:changed', state);");
    });

    it('the preload exposes the two calls and nothing that stores', () => {
        const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8');
        expect(preload).toContain("previewTheme: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('theme:preview', payload),");
        expect(preload).toContain("endThemePreview: (): Promise<unknown> => ipcRenderer.invoke('theme:preview-end'),");
    });
});
