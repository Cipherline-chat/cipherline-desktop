import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * main.ts imports `electron` and cannot load under vitest, so this reads its
 * source to pin the WIRING of continuity's lock/suspend reporting: the policy
 * (utils/attentionState.ts reduceSessionPowerState) is unit-tested there, but a
 * dropped powerMonitor listener or a renamed channel is invisible to it, and
 * the failure is silent in exactly the worst direction: a locked PC still
 * claiming it is in use, silencing the owner's phone.
 */
const MAIN = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');
const PRELOAD = fs.readFileSync(path.resolve(__dirname, 'preload.ts'), 'utf8');
const SCREENSAVER = fs.readFileSync(path.resolve(__dirname, 'linux-screensaver.ts'), 'utf8');

describe('attention power signals: main → preload → renderer', () => {
    it('main forwards each of the four powerMonitor signals one-for-one on os-power-signal', () => {
        for (const sig of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) {
            const re = new RegExp(`powerMonitor\\.on\\('${sig}',\\s*\\(\\)\\s*=>\\s*notifyOsPowerSignal\\('${sig}'\\)\\)`);
            expect(MAIN, `no forwarder for '${sig}'`).toMatch(re);
        }
        expect(MAIN).toContain("mainWindow?.webContents.send('os-power-signal', signal)");
    });

    it('the Linux screensaver watcher supplies BOTH edges (no unlock-screen event exists there)', () => {
        expect(MAIN).toMatch(/watchLinuxScreenLock\(\s*\(\) => \{ notifyOsLock\(\); notifyOsPowerSignal\('lock-screen'\); \},\s*\(\) => notifyOsPowerSignal\('unlock-screen'\),\s*\)/);
        expect(SCREENSAVER).toContain('onUnlock?.()');
        // Positive control: the watcher still reports a lock.
        expect(SCREENSAVER).toContain('onLock()');
    });

    it('the pre-existing Screen Lock channels are untouched', () => {
        expect(MAIN).toContain("mainWindow?.webContents.send('os-lock-screen')");
        expect(MAIN).toContain("mainWindow?.webContents.send('os-resume')");
    });

    it('preload exposes onOsPowerSignal on the same channel and only passes strings through', () => {
        const start = PRELOAD.indexOf('onOsPowerSignal:');
        expect(start).toBeGreaterThan(-1);
        const body = PRELOAD.slice(start, start + 500);
        expect(body).toContain("ipcRenderer.on('os-power-signal'");
        expect(body).toContain("typeof signal === 'string'");
        expect(body).toContain("ipcRenderer.removeListener('os-power-signal'");
    });
});
