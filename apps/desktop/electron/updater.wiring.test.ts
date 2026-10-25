import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { UNGUARDED_IPC_CHANNELS } from './ipc-guard';

/**
 * main.ts imports `electron` and cannot load under vitest, so — like
 * staging-lock.wiring.test.ts — this reads the source to pin the WIRING of the
 * in-app update policy. The policy itself is tested in
 * src/utils/updaterState.test.ts and the verifier in authenticode-verify.test.ts;
 * a policy nobody calls protects nothing.
 */
const MAIN = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');
const UPDATE_CHECK = fs.readFileSync(path.resolve(__dirname, 'update-check.ts'), 'utf8');
const PRELOAD =fs.readFileSync(path.resolve(__dirname, 'preload.ts'), 'utf8');

/** Balanced-bracket slice starting at the first `open` after `marker`. */
function block(marker: string, open = '{', close = '}', from = 0): string {
    const start = MAIN.indexOf(marker, from);
    expect(start, `no "${marker}" in main.ts`).toBeGreaterThan(-1);
    const o = MAIN.indexOf(open, start);
    let depth = 0;
    for (let i = o; i < MAIN.length; i++) {
        if (MAIN[i] === open) depth++;
        else if (MAIN[i] === close && --depth === 0) return MAIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced after "${marker}"`);
}

const CONFIGURE = block('const configureUpdater = () =>');
const ON_ERROR = block("autoUpdater.on('error'", '(', ')');
const RETRY = block('const runUpdateRetry = async');

describe('in-app update wiring in main.ts', () => {
    it('the error listener decides via onUpdateError and schedules runUpdateRetry on a backoff timer', () => {
        expect(ON_ERROR).toContain('onUpdateError(current,');
        expect(ON_ERROR).toContain('classifyUpdateError(e, process.platform)');
        expect(ON_ERROR).toMatch(/retryTimer = setTimeout\(\(\) => \{[\s\S]*runUpdateRetry\('auto'\)[\s\S]*\}, decision\.retryInMs\)/);
    });

    it('the error listener records a scrubbed diagnostic event and logs code + phase + message', () => {
        expect(ON_ERROR).toMatch(/freezeMonitor\.event\(inFlight \? 'updater:error' : 'updater:check-error', 0, updaterErrorDetail\(e, decision, scrubForDiag\)\)/);
        expect(ON_ERROR).toContain('diagScrubber().text(');
        expect(ON_ERROR).toMatch(/console\.error\(\s*`\[Main\/Updater\] error\$\{code/);
    });

    it('an install failure brings the hidden window back instead of leaving a half-quit app', () => {
        expect(ON_ERROR).toMatch(/if \(installRequested\) \{[\s\S]*setIsQuitting\(false\)[\s\S]*showAndFocusWindow\(mainWindow\)[\s\S]*onInstallError/);
        expect(block("ipcMain.handle('updater:quit-and-install'", '(', ')')).toContain('installRequested = true');
    });

    it('a retry clears the pending download BEFORE re-checking', () => {
        const clear = RETRY.indexOf('await clearPendingUpdateCache()');
        const check = RETRY.indexOf('checkForUpdatesHandled()');
        expect(clear).toBeGreaterThan(-1);
        expect(check).toBeGreaterThan(clear);
        // …and never under a live download.
        expect(RETRY).toMatch(/s\.phase === 'available' \|\| s\.phase === 'downloading' \|\| s\.phase === 'ready'\) return/);
    });

    it('every update check handles the auto-download promise (no unhandledRejection "crash" per failed download)', () => {
        const bare = MAIN.match(/autoUpdater\.checkForUpdates\(\)/g) ?? [];
        expect(bare).toHaveLength(1); // only inside the helper
        const helper = block('const checkForUpdatesHandled = createHandledUpdateCheck', '(', ')');
        expect(helper).toContain('check: () => autoUpdater.checkForUpdates()');
        expect(helper).toContain('onDownloadRejected:');
        // the .catch on the downloadPromise lives in update-check.ts (behaviour: update-check.test.ts)
        expect(UPDATE_CHECK).toMatch(/result\?\.downloadPromise\?\.catch\(/);
        // every other caller (startup, hourly, wake, network, manual, channel) goes through the scheduler's run()
        expect((MAIN.match(/checkForUpdatesHandled\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it('the Windows verifier replacement is installed inside configureUpdater, win32 only', () => {
        expect(CONFIGURE).toMatch(/if \(process\.platform === 'win32'\) \{[\s\S]*\.verifyUpdateCodeSignature = createAuthenticodeVerifier\(/);
        expect(CONFIGURE).toContain('autoUpdater.logger = updaterLog');
    });

    it('the hardening flags are still set', () => {
        expect(CONFIGURE).toContain('autoUpdater.allowDowngrade = false');
        expect(CONFIGURE).toContain('autoUpdater.disableDifferentialDownload = true');
        expect(CONFIGURE).toContain('autoUpdater.disableWebInstaller = true');
    });

    it('the update-manifest signature provider is installed in configureUpdater, for every platform', () => {
        const install = CONFIGURE.indexOf('withManifestSignatureCheck(GenericProvider,');
        expect(install).toBeGreaterThan(-1);
        expect(CONFIGURE).toContain("require('electron-updater/out/providers/GenericProvider')");
        expect(CONFIGURE).toMatch(/autoUpdater\.setFeedURL\(\{ provider: 'custom', updateProvider: SignedProvider, url: UPDATE_BASE_URL \}/);
        expect(CONFIGURE).toContain('keysFor: (ch) => UPDATE_MANIFEST_PUBLIC_KEYS[ch]');
        expect(CONFIGURE).toContain('isManifestSignatureRequired(REQUIRE_MANIFEST_SIG[ch], process.platform)');
        expect(CONFIGURE).toContain('manifestCheckInstalled = true');
        // NOT inside the win32-only block
        const winBlock = CONFIGURE.indexOf("if (process.platform === 'win32') {");
        const winEnd = CONFIGURE.indexOf("autoUpdater.on('update-available'");
        expect(install > winBlock && install < winEnd).toBe(true);
        expect(CONFIGURE.slice(winBlock, install)).toMatch(/\n {4}\}\n/); // the win32 block closed before it
        // installed before the first check can run: checks are no longer scheduled inside configureUpdater at all,
        // and the scheduler's run() calls configureUpdater() first
        expect(CONFIGURE).not.toMatch(/setInterval\(|UPDATE_CHECK_DELAY_MS|4 \* 60 \* 60/);
        const run = block('run: async (reason: CheckReason)', '{', '}');
        expect(run.indexOf('configureUpdater()')).toBeGreaterThan(-1);
        expect(run.indexOf('configureUpdater()')).toBeLessThan(run.indexOf('checkForUpdatesHandled()'));
    });

    it('a REQUIRED signature with no verifier installed refuses to check (fail closed)', () => {
        const helper = block('const checkForUpdatesHandled = createHandledUpdateCheck', '(', ')');
        expect(helper).toContain('blocked: () => (!manifestCheckInstalled && isManifestSignatureRequired(');
        expect(helper).toContain("new ManifestVerificationError('verifier-unavailable'");
        // …and the helper consults it BEFORE it ever asks electron-updater
        expect(UPDATE_CHECK.indexOf('deps.blocked()')).toBeGreaterThan(-1);
        expect(UPDATE_CHECK.indexOf('deps.blocked()')).toBeLessThan(UPDATE_CHECK.indexOf('deps.check()'));
    });

    it('every channel switch re-pins allowDowngrade (electron-updater\'s channel setter turns it back on)', () => {
        const apply = block('function applyUpdateChannel(');
        expect(apply).toMatch(/autoUpdater\.channel = ch;\s*(\/\/[^\n]*\n\s*)*autoUpdater\.allowDowngrade = false;/);
        expect(CONFIGURE.indexOf('autoUpdater.channel = initialChannel')).toBeLessThan(CONFIGURE.indexOf('autoUpdater.allowDowngrade = false'));
        expect((MAIN.match(/autoUpdater\.channel = /g) ?? []).length).toBe(2); // only those two
    });

    it('nothing on the main-process update path opens a browser', () => {
        for (const src of [CONFIGURE, RETRY, block("ipcMain.handle('updater:retry'", '(', ')')]) {
            expect(src).not.toMatch(/openExternal/);
        }
    });

    it('updater:retry is registered, exposed by the preload, and sender-guarded', () => {
        expect(MAIN).toContain("ipcMain.handle('updater:retry'");
        expect(PRELOAD).toContain("retryUpdate: (): Promise<boolean> => ipcRenderer.invoke('updater:retry')");
        expect(UNGUARDED_IPC_CHANNELS.has('updater:retry')).toBe(false);
    });

    it('"Check now" after a failed attempt goes through the same retry path', () => {
        const checkNow = block("ipcMain.handle('updater:check-now'", '(', ')');
        expect(checkNow).toMatch(/updateState\.phase === 'retrying' \|\| updateState\.phase === 'failed' \|\| updateState\.phase === 'manual'\)[\s\S]*runUpdateRetry\('user'\)/);
    });

    it('the dev simulator still exists, only behind the dev server, and covers the new phases', () => {
        const sim = MAIN.indexOf("ipcMain.handle('updater:__simulate'");
        expect(sim).toBeGreaterThan(-1);
        const guard = MAIN.lastIndexOf('if (DEV_SERVER_URL) {', sim);
        expect(guard).toBeGreaterThan(-1);
        expect(MAIN.slice(guard, sim)).not.toMatch(/\n {2}\}\n/); // still inside that block
        const simSrc = block("ipcMain.handle('updater:__simulate'", '(', ')');
        for (const p of ['retrying', 'failed-verify', 'failed-install', 'ready', 'manual']) expect(simSrc).toContain(`'${p}'`);
    });

    it('no SecureStore write was added to the updater path (smoke-test SecureStore trap)', () => {
        for (const src of [CONFIGURE, RETRY, ON_ERROR]) expect(src).not.toMatch(/secureStore\.set\(/);
    });
});
