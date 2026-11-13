import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { watchLinuxScreenLock, SCREENSAVER_WATCH_SCRIPT, type WatchSpawn } from './linux-screensaver';

/**
 * The Linux screen-lock watcher (`gdbus monitor` on org.freedesktop.ScreenSaver).
 * Linux VM matrix 2026-11-09 (staging.213): a directly spawned gdbus outlived every
 * Cipherline that was killed, crashed or SIGTERMed (PPID 1, 40-65 inherited fds,
 * including files inside the AppImage mount). The wrapper must take it down with
 * the app, however the app ends.
 */

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (cond: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
    return cond();
};

describe('watchLinuxScreenLock (unit, injected spawn)', () => {
    function fakeSpawn() {
        const calls: Array<{ cmd: string; args: string[]; stdio: unknown }> = [];
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const proc = Object.assign(new EventEmitter(), { stdin, stdout, killed: 0, kill() { this.killed++; return true; } });
        const spawnFn: WatchSpawn = (cmd, args, opts) => { calls.push({ cmd, args, stdio: opts.stdio }); return proc; };
        return { calls, proc, spawnFn, stdin, stdout };
    }

    it('runs gdbus under the /bin/sh wrapper with a stdin pipe it never writes to', () => {
        const f = fakeSpawn();
        watchLinuxScreenLock(() => {}, undefined, { platform: 'linux', spawn: f.spawnFn });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].cmd).toBe('/bin/sh');
        expect(f.calls[0].args).toEqual(['-c', SCREENSAVER_WATCH_SCRIPT]);
        expect(f.calls[0].stdio).toEqual(['pipe', 'pipe', 'ignore']);
        expect(SCREENSAVER_WATCH_SCRIPT).toContain('gdbus monitor --session --dest org.freedesktop.ScreenSaver');
    });

    it('still turns ActiveChanged lines into lock / unlock, across chunk boundaries', () => {
        const f = fakeSpawn();
        const ev: string[] = [];
        watchLinuxScreenLock(() => ev.push('lock'), () => ev.push('unlock'), { platform: 'linux', spawn: f.spawnFn });
        f.stdout.write('/org/freedesktop/ScreenSaver: org.freedesktop.ScreenSaver.ActiveChanged (tr');
        f.stdout.write('ue,)\n/org/freedesktop/ScreenSaver: org.freedesktop.ScreenSaver.ActiveChanged (false,)\nnoise\n');
        expect(ev).toEqual(['lock', 'unlock']);
    });

    it('cleanup closes the pipe (the wrapper exits on EOF) and signals it, once', () => {
        const f = fakeSpawn();
        const stop = watchLinuxScreenLock(() => {}, undefined, { platform: 'linux', spawn: f.spawnFn });
        stop();
        stop();
        expect(f.stdin.writableEnded).toBe(true);
        expect(f.proc.killed).toBe(1);
    });

    it('is a no-op off Linux (control: nothing spawned)', () => {
        const f = fakeSpawn();
        watchLinuxScreenLock(() => {}, undefined, { platform: 'win32', spawn: f.spawnFn });
        expect(f.calls).toHaveLength(0);
    });
});

// Real processes: POSIX sh + a fake `gdbus` first on PATH. Linux/macOS only (the app only runs this on Linux).
describe.skipIf(process.platform === 'win32')('the sh wrapper with real processes', () => {
    const procs: ChildProcess[] = [];
    let dir = '';
    afterEach(() => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } procs.length = 0; });

    function makeFakeGdbus(): { env: NodeJS.ProcessEnv; pidFile: string } {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ss-'));
        const pidFile = path.join(dir, 'gdbus.pid');
        // Like gdbus monitor: prints one signal line, then waits for more (forever).
        fs.writeFileSync(path.join(dir, 'gdbus'),
            `#!/bin/sh\necho $$ > "${pidFile}"\necho "/org/freedesktop/ScreenSaver: org.freedesktop.ScreenSaver.ActiveChanged (true,)"\nexec sleep 300\n`, { mode: 0o755 });
        return { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, pidFile };
    }
    const readPid = (f: string) => Number(fs.readFileSync(f, 'utf8').trim());

    it('the parent going away WITHOUT cleanup (crash / SIGKILL / SIGTERM) takes gdbus down', async () => {
        const { env, pidFile } = makeFakeGdbus();
        const sh = spawn('/bin/sh', ['-c', SCREENSAVER_WATCH_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], env });
        procs.push(sh);
        let out = '';
        sh.stdout!.on('data', (b) => { out += String(b); });
        expect(await waitFor(() => fs.existsSync(pidFile) && out.includes('ActiveChanged (true'))).toBe(true);
        const gdbusPid = readPid(pidFile);
        expect(alive(gdbusPid)).toBe(true);
        // What the kernel does to the pipe when Cipherline dies: its write end closes. No cleanup call.
        sh.stdin!.destroy();
        expect(await waitFor(() => !alive(gdbusPid))).toBe(true);
    });

    it('SIGTERM to the wrapper (what cleanup sends) also takes gdbus down', async () => {
        const { env, pidFile } = makeFakeGdbus();
        const sh = spawn('/bin/sh', ['-c', SCREENSAVER_WATCH_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], env });
        procs.push(sh);
        expect(await waitFor(() => fs.existsSync(pidFile))).toBe(true);
        const gdbusPid = readPid(pidFile);
        sh.kill('SIGTERM');
        expect(await waitFor(() => !alive(gdbusPid))).toBe(true);
    });

    it('NEGATIVE CONTROL: gdbus spawned directly (the old code) survives its parent abandoning it', async () => {
        const { env, pidFile } = makeFakeGdbus();
        const g = spawn('gdbus', ['monitor', '--session', '--dest', 'org.freedesktop.ScreenSaver'], { stdio: ['ignore', 'pipe', 'ignore'], env });
        procs.push(g);
        expect(await waitFor(() => fs.existsSync(pidFile))).toBe(true);
        const gdbusPid = readPid(pidFile);
        g.stdout!.destroy(); // the parent's side of every pipe going away, as on a crash
        await new Promise((r) => setTimeout(r, 800));
        expect(alive(gdbusPid)).toBe(true); // nothing tells it to go: this is the orphan the wrapper prevents
    });

    it('no gdbus on PATH: the wrapper exits at once (quiet no-op, as before)', async () => {
        const sh = spawn('/bin/sh', ['-c', SCREENSAVER_WATCH_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PATH: '/nonexistent' } });
        procs.push(sh);
        const code = await new Promise<number | null>((r) => sh.on('exit', (c) => r(c)));
        expect(code).toBe(0);
    });
});
