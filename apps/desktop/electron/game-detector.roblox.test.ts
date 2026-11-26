/**
 * "Playing Roblox" with the Player closed: RobloxPlayerBeta.exe can outlive
 * the game as a windowless background process. Roblox must only be reported
 * while the game client owns a visible window; other Roblox executables
 * never count.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setWinSys } from './win-sys';
import { csvWinSys } from './test-win-sys';

let tasklist = '';
let windowProbe: 'WINDOW' | 'NOWINDOW' | 'ERROR' = 'WINDOW';
const tl = (...names: string[]) => names.map(n => `"${n}.exe","1234","Console","1","10,000 K"`).join('\r\n');


vi.mock('fs/promises', () => {
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return {
        access: async () => { throw enoent(); },
        readFile: async () => { throw enoent(); },
        readdir: async () => { throw enoent(); },
        stat: async () => { throw enoent(); },
    };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let gd: typeof import('./game-detector');

beforeEach(async () => {
    setWinSys(csvWinSys(() => tasklist, { hasVisibleWindow: async () => windowProbe !== 'NOWINDOW' }));
    Object.defineProperty(process, 'platform', { value: 'win32' });
    gd = await import('./game-detector');
    gd.__resetGameDetectorForTests();
    gd.setCustomGames([]);
    gd.setIgnoredProcesses([]);
    windowProbe = 'WINDOW';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, 'platform', realPlatform); });

describe('Roblox detection', () => {
    it('reports Roblox while the game client has a window', async () => {
        tasklist = tl('system', 'RobloxPlayerBeta');
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Roblox', processName: 'robloxplayerbeta' });
    });

    it('REGRESSION: a lingering windowless RobloxPlayerBeta is not "playing"', async () => {
        tasklist = tl('system', 'RobloxPlayerBeta');
        windowProbe = 'NOWINDOW';
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('fails open when the window probe gives no usable answer', async () => {
        tasklist = tl('RobloxPlayerBeta');
        windowProbe = 'ERROR'; // no usable answer: the helper client reports a window (fails open)
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Roblox', processName: 'robloxplayerbeta' });
    });

    it.each([
        ['RobloxCrashHandler'], ['RobloxPlayerInstaller'], ['RobloxPlayerLauncher'],
        ['RobloxStudioBeta'], ['RobloxStudioLauncherBeta'], ['Bloxstrap'], ['msedge'], ['RobloxPlayerBetaX'],
    ])('%s alone is not Roblox', async (name) => {
        tasklist = tl('system', name);
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('window gate only applies to listed processes', () => {
        expect([...gd.REQUIRES_VISIBLE_WINDOW]).toEqual(['robloxplayerbeta', 'robloxplayer']);
    });
});
