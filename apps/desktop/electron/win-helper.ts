/**
 * Client for `win-helper.exe serve` (apps/desktop-host/win-helper): ONE long-lived hidden child, started on the first question
 * and stopped when idle, that answers the app's Windows questions by calling Windows APIs. It replaces the hidden
 * `powershell.exe` / `tasklist` / `reg.exe` children the main process used to start every few seconds.
 *
 * Fail soft by construction: a missing binary, a crash, a timeout or a garbled line all end in "no answer" (null), which the
 * WinSys methods turn into the same defaults the old PowerShell code used on error. Nothing here ever throws to a caller.
 *
 * No electron import and no src/ import (the rootDir rule). The spawn function is injected for tests.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { swallowStreamErrors } from './stdio-guard';
import { normalizeProcessName, winHelperBinary, type WinSys } from './win-sys';

export const REQUEST_TIMEOUT_MS = 5_000;
/** The helper exits after this long without a question (the game poll asks every 10 s while it is on). */
export const IDLE_MS = 60_000;
/** After this many starts in a row that produced no answer the helper is left alone until the app restarts. */
export const MAX_DEAD_STARTS = 3;
const MAX_LINE_CHARS = 2 * 1024 * 1024;

type SpawnFn = (file: string, args: string[], opts: { windowsHide: true; stdio: 'pipe'; shell: false }) => ChildProcessWithoutNullStreams;
type Reply = Record<string, unknown>;

export class WinHelperClient implements WinSys {
    private child: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private pending = new Map<number, { resolve: (r: Reply | null) => void; timer: ReturnType<typeof setTimeout> }>();
    private buf = '';
    private idle: ReturnType<typeof setTimeout> | null = null;
    private deadStarts = 0;
    private gotAnswer = false;

    constructor(
        private readonly binary: () => string | null = winHelperBinary,
        private readonly spawnFn: SpawnFn = (f, a, o) => spawn(f, a, o) as ChildProcessWithoutNullStreams,
    ) {}

    /** Stops the helper (app quit). */
    stop(): void {
        if (this.idle) { clearTimeout(this.idle); this.idle = null; }
        const c = this.child;
        this.child = null;
        this.failAll();
        if (c) { try { c.stdin.end(); } catch { /* gone */ } try { c.kill(); } catch { /* gone */ } }
    }

    private failAll(): void {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(null); }
        this.pending.clear();
    }

    private ensure(): ChildProcessWithoutNullStreams | null {
        if (this.child) return this.child;
        if (this.deadStarts >= MAX_DEAD_STARTS) return null;
        const bin = this.binary();
        if (!bin) return null;
        let c: ChildProcessWithoutNullStreams;
        try {
            c = this.spawnFn(bin, ['serve'], { windowsHide: true, stdio: 'pipe', shell: false });
        } catch {
            this.deadStarts += 1;
            return null;
        }
        this.child = c;
        this.buf = '';
        this.gotAnswer = false;
        c.stdout.setEncoding('utf8');
        c.stdout.on('data', (chunk: string) => this.onData(chunk));
        c.stderr.on('data', () => { /* nothing is logged */ });
        const gone = () => {
            if (this.child !== c) return;
            this.child = null;
            if (!this.gotAnswer) this.deadStarts += 1;
            this.failAll();
        };
        swallowStreamErrors(c.stdin, gone);
        swallowStreamErrors(c.stdout, gone);
        swallowStreamErrors(c.stderr, gone);
        c.on('error', gone);
        c.on('exit', gone);
        return c;
    }

    private onData(chunk: string): void {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line) continue;
            let o: Reply;
            try { o = JSON.parse(line) as Reply; } catch { continue; }
            const id = typeof o?.id === 'number' ? o.id : -1;
            const p = this.pending.get(id);
            if (!p) continue;
            this.pending.delete(id);
            clearTimeout(p.timer);
            this.gotAnswer = true;
            this.deadStarts = 0;
            p.resolve(o.ok === true ? o : null);
        }
        if (this.buf.length > MAX_LINE_CHARS) this.buf = '';
    }

    /** One question. null on any failure. A helper that does not answer in time is killed (its next answer could be out of step). */
    request(op: string, params: Record<string, unknown> = {}): Promise<Reply | null> {
        const c = this.ensure();
        if (!c) return Promise.resolve(null);
        const id = this.nextId++;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (!this.pending.delete(id)) return;
                resolve(null);
                if (this.child === c) { this.child = null; this.deadStarts += 1; try { c.kill(); } catch { /* gone */ } this.failAll(); }
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, timer });
            try {
                c.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
            } catch {
                this.pending.delete(id);
                clearTimeout(timer);
                resolve(null);
                return;
            }
            if (this.idle) clearTimeout(this.idle);
            this.idle = setTimeout(() => this.stop(), IDLE_MS);
            this.idle.unref?.();
        });
    }

    async processNames(): Promise<string[]> {
        const r = await this.request('processes');
        const names = r?.names;
        return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string').map(normalizeProcessName).filter(Boolean) : [];
    }
    async isSuspended(name: string): Promise<boolean> {
        return (await this.request('suspended', { name }))?.state === 'suspended';
    }
    async hasVisibleWindow(name: string): Promise<boolean> {
        const r = await this.request('window', { name });
        // Not running, or no answer: do not hide a game (the old probe failed open too).
        return !r || r.found !== true || r.window === true;
    }
    async minecraftWindowOpen(): Promise<boolean> {
        return (await this.request('minecraft'))?.running === true;
    }
    async exePath(name: string): Promise<string | null> {
        const p = (await this.request('exe_path', { name }))?.path;
        return typeof p === 'string' ? p : null;
    }
    async pidName(pid: number): Promise<string | null> {
        const n = (await this.request('pid_name', { pid }))?.name;
        return typeof n === 'string' && n ? normalizeProcessName(n) : null;
    }
    async gpuPreferenceExists(exe: string): Promise<boolean | null> {
        const r = await this.request('gpu_pref_has', { exe });
        return r ? r.present === true : null;
    }
    async setHighPerformanceGpu(exe: string): Promise<boolean> {
        return (await this.request('gpu_pref_set_high', { exe })) !== null;
    }
}
