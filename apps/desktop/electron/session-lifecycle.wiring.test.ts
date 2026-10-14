import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * main.ts imports `electron` and cannot load under vitest, so — like
 * updater.wiring.test.ts — this reads the source to pin the WIRING of the
 * crash-vs-quit rules. The rules themselves are tested in
 * session-lifecycle.test.ts; a rule nobody calls protects nothing.
 */
const MAIN = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');
/** main.ts with // comments removed, so prose cannot satisfy a code check. */
const CODE = MAIN.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

function block(src: string, marker: string, open = '{', close = '}'): string {
    const start = src.indexOf(marker);
    expect(start, `no "${marker}" in main.ts`).toBeGreaterThan(-1);
    const o = src.indexOf(open, start);
    let depth = 0;
    for (let i = o; i < src.length; i++) {
        if (src[i] === open) depth++;
        else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced after "${marker}"`);
}

describe('crash-vs-quit wiring in main.ts', () => {
    it('every crash source goes through recordCrash(event) → crashRecordFor with the quitting state', () => {
        expect(CODE).toContain("recordCrash({ source: 'main-exception', thrown: err, origin: 'uncaughtException' })");
        expect(CODE).toContain("recordCrash({ source: 'main-exception', thrown: reason, origin: 'unhandledRejection' })");
        expect(CODE).toContain("recordCrash({ source: 'render-process-gone', details })");
        expect(CODE).toContain("recordCrash({ source: 'child-process-gone', details })");
        expect(CODE).toContain("recordCrash({ source: 'renderer-report', payload })");
        expect(block(CODE, 'const recordCrash = ')).toContain('crashRecordFor(event, sessionLifecycle.isQuitting,');
        // No path builds a record without the gate.
        expect(CODE).not.toMatch(/pendingCrashes\.add\(crashFrom/);
        expect(CODE).not.toMatch(/\bcrashFrom(RenderGone|ChildGone|MainError|RendererReport)\(/);
    });

    it('the FIRST before-quit listener drops the marker (a throwing later listener cannot skip it)', () => {
        // Listeners run in registration order. Module top level (column 0)
        // registers before anything inside app.whenReady() (indented), so the
        // first column-0 one is the first to run.
        const topLevel = [...CODE.matchAll(/^app\.on\('before-quit'.*$/gm)].map(m => m[0]);
        expect(topLevel[0]).toBe("app.on('before-quit', () => beginQuit('before-quit'));");
        expect(topLevel.length).toBeGreaterThan(1);
        // will-quit keeps an idempotent fallback
        expect(block(CODE, "app.on('will-quit', () => {\n  try { secureStore.flush()")).toContain("beginQuit('before-quit')");
    });

    it('Restart & install drops the marker BEFORE handing over to the installer, and a failed install re-arms it', () => {
        const install = block(CODE, "ipcMain.handle('updater:quit-and-install'", '(', ')');
        const begin = install.indexOf("beginQuit('quit-and-install')");
        expect(begin).toBeGreaterThan(-1);
        expect(install.indexOf('autoUpdater.quitAndInstall(')).toBeGreaterThan(begin);
        const onError = block(CODE, "autoUpdater.on('error'", '(', ')');
        expect(onError).toMatch(/if \(installRequested\) \{[\s\S]*setIsQuitting\(false\);[\s\S]*sessionLifecycle\.cancelQuit\(\);/);
    });

    it('OS session end, OS shutdown and relaunch are quits', () => {
        expect(CODE).toContain("mainWindow.on('session-end', () => beginQuit('session-end'));");
        expect(CODE).toContain("powerMonitor.on('shutdown', () => beginQuit('os-shutdown'));");
        expect(block(CODE, "ipcMain.handle('app:relaunch'", '(', ')')).toMatch(/beginQuit\('relaunch'\);\s*app\.relaunch\(\);/);
    });

    it('the marker is taken over only after the port is won — never before the second-instance hand-off', () => {
        const cw = block(CODE, 'async function createWindow(');
        const handoff = cw.indexOf('handOffToRunningInstance(');
        const exit0 = cw.indexOf('app.exit(0)');
        const serving = cw.indexOf('Serving dist/ on');
        expect(handoff).toBeGreaterThan(-1);
        expect(exit0).toBeGreaterThan(handoff);
        const starts = [...cw.matchAll(/startSessionMarker\(\);/g)].map(m => m.index!);
        // exactly two: the dev-server branch and right after a successful bind
        expect(starts).toHaveLength(2);
        const devBranch = cw.indexOf('if (url) {');
        expect(starts[0]).toBeGreaterThan(devBranch);
        expect(starts[0]).toBeLessThan(cw.indexOf('} else {', devBranch));
        expect(starts[1]).toBeGreaterThan(serving);
        expect(starts[1]).toBeGreaterThan(exit0);
        // and nowhere else in main.ts
        expect([...CODE.matchAll(/startSessionMarker\(\);/g)]).toHaveLength(2);
    });

    it('macOS re-creating the window reuses this process\'s server instead of handing off to itself + app.exit(0)', () => {
        const cw = block(CODE, 'async function createWindow(');
        const reuse = cw.indexOf('} else if (prodServerListening) {');
        expect(reuse).toBeGreaterThan(-1);
        expect(reuse).toBeLessThan(cw.indexOf('http.createServer('));
        expect(cw).toMatch(/Serving dist\/ on[^\n]*\n\s*prodServerListening = true;/);
    });

    it('a renderer gone during a quit is not "recovered" (no reload, no error dialog)', () => {
        const gone = block(CODE, "mainWindow.webContents.on('render-process-gone'", '(', ')');
        const guard = gone.indexOf('if (sessionLifecycle.isQuitting) {');
        expect(guard).toBeGreaterThan(-1);
        expect(gone.indexOf('dialog.showErrorBox')).toBeGreaterThan(guard);
        expect(gone.indexOf('webContents.reload()')).toBeGreaterThan(guard);
    });

    it('the marker stays off under the smoke test (no startup disk writes)', () => {
        expect(CODE).toMatch(/const SESSION_MARKER_ENABLED = !IS_SMOKE_TEST && /);
        expect(block(CODE, 'const sessionLifecycle = new SessionLifecycle(')).toContain('markerEnabled: SESSION_MARKER_ENABLED');
    });
});
