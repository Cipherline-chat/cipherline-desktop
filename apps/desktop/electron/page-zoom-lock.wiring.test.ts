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
        expect(MAIN).toMatch(/import \{ lockPageZoom, setIntendedZoomFactor, resetZoomToIntended \} from '\.\/page-zoom-lock';/);
    });

    it('the main window is locked in createWindow, SCALABLE, after the UI scale is applied', () => {
        const body = bodyOf(MAIN, /async function createWindow\(/);
        expect(body).toMatch(/lockPageZoom\(mainWindow\.webContents, \{\s*scalable: true,/);
        expect(body).toContain("onShortcut: (action) => { uiScale().step(mainWindow, action); }");
        expect(body.indexOf("uiScale().apply(mainWindow, 'init')")).toBeGreaterThan(-1);
        expect(body.indexOf("uiScale().apply(mainWindow, 'init')")).toBeLessThan(body.indexOf('lockPageZoom(mainWindow.webContents'));
        // first paint already scaled: the window is BUILT with the clamped factor
        expect(body).toContain('const initialZoom = uiScale().factorFor(');
        expect(body).toContain('zoomFactor: initialZoom,');
    });

    it('ONLY the main window is scalable (overlay/splash/popup/notice stay at 1)', () => {
        const all = fs.readdirSync(__dirname).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'page-zoom-lock.ts')
            .flatMap(f => (fs.readFileSync(path.join(__dirname, f), 'utf8').match(/scalable: true/g) ?? []).map(() => f));
        expect(all).toEqual(['main.ts']);
        expect(OVERLAY).toContain('lockPageZoom(win.webContents)');
    });

    it('the UI scale IPC is exactly get + set, set validated as a step', () => {
        expect(MAIN).toContain("ipcMain.handle('ui-scale:get'");
        expect(MAIN).toMatch(/ipcMain\.handle\('ui-scale:set', \(_e, percent: unknown\) => \{\s*if \(!isUiScaleStep\(percent\)\) throw/);
        expect((MAIN.match(/ipcMain\.handle\('ui-scale:/g) ?? []).length).toBe(2);
    });

    it('the installer splash is locked in createInstallerSplash', () => {
        expect(bodyOf(MAIN, /function createInstallerSplash\(/)).toContain('lockPageZoom(splash.webContents)');
    });

    it('the annotation overlay is locked in createOverlay', () => {
        expect(OVERLAY).toMatch(/import \{ lockPageZoom \} from '\.\/page-zoom-lock';/);
        expect(bodyOf(OVERLAY, /function createOverlay\(/)).toContain('lockPageZoom(win.webContents)');
    });

    it('the Linux wallet notice is locked in showKeyringNotice', () => {
        const NOTICE = fs.readFileSync(path.join(__dirname, 'keyring-notice.ts'), 'utf8');
        expect(NOTICE).toMatch(/import \{ lockPageZoom \} from '\.\/page-zoom-lock';/);
        expect(NOTICE).toContain('lockPageZoom(win.webContents)');
    });

    it('the "Applying update" popup is locked in openApplyingUpdateWindow', () => {
        const POPUP = fs.readFileSync(path.join(__dirname, 'applying-update-window.ts'), 'utf8');
        expect(POPUP).toMatch(/import \{ lockPageZoom \} from '\.\/page-zoom-lock';/);
        expect(bodyOf(POPUP, /function openApplyingUpdateWindow\(/)).toContain('lockPageZoom(win.webContents)');
    });

    it('every `new BrowserWindow(` in electron/ is accounted for (a new window must be locked or listed here)', () => {
        const hits: string[] = [];
        for (const f of fs.readdirSync(__dirname)) {
            if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
            const n = (fs.readFileSync(path.join(__dirname, f), 'utf8').match(/new BrowserWindow\(/g) ?? []).length;
            if (n) hits.push(`${f}:${n}`);
        }
        expect(hits.sort()).toEqual(['annotation-overlay.ts:1', 'applying-update-window.ts:1', 'keyring-notice.ts:1', 'main.ts:2']);
    });

    it('nothing else sets the zoom (the UI scale feeds page-zoom-lock, never setZoomFactor directly)', () => {
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
