import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * main.ts / annotation-overlay.ts import `electron` and cannot load under
 * vitest, so this reads their source to pin the WIRING: the policy is tested in
 * page-zoom-lock.test.ts, but the bug class is a window that never gets it.
 */
const read = (f: string) => fs.readFileSync(path.resolve(__dirname, f), 'utf8');
const MAIN = read('main.ts');
const OVERLAY = read('annotation-overlay.ts');

/** Source of the function whose declaration starts at `header`. */
function bodyOf(src: string, header: RegExp): string {
    const m = header.exec(src);
    expect(m, `no function matching ${header}`).not.toBeNull();
    const open = src.indexOf('{', src.indexOf(')', m!.index));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m!.index, i + 1);
    }
    throw new Error('unbalanced braces');
}

describe('page-zoom lock wiring', () => {
    it('main.ts imports the module', () => {
        expect(MAIN).toMatch(/import \{ lockPageZoom \} from '\.\/page-zoom-lock';/);
    });

    it('the main window is locked in createWindow', () => {
        expect(bodyOf(MAIN, /async function createWindow\(/)).toContain('lockPageZoom(mainWindow.webContents)');
    });

    it('the installer splash is locked in createInstallerSplash', () => {
        expect(bodyOf(MAIN, /function createInstallerSplash\(/)).toContain('lockPageZoom(splash.webContents)');
    });

    it('the annotation overlay is locked in createOverlay', () => {
        expect(OVERLAY).toMatch(/import \{ lockPageZoom \} from '\.\/page-zoom-lock';/);
        expect(bodyOf(OVERLAY, /function createOverlay\(/)).toContain('lockPageZoom(win.webContents)');
    });

    it('every `new BrowserWindow(` in electron/ is accounted for (a new window must be locked or listed here)', () => {
        const hits: string[] = [];
        for (const f of fs.readdirSync(__dirname)) {
            if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
            const n = (fs.readFileSync(path.join(__dirname, f), 'utf8').match(/new BrowserWindow\(/g) ?? []).length;
            if (n) hits.push(`${f}:${n}`);
        }
        expect(hits.sort()).toEqual(['annotation-overlay.ts:1', 'main.ts:2']);
    });

    it('nothing else sets the zoom (no in-app scale exists; if one is added it must feed page-zoom-lock)', () => {
        for (const f of fs.readdirSync(__dirname)) {
            if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'page-zoom-lock.ts') continue;
            expect(fs.readFileSync(path.join(__dirname, f), 'utf8'), f).not.toMatch(/setZoom(Factor|Level)\(/);
        }
    });

    it('negative control: the detector fails on a window that is not locked', () => {
        const unlocked = 'function createOverlay(b) {\n  const win = new BrowserWindow({});\n  win.setMenu(null);\n}\n';
        expect(bodyOf(unlocked, /function createOverlay\(/)).not.toContain('lockPageZoom(win.webContents)');
    });
});
