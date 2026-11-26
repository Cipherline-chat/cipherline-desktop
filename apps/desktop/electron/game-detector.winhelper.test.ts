/**
 * Windows: a detection poll starts NO child process (no tasklist, no PowerShell, no cmd): everything comes from win-helper via
 * the WinSys seam. Minecraft Java is recognised by its window, never by another process's command line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setWinSys } from './win-sys';
import { csvWinSys } from './test-win-sys';

const spawned: string[] = [];
vi.mock('child_process', () => ({
    execFile: (file: string, _a: readonly string[], _o: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
        spawned.push(file);
        cb(null, { stdout: '', stderr: '' });
    },
}));
vi.mock('fs/promises', () => {
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { access: async () => { throw enoent(); }, readFile: async () => { throw enoent(); }, readdir: async () => { throw enoent(); }, stat: async () => { throw enoent(); } };
});

const tl = (...names: string[]) => names.map(n => `"${n}.exe","1"`).join('\r\n');
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let gd: typeof import('./game-detector');
let procs = '';
let minecraftWindow = false;
let suspended = false;
const calls: string[] = [];

beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawned.length = 0; calls.length = 0; procs = ''; minecraftWindow = false; suspended = false;
    setWinSys(csvWinSys(() => procs, {
        minecraftWindowOpen: async () => { calls.push('minecraft'); return minecraftWindow; },
        isSuspended: async (n) => { calls.push(`suspended:${n}`); return suspended; },
    }));
    gd = await import('./game-detector');
    gd.__resetGameDetectorForTests();
    gd.setCustomGames([]);
    gd.setIgnoredProcesses([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); setWinSys(null); Object.defineProperty(process, 'platform', realPlatform); });

describe('Windows detection without any child process', () => {
    it('a poll with a game running spawns nothing', async () => {
        procs = tl('system', 'cs2');
        expect((await gd.detectCurrentGame())?.name).toBe('Counter-Strike 2');
        expect(spawned).toEqual([]);
        expect(calls).toContain('suspended:cs2');
    });

    it('Minecraft Java: found from its window (javaw with a "Minecraft..." title), no command line is read', async () => {
        procs = tl('system', 'explorer', 'javaw');
        minecraftWindow = true;
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Minecraft', processName: 'java' });
        expect(spawned).toEqual([]);
    });

    it('a Java process without a Minecraft window is not Minecraft', async () => {
        procs = tl('system', 'javaw');
        minecraftWindow = false;
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('no Java process: the window question is not even asked', async () => {
        procs = tl('system', 'explorer');
        await gd.detectCurrentGame();
        expect(calls).not.toContain('minecraft');
    });

    it('a suspended UWP ghost is skipped', async () => {
        procs = tl('system', 'cs2');
        suspended = true;
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('no helper (the empty implementation): detects nothing, never throws', async () => {
        setWinSys(null);
        procs = tl('cs2');
        expect(await gd.detectCurrentGame()).toBeNull();
        expect(spawned).toEqual([]);
    });
});
