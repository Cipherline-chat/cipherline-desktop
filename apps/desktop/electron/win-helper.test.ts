import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WinHelperClient, REQUEST_TIMEOUT_MS, MAX_DEAD_STARTS } from './win-helper';
import { resolveWinHelper } from './win-helper-path';
import { NO_WIN_SYS, normalizeProcessName } from './win-sys';

/** A fake `win-helper.exe serve`: answers each request line with whatever `reply` returns (null = silence). */
function fakeHelper(reply: (req: Record<string, unknown>) => Record<string, unknown> | null) {
    const requests: Array<Record<string, unknown>> = [];
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let buf = '';
    stdin.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
            buf = buf.slice(nl + 1);
            requests.push(req);
            const r = reply(req);
            if (r) stdout.write(`${JSON.stringify({ id: req.id, ok: true, ...r })}\n`);
        }
    });
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), kill: vi.fn() });
    return { child, requests };
}

const BIN = 'C:\\Program Files\\Cipherline\\resources\\win-helper.exe';

afterEach(() => { vi.useRealTimers(); });

describe('WinHelperClient', () => {
    it('starts ONE hidden helper in serve mode (no shell) and reuses it', async () => {
        const h = fakeHelper((r) => (r.op === 'processes' ? { names: ['System', 'Cipherline.EXE'] } : {}));
        const spawnFn = vi.fn(() => h.child as never);
        const c = new WinHelperClient(() => BIN, spawnFn);
        expect(await c.processNames()).toEqual(['system', 'cipherline']);
        await c.processNames();
        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(spawnFn).toHaveBeenCalledWith(BIN, ['serve'], { windowsHide: true, stdio: 'pipe', shell: false });
        c.stop();
    });

    it('maps each answer, and the fail-soft defaults match the old PowerShell code', async () => {
        const h = fakeHelper((r) => {
            switch (r.op) {
                case 'suspended': return { state: r.name === 'ghost' ? 'suspended' : 'active' };
                case 'window': return { found: true, window: r.name === 'shown' };
                case 'minecraft': return { running: true };
                case 'exe_path': return { path: 'C:\\g\\g.exe' };
                case 'pid_name': return { name: 'Game.exe' };
                case 'gpu_pref_has': return { present: false };
                default: return {};
            }
        });
        const c = new WinHelperClient(() => BIN, () => h.child as never);
        expect(await c.isSuspended('ghost')).toBe(true);
        expect(await c.isSuspended('game')).toBe(false);
        expect(await c.hasVisibleWindow('shown')).toBe(true);
        expect(await c.hasVisibleWindow('hidden')).toBe(false);
        expect(await c.minecraftWindowOpen()).toBe(true);
        expect(await c.exePath('g')).toBe('C:\\g\\g.exe');
        expect(await c.pidName(5)).toBe('game');
        expect(await c.gpuPreferenceExists('C:\\a.exe')).toBe(false);
        expect(await c.setHighPerformanceGpu('C:\\a.exe')).toBe(true);
        c.stop();
    });

    it('a process that is not running does not read as "no window" (never hides a game on a missing process)', async () => {
        const h = fakeHelper(() => ({ found: false, window: false }));
        const c = new WinHelperClient(() => BIN, () => h.child as never);
        expect(await c.hasVisibleWindow('x')).toBe(true);
        c.stop();
    });

    it('no binary: nothing is spawned and every answer is the empty default', async () => {
        const spawnFn = vi.fn();
        const c = new WinHelperClient(() => null, spawnFn as never);
        expect(await c.processNames()).toEqual([]);
        expect(await c.isSuspended('x')).toBe(false);
        expect(await c.hasVisibleWindow('x')).toBe(true);
        expect(await c.minecraftWindowOpen()).toBe(false);
        expect(await c.exePath('x')).toBeNull();
        expect(await c.pidName(3)).toBeNull();
        expect(await c.gpuPreferenceExists('C:\\a.exe')).toBeNull();
        expect(await c.setHighPerformanceGpu('C:\\a.exe')).toBe(false);
        expect(spawnFn).not.toHaveBeenCalled();
    });

    it('a helper that does not answer in time is killed and the caller gets the default; the next ask starts a fresh one', async () => {
        vi.useFakeTimers();
        const mute = fakeHelper(() => null);
        const good = fakeHelper(() => ({ names: ['a'] }));
        const kids = [mute.child, good.child];
        let n = 0;
        const c = new WinHelperClient(() => BIN, () => kids[n++] as never);
        const p = c.processNames();
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);
        expect(await p).toEqual([]);
        expect(mute.child.kill).toHaveBeenCalled();
        expect(await c.processNames()).toEqual(['a']);
        c.stop();
    });

    it('a helper that dies answers pending asks with the default and is not respawned forever', async () => {
        const spawnFn = vi.fn(() => {
            const h = fakeHelper(() => null);
            setTimeout(() => h.child.emit('exit', 1), 0);
            return h.child as never;
        });
        const c = new WinHelperClient(() => BIN, spawnFn);
        for (let i = 0; i < MAX_DEAD_STARTS + 3; i++) expect(await c.processNames()).toEqual([]);
        expect(spawnFn).toHaveBeenCalledTimes(MAX_DEAD_STARTS);
    });

    it('a spawn that throws is contained', async () => {
        const c = new WinHelperClient(() => BIN, () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); });
        await expect(c.processNames()).resolves.toEqual([]);
    });

    it('garbage and ok:false lines never throw and read as no answer', async () => {
        const h = fakeHelper(() => null);
        const c = new WinHelperClient(() => BIN, () => h.child as never);
        const p = c.minecraftWindowOpen();
        h.child.stdout.write('not json\n');
        h.child.stdout.write(`${JSON.stringify({ id: 1, ok: false, err: 'nope' })}\n`);
        expect(await p).toBe(false);
        c.stop();
    });

    it('stops itself when idle', async () => {
        vi.useFakeTimers();
        const h = fakeHelper(() => ({ names: [] }));
        const c = new WinHelperClient(() => BIN, () => h.child as never);
        await c.processNames();
        await vi.advanceTimersByTimeAsync(61_000);
        expect(h.child.kill).toHaveBeenCalled();
    });
});

