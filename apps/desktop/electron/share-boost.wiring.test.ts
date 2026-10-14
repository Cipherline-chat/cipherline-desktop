import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { UNGUARDED_IPC_CHANNELS } from './ipc-guard';

/**
 * main.ts imports `electron` and cannot load under vitest, so (like
 * gaming-video-mode.wiring.test.ts) this reads the source to pin the WIRING of
 * "Prioritize screen share over games". The decisions are tested in
 * share-boost.test.ts; this proves main actually makes them.
 */
const dir = __dirname;
const MAIN = fs.readFileSync(path.resolve(dir, 'main.ts'), 'utf8');
const PRELOAD = fs.readFileSync(path.resolve(dir, 'preload.ts'), 'utf8');
const OVERLAY = fs.readFileSync(path.resolve(dir, 'annotation-overlay.ts'), 'utf8');
const SHARE_BOOST = fs.readFileSync(path.resolve(dir, 'share-boost.ts'), 'utf8');
const GAMING = fs.readFileSync(path.resolve(dir, 'gaming-video-mode.ts'), 'utf8');

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

describe('Chromium backgrounding switches (the screen-share-over-games launch half)', () => {
    it('the three switches and both Windows features are exactly what the launch code applies', () => {
        for (const sw of ['disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows', 'disable-background-timer-throttling']) {
            expect(GAMING).toContain(`'${sw}'`);
        }
        expect(GAMING).toContain("'CalculateNativeWinOcclusion'");
        expect(SHARE_BOOST).toContain("'UseEcoQoSForBackgroundProcess'");
    });

    it('main applies them before ready from the resolved startup flags, via launchThrottleSwitches', () => {
        expect(MAIN).toContain('const GAMING_VIDEO_AT_LAUNCH = STARTUP_FLAGS.gamingVideo;');
        expect(MAIN).toContain('launchThrottleSwitches(GAMING_VIDEO_AT_LAUNCH, process.platform)');
        expect(MAIN).toContain('for (const name of gamingSwitches.switches) app.commandLine.appendSwitch(name);');
        // Before `app.whenReady()` is ever awaited.
        const readyIdx = MAIN.indexOf('app.whenReady().then(');
        expect(readyIdx).toBeGreaterThan(-1);
        expect(MAIN.indexOf('launchThrottleSwitches(GAMING_VIDEO_AT_LAUNCH')).toBeLessThan(readyIdx);
    });

    it('disable-features is MERGED into the one media list, never appended on its own', () => {
        expect(MAIN.match(/appendSwitch\('disable-features'/g)?.length).toBe(1);
        const push = MAIN.indexOf('media.disableFeatures.push(...gamingSwitches.disableFeatures)');
        const append = MAIN.indexOf("app.commandLine.appendSwitch('disable-features'");
        expect(push).toBeGreaterThan(-1);
        expect(push).toBeLessThan(append);
        // ...and the list that is appended is the merged one.
        expect(MAIN.slice(append, append + 120)).toContain('media.disableFeatures.join');
    });

    it('every BrowserWindow runs with backgroundThrottling: false', () => {
        const windows = (src: string) => src.match(/new BrowserWindow\(/g)?.length ?? 0;
        // Option lines only: a comment may mention "backgroundThrottling:false".
        const flags = (src: string) => src.match(/^\s*backgroundThrottling:\s*false,/gm)?.length ?? 0;
        expect(windows(MAIN)).toBeGreaterThanOrEqual(2);
        expect(flags(MAIN)).toBe(windows(MAIN));
        expect(windows(OVERLAY)).toBe(1);
        expect(flags(OVERLAY)).toBe(1);
        expect(MAIN).not.toMatch(/backgroundThrottling:\s*true/);
    });

    it('the Electron security rules stay as they were', () => {
        expect(MAIN).not.toMatch(/sandbox:\s*false/);
        expect(MAIN).not.toMatch(/nodeIntegration:\s*true/);
        expect(MAIN).not.toMatch(/contextIsolation:\s*false/);
    });
});

describe('screen-share boost runtime wiring', () => {
    it('powerSaveBlocker is reached only through ShareBoostController, with prevent-app-suspension', () => {
        expect(MAIN).toMatch(/powerSaveBlocker \} from 'electron'/);
        expect(MAIN).toContain('new ShareBoostController(callPriority, {');
        expect(MAIN).toContain('const sharePriority = new ShareBoostController(');
        expect(MAIN).toContain('powerSaveBlocker.start(type)');
        expect(MAIN).toContain('powerSaveBlocker.stop(id)');
        expect(SHARE_BOOST).toContain("start(type: 'prevent-app-suspension'): number;");
        // No other caller starts a blocker behind the controller's back.
        expect(MAIN.match(/powerSaveBlocker\.start\(/g)?.length).toBe(1);
    });

    it('the process list handed to the booster carries the Electron process type (GPU and main get HIGH)', () => {
        expect(MAIN).toContain('listProcesses: () => app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type }))');
        expect(GAMING).toContain("(type === 'GPU' || type === 'Browser') ? PRIORITY_HIGH : PRIORITY_ABOVE_NORMAL");
    });

    it('share:set-active is a guarded handler that validates before acting', () => {
        const body = handlerSource('share:set-active');
        expect(body).toContain('validateShareActive(active)');
        expect(body).toContain('syncCallPriority({ sharing:');
        expect(UNGUARDED_IPC_CHANNELS.has('share:set-active')).toBe(false);
        expect(MAIN.indexOf("ipcMain.handle('share:set-active'")).toBeGreaterThan(MAIN.indexOf('installIpcSenderGuard();'));
    });

    it('ONE setting: saving it updates the call path and the share path together, at once, after validation', () => {
        const body = handlerSource('app:set-startup-flags');
        const validate = body.indexOf('validateStartupFlagsPatch(patch)');
        const sync = body.indexOf('syncCallPriority({ enabled: change.gamingVideo })');
        expect(validate).toBeGreaterThan(-1);
        expect(sync).toBeGreaterThan(validate);
        // ...and `enabled` is the only thing that feeds BOTH controllers.
        expect(MAIN).toContain('if (change.enabled !== undefined) applyGamingSetting(change.enabled, callPriority, sharePriority);');
        expect(MAIN.match(/sharePriority\.setEnabled\(/g)).toBeNull();
        expect(MAIN.match(/callPriority\.setEnabled\(/g)).toBeNull();
    });

    it('launch applies the saved value to both paths, and reports it as `active` for the restart offer', () => {
        expect(MAIN).toContain('syncCallPriority({ enabled: GAMING_VIDEO_AT_LAUNCH });');
        expect(MAIN).toMatch(/gamingVideo: GAMING_VIDEO_AT_LAUNCH,/);
    });

    it('the old separate screen-share setting is gone from main, preload and the typings', () => {
        for (const src of [MAIN, PRELOAD, SHARE_BOOST, GAMING, fs.readFileSync(path.resolve(dir, 'startup-flags.ts'), 'utf8'), fs.readFileSync(path.resolve(dir, '..', 'src', 'env.d.ts'), 'utf8')]) {
            expect(src).not.toMatch(/\bshareBoost\b/);
            expect(src).not.toMatch(/SHARE_BOOST_AT_LAUNCH/);
        }
    });

    it('the boost is released on renderer navigation, renderer crash and quit', () => {
        expect(MAIN).toMatch(/webContents\.on\('did-navigate', \(\) => syncCallPriority\(\{ inCall: false, sharing: false \}\)\)/);
        const gone = MAIN.indexOf("mainWindow.webContents.on('render-process-gone', (event, details) => {");
        expect(MAIN.slice(gone, gone + 400)).toContain('syncCallPriority({ inCall: false, sharing: false })');
        const quit = MAIN.indexOf("app.on('before-quit', () => {\n  // Gaming-video priority boost");
        expect(quit).toBeGreaterThan(-1);
        expect(MAIN.slice(quit, quit + 250)).toContain('syncCallPriority({ inCall: false, sharing: false })');
    });

    it('the preload bridge is one narrow boolean channel', () => {
        expect(PRELOAD).toContain("setShareActive: (active: boolean): Promise<void> =>\n        ipcRenderer.invoke('share:set-active', active),");
        expect(PRELOAD.match(/share:set-active/g)?.length).toBe(1);
    });
});
