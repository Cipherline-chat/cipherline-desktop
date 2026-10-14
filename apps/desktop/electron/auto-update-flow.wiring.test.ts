import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * main.ts cannot load under vitest, so this pins the WIRING of the automatic
 * update flow (the behaviour itself is tested in update-check-scheduler.test.ts
 * and update-install.test.ts). A scheduler nobody starts protects nothing.
 */
const MAIN = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');
const CODE = MAIN.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

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

describe('automatic update flow wiring', () => {
    it('the old schedule is gone: no 4-hour interval, no 30 s one-shot', () => {
        expect(CODE).not.toMatch(/4 \* 60 \* 60 \* 1000/);
        expect(CODE).not.toContain('UPDATE_CHECK_DELAY_MS');
        expect(CODE).not.toContain('checkForUpdatesQuietly');
        expect(CODE).not.toContain('setTimeout(configureUpdater');
    });

    it('the schedule starts right after the window exists, and only in a real install', () => {
        const create = CODE.indexOf('await createWindow(csp, showInstaller);');
        expect(create).toBeGreaterThan(-1);
        expect(CODE.slice(create, create + 200)).toContain('void startUpdateSchedule();');
        const start = block(CODE, 'const startUpdateSchedule = async');
        expect(start).toMatch(/if \(!UPDATER_ENABLED\) return;/);
        expect(start).toContain('installCoordinator.settleAtBoot()');
        expect(start).toContain('hasPendingDownload()');
        expect(start).toContain('updateScheduler.start(');
        expect(start).toMatch(/power\.onPhase\(\(phase\) => \{ if \(phase === 'resume'\) updateScheduler\.noteResume\(\)/);
    });

    it('network-online is observed from the main process (net.isOnline), no new IPC', () => {
        expect(CODE).toContain('isOnline: () => net.isOnline()');
    });

    it('every check — manual and channel switch included — goes through the scheduler (never stacks)', () => {
        expect(block(CODE, "ipcMain.handle('updater:check-now'", '(', ')')).toContain("updateScheduler.check('manual')");
        expect(block(CODE, 'function applyUpdateChannel(')).toContain("updateScheduler.check('channel')");
    });

    it('each check is logged and recorded as updater:check (scrubbed detail)', () => {
        const dep = block(CODE, 'const updateScheduler = new UpdateCheckScheduler(', '(', ')');
        expect(dep).toContain("log: (line) => console.log(`[Main/Updater] ${line}`)");
        expect(dep).toMatch(/freezeMonitor\.event\('updater:check', 0, toDiagnosticDetail\(/);
        // error results carry the code only, never the message
        expect(dep).toContain('describeError: (e) => `error code=${updaterErrorCode(e)}`');
    });

    it('the downloaded event reaches the install coordinator with the from-cache signal, and install failures reach it too', () => {
        expect(block(CODE, "autoUpdater.on('update-downloaded'", '(', ')')).toContain('installCoordinator.onUpdateDownloaded(info, !sawDownloadProgress)');
        expect(block(CODE, "autoUpdater.on('download-progress'", '(', ')')).toContain('sawDownloadProgress = true');
        expect(block(CODE, "autoUpdater.on('update-available'", '(', ')')).toContain('sawDownloadProgress = false');
        const err = block(CODE, "autoUpdater.on('error'", '(', ')');
        expect(err).toMatch(/if \(installRequested\) \{\s*installCoordinator\.onInstallFailed\(\);\s*dismissInstallingUi\(\);/);
    });

    it('the automatic install is silent + relaunching, marks a clean quit first, and never runs during a call', () => {
        const dep = block(CODE, 'const installCoordinator = new UpdateInstallCoordinator(', '(', ')');
        expect(dep).toContain('quitAndInstall: () => autoUpdater.quitAndInstall(true, true)');
        expect(dep).toContain('beginQuit: (trigger) => beginQuit(trigger)');
        expect(dep).toContain('inCall: () => callMediaActive');
        expect(dep).toContain('isQuitting: () => sessionLifecycle.isQuitting');
        expect(CODE).toMatch(/if \(change\.inCall !== undefined\) \{ callPriority\.setInCall\(change\.inCall\); callMediaActive = change\.inCall; \}/);
    });

    it('close-to-tray remembers when it hid the window, and showing it again gives the updater its chance', () => {
        expect(CODE).toMatch(/mainWindow\?\.hide\(\);\s*trayHiddenAt = Date\.now\(\);/);
        expect(CODE).toMatch(/win\.on\('show', \(\) => \{[\s\S]*onWindowReopened\(Date\.now\(\) - at\)/);
        expect(CODE).toContain("installCoordinator.onWindowReopened(updateState.version, hiddenForMs)");
    });

    it('a relaunch with a downloaded update goes through quitAndInstall instead of racing app.relaunch()', () => {
        const rl = block(CODE, "ipcMain.handle('app:relaunch'", '(', ')');
        expect(rl.indexOf("updateState.phase === 'ready'")).toBeGreaterThan(-1);
        expect(rl.indexOf('quitAndInstall(true, true)')).toBeGreaterThan(rl.indexOf("updateState.phase === 'ready'"));
        expect(rl.indexOf('quitAndInstall(true, true)')).toBeLessThan(rl.indexOf('app.relaunch()'));
    });

    it('app.exit() skips electron-updater\'s quit hook: exactly the four known sites exist (smoke fail, 2nd-instance hand-off x2, fatal init)', () => {
        // Adding a fifth means deciding whether a downloaded update should install on that path.
        expect((CODE.match(/app\.exit\(/g) ?? []).length).toBe(4);
    });

    it('every other quit path ends in app.quit() (which emits `quit`, so autoInstallOnAppQuit fires)', () => {
        expect(block(CODE, "app.on('window-all-closed'")).toContain('app.quit()');
        const tray = fs.readFileSync(path.resolve(__dirname, 'tray.ts'), 'utf8');
        expect(tray).toMatch(/label: 'Quit Cipherline',[\s\S]*?app\.quit\(\)/);
        expect(CODE).toContain('autoUpdater.autoInstallOnAppQuit = true');
    });

    it('no SecureStore write on any new startup/updater path (smoke-test SecureStore trap)', () => {
        for (const m of ['const startUpdateSchedule = async', 'const installCoordinator = new UpdateInstallCoordinator(', 'const updateScheduler = new UpdateCheckScheduler(']) {
            expect(block(CODE, m, m.includes('(') ? '(' : '{', m.includes('(') ? ')' : '}')).not.toMatch(/secureStore\.set\(/);
        }
        const mod = fs.readFileSync(path.resolve(__dirname, 'update-install.ts'), 'utf8');
        expect(mod).not.toMatch(/secureStore/);
    });
});