describe('NO_WIN_SYS / normalizeProcessName', () => {
    it('normalises names', () => {
        expect(normalizeProcessName(' Forza.EXE ')).toBe('forza');
        expect(normalizeProcessName('a.exe.exe')).toBe('a.exe');
    });
    it('the empty implementation detects nothing and fails open where the old code did', async () => {
        expect(await NO_WIN_SYS.processNames()).toEqual([]);
        expect(await NO_WIN_SYS.hasVisibleWindow('x')).toBe(true);
        expect(await NO_WIN_SYS.isSuspended('x')).toBe(false);
    });
});

describe('resolveWinHelper', () => {
    const w = { platform: 'win32' as const, envHelper: undefined, resourcesPath: 'C:\\Program Files\\Cipherline\\resources', devTargetDir: 'C:\\dev\\cl\\apps\\desktop-host\\win-helper\\target' };
    const have = (...p: string[]) => (x: string) => p.includes(x);
    it('packaged: only resources\\win-helper.exe; the env override and dev tree are ignored', () => {
        const pk = 'C:\\Program Files\\Cipherline\\resources\\win-helper.exe';
        expect(resolveWinHelper({ ...w, isPackaged: true, exists: have(pk) })).toEqual({ path: pk, source: 'packaged' });
        expect(resolveWinHelper({ ...w, isPackaged: true, envHelper: 'C:\\evil\\h.exe', exists: have('C:\\evil\\h.exe') })).toBeNull();
        expect(resolveWinHelper({ ...w, isPackaged: true, exists: have('C:\\dev\\cl\\apps\\desktop-host\\win-helper\\target\\release\\cl-win-helper.exe') })).toBeNull();
    });
    it('dev: env override, then the in-tree release build, then debug', () => {
        const rel = 'C:\\dev\\cl\\apps\\desktop-host\\win-helper\\target\\release\\cl-win-helper.exe';
        const dbg = 'C:\\dev\\cl\\apps\\desktop-host\\win-helper\\target\\debug\\cl-win-helper.exe';
        expect(resolveWinHelper({ ...w, isPackaged: false, envHelper: 'C:\\x\\h.exe', exists: have('C:\\x\\h.exe', rel) })?.source).toBe('env');
        expect(resolveWinHelper({ ...w, isPackaged: false, exists: have(rel, dbg) })).toEqual({ path: rel, source: 'dev' });
        expect(resolveWinHelper({ ...w, isPackaged: false, exists: have(dbg) })).toEqual({ path: dbg, source: 'dev' });
        expect(resolveWinHelper({ ...w, isPackaged: false, exists: have() })).toBeNull();
    });
    it('is Windows only', () => {
        expect(resolveWinHelper({ ...w, platform: 'linux', isPackaged: false, exists: () => true })).toBeNull();
    });
});
