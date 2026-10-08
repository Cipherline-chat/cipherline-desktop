import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { UNGUARDED_IPC_CHANNELS } from './ipc-guard';

/**
 * main.ts imports `electron` and cannot load under vitest, so — like
 * staging-lock.wiring.test.ts — this reads the source to pin the WIRING of the
 * gaming-video mode. The decisions are tested in gaming-video-mode.test.ts;
 * this proves main actually makes them, through the guarded IPC path.
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

describe('gaming-video mode wiring in main.ts', () => {
    it('call:set-media-active is a guarded handler that validates before acting', () => {
        const body = handlerSource('call:set-media-active');
        expect(body).toContain('validateCallMediaActive(active)');
        expect(body).toContain('syncCallPriority({ inCall:');
        expect(UNGUARDED_IPC_CHANNELS.has('call:set-media-active')).toBe(false);
        expect(MAIN.indexOf("ipcMain.handle('call:set-media-active'")).toBeGreaterThan(MAIN.indexOf('installIpcSenderGuard();'));
    });

    it('saving the setting updates the runtime half immediately, after validation', () => {
        const body = handlerSource('app:set-startup-flags');
        const validate = body.indexOf('validateStartupFlagsPatch(patch)');
        const sync = body.indexOf('syncCallPriority({ enabled: change.gamingVideo })');
        expect(validate).toBeGreaterThan(-1);
        expect(sync).toBeGreaterThan(validate);
    });

    it('the launch-time switches come from the resolved startup flags and share ONE disable-features list', () => {
        expect(MAIN).toContain('const GAMING_VIDEO_AT_LAUNCH = STARTUP_FLAGS.gamingVideo;');
        expect(MAIN).toContain('gamingVideoStartupSwitches(GAMING_VIDEO_AT_LAUNCH, process.platform)');
        expect(MAIN).toContain('media.disableFeatures.push(...gamingSwitches.disableFeatures)');
        // The push must happen before the single append of the list.
        expect(MAIN.indexOf('media.disableFeatures.push(...gamingSwitches.disableFeatures)'))
            .toBeLessThan(MAIN.indexOf("app.commandLine.appendSwitch('disable-features'"));
        // And nowhere else appends disable-features (it would replace the list).
        expect(MAIN.match(/appendSwitch\('disable-features'/g)?.length).toBe(1);
    });

    it('the boost is restored on renderer navigation, renderer crash and quit', () => {
        expect(MAIN).toMatch(/webContents\.on\('did-navigate', \(\) => syncCallPriority\(\{ inCall: false \}\)\)/);
        const gone = MAIN.indexOf("mainWindow.webContents.on('render-process-gone', (event, details) => {");
        expect(gone).toBeGreaterThan(-1);
        expect(MAIN.slice(gone, gone + 400)).toContain('syncCallPriority({ inCall: false })');
        const quit = MAIN.indexOf("app.on('before-quit', () => {\n  // Gaming-video priority boost");
        expect(quit).toBeGreaterThan(-1);
    });

    it('reports the launch-time value as `active` so the UI can offer the restart', () => {
        expect(MAIN).toMatch(/gamingVideo: GAMING_VIDEO_AT_LAUNCH,/);
    });

    it('preload exposes the call signal on the same channel, passing the value through for main to validate', () => {
        expect(PRELOAD).toContain("ipcRenderer.invoke('call:set-media-active', active)");
        expect(PRELOAD).toMatch(/setStartupFlags: \(patch: \{[^}]*gamingVideo\?: boolean \}\)/);
    });
});
