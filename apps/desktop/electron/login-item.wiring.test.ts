import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * main.ts imports `electron` and cannot load under vitest, so this reads its
 * source to pin the WIRING of the login-item fix: the policy is tested in
 * login-item.test.ts, but the bug was main.ts calling the API with the wrong
 * arguments, which no policy test can see.
 */
const MAIN = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');
const PRELOAD = fs.readFileSync(path.resolve(__dirname, 'preload.ts'), 'utf8');

function handlerSource(channel: string): string {
    const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
    expect(start, `no ipcMain.handle registration for '${channel}'`).toBeGreaterThan(-1);
    const open = MAIN.indexOf('(', start);
    let depth = 0;
    for (let i = open; i < MAIN.length; i++) {
        if (MAIN[i] === '(') depth++;
        else if (MAIN[i] === ')' && --depth === 0) return MAIN.slice(open, i + 1);
    }
    throw new Error(`unbalanced parentheses in '${channel}'`);
}

describe('login-item wiring in main.ts', () => {
    it('no bare getLoginItemSettings() reads openAtLogin (args would default to [] and miss --autostart)', () => {
        const bare = [...MAIN.matchAll(/app\.getLoginItemSettings\(\)\.(\w+)/g)].map(m => m[1]);
        // The only bare read allowed is macOS's wasOpenedAtLogin (no path/args there).
        expect(bare.every(p => p === 'wasOpenedAtLogin'), `bare reads: ${bare.join(', ')}`).toBe(true);
        // Positive control: the pattern does match the line the bug lived on.
        expect([...'return app.getLoginItemSettings().openAtLogin;'.matchAll(/app\.getLoginItemSettings\(\)\.(\w+)/g)].map(m => m[1]))
            .toEqual(['openAtLogin']);
    });

    it('every other getLoginItemSettings call passes the target-derived query', () => {
        const calls = [...MAIN.matchAll(/app\.getLoginItemSettings\(([^)]*)\)/g)].map(m => m[1].trim());
        for (const args of calls) {
            if (args === '') continue; // the wasOpenedAtLogin read, checked above
            expect(args).toMatch(/^electronLoginItemQuery\(/);
        }
        expect(calls.filter(a => a !== '').length).toBeGreaterThanOrEqual(2);
    });

    it('setLoginItemSettings with --autostart is never hand-written (only via electronLoginItemSettings)', () => {
        expect(MAIN).not.toMatch(/setLoginItemSettings\([^)]*'--autostart'/);
    });

    it('the IPC handlers go through readLoginItemState / writeLoginItem', () => {
        expect(handlerSource('app:get-start-with-windows')).toContain('readLoginItemState()');
        expect(handlerSource('app:get-login-item-state')).toContain('readLoginItemState()');
        const set = handlerSource('app:set-start-with-windows');
        expect(set).toContain('writeLoginItem(enabled, target)');
        expect(set).toContain('return readLoginItemState(target)');
        expect(set).toMatch(/typeof enabled !== 'boolean'/);
    });

    it('defaults resolve through resolveBoolPref everywhere minimizeToTray/startMinimized are read', () => {
        expect(MAIN).not.toMatch(/secureStore\.get\('minimizeToTray'\)\s*===\s*'true'/);
        expect(MAIN).not.toMatch(/secureStore\.get\('startMinimized'\)\s*!==\s*'false'/);
    });

    it('the close handler refuses to hide without a tray icon', () => {
        expect(MAIN).toMatch(/shouldHideToTrayOnClose\(\{[^}]*trayExists:\s*getTray\(\)\s*!==\s*null/);
    });

    it('the startup loginItemDefaultApplied write is gated on the smoke test and the store', () => {
        const at = MAIN.indexOf("secureStore.set('loginItemDefaultApplied'");
        expect(at).toBeGreaterThan(-1);
        const block = MAIN.slice(MAIN.lastIndexOf('// ── Start at login: default ON', at), at);
        expect(block).toContain('shouldApplyLoginDefault({ target, storeOk: flagReadable, isSmokeTest: IS_SMOKE_TEST');
        expect(block).toMatch(/let flagReadable = storeOk && !IS_SMOKE_TEST/);
    });

    it('preload exposes the state channel', () => {
        expect(PRELOAD).toContain("ipcRenderer.invoke('app:get-login-item-state')");
    });
});
