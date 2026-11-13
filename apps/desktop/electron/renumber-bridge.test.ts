import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isRenumberHop, installRenumberBridge } from './renumber-bridge';

describe('isRenumberHop', () => {
    it.each([
        ['1.0.23', '0.1.0'],
        ['1.0.24', '0.1.0'],
        ['1.0.24-staging.226', '0.1.1-staging.227'],
        ['1.0.24-staging.226', '0.1.0'],
        ['1.0.0', '0.2.5'],
    ])('%s -> %s crosses the renumbering', (cur, latest) => {
        expect(isRenumberHop(cur, latest)).toBe(true);
    });

    it.each([
        ['1.0.24', '0.0.23'],          // never into the renumbered OLD builds
        ['1.0.24', '0.0.0'],
        ['1.0.24', '1.0.23'],          // an ordinary 1.x downgrade stays refused
        ['0.1.1', '0.1.0'],            // once on 0.x the bridge is inert
        ['0.1.0', '0.0.23'],
        ['2.0.0', '0.1.0'],
        ['1.0.24', 'garbage'],
        ['', '0.1.0'],
        ['1.0.24', '0.1'],
    ])('%s -> %s is NOT a hop', (cur, latest) => {
        expect(isRenumberHop(cur, latest)).toBe(false);
    });
});

/** Mirrors electron-updater 6.x AppUpdater.isUpdateAvailable's version rule (gt, or allowDowngrade && lt). */
function cmp(a: string, b: string): number {
    const pa = a.split('-')[0].split('.').map(Number);
    const pb = b.split('-')[0].split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
}
class FakeUpdater {
    allowDowngrade = false;
    supported = true;
    seenFlags: boolean[] = [];
    constructor(public currentVersion: string) {}
    private async isUpdateAvailable(info: { version: string }): Promise<boolean> {
        this.seenFlags.push(this.allowDowngrade);
        const c = cmp(info.version, this.currentVersion);
        if (c === 0 || !this.supported) return false;
        return c > 0 || (this.allowDowngrade && c < 0);
    }
    check(version: string) { return this.isUpdateAvailable({ version }); }
}

describe('installRenumberBridge', () => {
    it('lets a 1.x install take 0.1.0, with allowDowngrade on only for that call', async () => {
        const u = new FakeUpdater('1.0.24');
        expect(installRenumberBridge(u, () => u.currentVersion)).toBe(true);
        expect(await u.check('0.1.0')).toBe(true);
        expect(u.seenFlags).toEqual([true]);
        expect(u.allowDowngrade).toBe(false);
    });

    it('still refuses every other downgrade, with the flag left off', async () => {
        const u = new FakeUpdater('1.0.24');
        installRenumberBridge(u, () => u.currentVersion);
        expect(await u.check('1.0.23')).toBe(false);
        expect(await u.check('0.0.23')).toBe(false);
        expect(u.seenFlags).toEqual([false, false]);
    });

    it('is inert once the install is on 0.x', async () => {
        const u = new FakeUpdater('0.1.1');
        installRenumberBridge(u, () => u.currentVersion);
        expect(await u.check('0.1.0')).toBe(false);
        expect(await u.check('0.1.2')).toBe(true);
        expect(u.seenFlags).toEqual([false, false]);
    });

    it("keeps the updater's other checks (e.g. isUpdateSupported) in force for a hop", async () => {
        const u = new FakeUpdater('1.0.24');
        u.supported = false;
        installRenumberBridge(u, () => u.currentVersion);
        expect(await u.check('0.1.0')).toBe(false);
        expect(u.allowDowngrade).toBe(false);
    });

    it('restores the flag even if the original throws', async () => {
        const u = { allowDowngrade: false, isUpdateAvailable: async () => { throw new Error('bad manifest'); } };
        installRenumberBridge(u, () => '1.0.24');
        await expect((u as any).isUpdateAvailable({ version: '0.1.0' })).rejects.toThrow('bad manifest');
        expect(u.allowDowngrade).toBe(false);
    });

    it('declines (and says so) if the updater has no isUpdateAvailable to wrap', () => {
        const logs: string[] = [];
        expect(installRenumberBridge({ allowDowngrade: false }, () => '1.0.24', (m) => logs.push(m))).toBe(false);
        expect(logs[0]).toMatch(/not installed/);
    });

    it('the installed electron-updater still has the private method this wraps', () => {
        // Bump guard: if electron-updater renames isUpdateAvailable the bridge silently stops working.
        const candidates = [
            path.resolve(__dirname, '../node_modules/electron-updater/out/AppUpdater.js'),
            path.resolve(__dirname, '../../../node_modules/electron-updater/out/AppUpdater.js'),
        ];
        const file = candidates.find((p) => fs.existsSync(p));
        expect(file, 'electron-updater not installed').toBeTruthy();
        const src = fs.readFileSync(file!, 'utf8');
        expect(src).toMatch(/async isUpdateAvailable\(updateInfo\)/);
        expect(src).toMatch(/await this\.isUpdateAvailable\(updateInfo\)/);
        expect(src).toMatch(/return this\.allowDowngrade && isLatestVersionOlder;/);
    });
});
