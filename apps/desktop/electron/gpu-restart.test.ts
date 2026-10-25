import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    GPU_EXIT_ON_CONTEXT_LOST, GPU_RECOVERY_OUTCOME_CHANNEL, GPU_RESTARTED_CHANNEL, GpuRestartLedger,
    gpuCrashSignature, gpuRestartFromChildGone, parseGpuRecoveryReport,
} from './gpu-restart';
import {
    PendingCrashStore, crashFromChildGone, crashSignature, parsePendingCrashes, type PendingStorage,
} from './diagnostics';

const T0 = Date.UTC(2026, 9, 11, 21, 50, 16);

/** The prod record of 2026-10-11 (stable 1.0.20, NVIDIA + AMD). */
const PROD_GPU_GONE = { type: 'GPU', reason: 'crashed', exitCode: 34 };

describe('gpuRestartFromChildGone — which child-process-gone becomes a renderer signal', () => {
    it('the prod GPU death (crashed, exit 34) → signal, flagged context-lost', () => {
        expect(gpuRestartFromChildGone(PROD_GPU_GONE, 1, false)).toEqual({
            v: 1, seq: 1, reason: 'crashed', exit_code: 34, ctx_lost: true,
        });
        expect(GPU_EXIT_ON_CONTEXT_LOST).toBe(34);
    });

    it('every abnormal GPU reason signals; a non-34 exit is not "context lost"', () => {
        for (const reason of ['crashed', 'abnormal-exit', 'killed', 'oom', 'launch-failed', 'integrity-failure']) {
            const p = gpuRestartFromChildGone({ type: 'GPU', reason, exitCode: -1073741819 }, 2, false);
            expect(p?.reason).toBe(reason);
            expect(p?.ctx_lost).toBe(false);
        }
    });

    it('negative controls: quitting, other process types, clean exits, junk', () => {
        expect(gpuRestartFromChildGone(PROD_GPU_GONE, 1, true)).toBeNull(); // teardown of a quit
        // Windows logging the user off (0xC000026B) takes the GPU process too: nothing to recover.
        expect(gpuRestartFromChildGone({ type: 'GPU', reason: 'crashed', exitCode: -1073741205 }, 1, false)).toBeNull();
        for (const type of ['Utility', 'Zygote', 'Pepper Plugin', 'gpu', undefined]) {
            expect(gpuRestartFromChildGone({ ...PROD_GPU_GONE, type }, 1, false)).toBeNull();
        }
        for (const reason of ['clean-exit', 'memory-eviction', 'CRASHED', '', undefined, 3]) {
            expect(gpuRestartFromChildGone({ ...PROD_GPU_GONE, reason }, 1, false)).toBeNull();
        }
        expect(gpuRestartFromChildGone(null, 1, false)).toBeNull();
        expect(gpuRestartFromChildGone(undefined, 1, false)).toBeNull();
        expect(gpuRestartFromChildGone(PROD_GPU_GONE, 0, false)).toBeNull();
        expect(gpuRestartFromChildGone(PROD_GPU_GONE, 1.5, false)).toBeNull();
    });

    it('a missing / non-finite exit code is null, never "context lost"', () => {
        for (const exitCode of [undefined, NaN, Infinity, '34']) {
            const p = gpuRestartFromChildGone({ type: 'GPU', reason: 'crashed', exitCode }, 1, false);
            expect(p).toMatchObject({ exit_code: null, ctx_lost: false });
        }
    });
});

describe('parseGpuRecoveryReport — the renderer\'s answer, strictly', () => {
    it('accepts exactly {seq, outcome}', () => {
        for (const outcome of ['recovered', 'restart_prompted', 'not_in_call']) {
            expect(parseGpuRecoveryReport({ seq: 3, outcome })).toEqual({ seq: 3, outcome });
        }
    });

    it('rejects everything else (negative controls)', () => {
        const bad: unknown[] = [
            null, undefined, 'recovered', 3, [], [3, 'recovered'],
            {}, { seq: 3 }, { outcome: 'recovered' },
            { seq: 0, outcome: 'recovered' }, { seq: -1, outcome: 'recovered' }, { seq: 1.5, outcome: 'recovered' },
            { seq: 1_000_001, outcome: 'recovered' }, { seq: '3', outcome: 'recovered' }, { seq: NaN, outcome: 'recovered' },
            { seq: 3, outcome: 'RECOVERED' }, { seq: 3, outcome: 'crashed' }, { seq: 3, outcome: '' },
            { seq: 3, outcome: 'recovered', extra: true },
            Object.assign(Object.create({ inherited: 1 }), { seq: 3, outcome: 'recovered' }),
        ];
        for (const b of bad) expect(parseGpuRecoveryReport(b)).toBeNull();
    });
});

describe('GpuRestartLedger', () => {
    it('one answer per seq; unknown or repeated seqs resolve to nothing', () => {
        const l = new GpuRestartLedger();
        expect(l.next()).toBe(1);
        l.issued(1, 'sig-a');
        expect(l.count).toBe(1);
        l.issued(5, 'skipped'); // out of order: ignored
        expect(l.next()).toBe(2);
        l.issued(2, null);
        expect(l.resolve(1)).toBe('sig-a');
        expect(l.resolve(1)).toBeNull();
        expect(l.resolve(2)).toBeNull();
        expect(l.resolve(99)).toBeNull();
    });

    it('stays bounded', () => {
        const l = new GpuRestartLedger();
        for (let i = 1; i <= 50; i++) l.issued(l.next(), `s${i}`);
        expect(l.resolve(1)).toBeNull();
        expect(l.resolve(50)).toBe('s50');
    });
});

describe('a handled GPU restart is recorded but not asked about as "closed unexpectedly"', () => {
    const mem = (): PendingStorage & { value: string | null } => {
        const s = { value: null as string | null, read: () => s.value, write: (v: string) => { s.value = v; }, clear: () => { s.value = null; } };
        return s;
    };

    it('markHandled → seen + handled, persisted, survives a reload', () => {
        const store = new PendingCrashStore();
        const storage = mem();
        store.attach(storage);
        const rec = crashFromChildGone(PROD_GPU_GONE, T0, '1.0.20')!;
        store.add(rec);
        const sig = crashSignature(rec);
        expect(store.all()[0]).toMatchObject({ seen: false });
        expect(store.all()[0].handled).toBeUndefined();

        store.markHandled(sig, 'recovered');
        expect(store.all()[0]).toMatchObject({ seen: true, handled: 'recovered', count: 1 });
        // Still pending (manual report / opted-in auto-send keep the evidence).
        expect(store.all()).toHaveLength(1);
        expect(parsePendingCrashes(storage.value)[0]).toMatchObject({ seen: true, handled: 'recovered' });
    });

    it('the same crash HAPPENING AGAIN clears handled and re-arms the prompt', () => {
        const store = new PendingCrashStore();
        const rec = crashFromChildGone(PROD_GPU_GONE, T0, '1.0.20')!;
        store.add(rec);
        store.markHandled(crashSignature(rec), 'restart_prompted');
        store.add(crashFromChildGone(PROD_GPU_GONE, T0 + 60_000, '1.0.20'));
        expect(store.all()[0]).toMatchObject({ seen: false, count: 2 });
        expect(store.all()[0].handled).toBeUndefined();
    });

    it('negative controls: unknown signature or bogus "how" change nothing; junk persisted values are dropped', () => {
        const store = new PendingCrashStore();
        const rec = crashFromChildGone(PROD_GPU_GONE, T0, '1.0.20')!;
        store.add(rec);
        store.markHandled('nope', 'recovered');
        store.markHandled(crashSignature(rec), 'bogus' as never);
        expect(store.all()[0]).toMatchObject({ seen: false });
        expect(store.all()[0].handled).toBeUndefined();
        const parsed = parsePendingCrashes(JSON.stringify([{ signature: 'x', count: 1, seen: true, handled: 'pwned', crash: rec }]));
        expect(parsed[0].handled).toBeUndefined();
    });

    it('handled survives attach() merging a record captured before the store was ready', () => {
        const store = new PendingCrashStore();
        const rec = crashFromChildGone(PROD_GPU_GONE, T0, '1.0.20')!;
        store.add(rec);
        store.markHandled(crashSignature(rec), 'not_in_call');
        const storage = mem();
        store.attach(storage);
        expect(store.all()[0]).toMatchObject({ seen: true, handled: 'not_in_call' });
    });
});

// main.ts imports `electron` and cannot load under vitest — read the source
// (same approach as ipcParameterForwarding.test.ts) to pin the WIRING.
describe('wiring (main.ts / preload.ts source)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const main = fs.readFileSync(path.join(here, 'main.ts'), 'utf8');
    const preload = fs.readFileSync(path.join(here, 'preload.ts'), 'utf8');

    it('child-process-gone signals the renderer, and still records the crash', () => {
        expect(main).toContain("app.on('child-process-gone', (_e, details) => signalGpuRestart(details));");
        const listeners = [...main.matchAll(/app\.on\('child-process-gone'/g)];
        expect(listeners).toHaveLength(2);
        const rec = listeners[1].index!;
        expect(main.slice(rec, main.indexOf('\n  });', rec))).toMatch(/recordCrash\(/);
    });

    it('the signal is gated on quitting and sent on the shared channel constant', () => {
        const start = main.indexOf('const signalGpuRestart');
        const body = main.slice(start, main.indexOf('\n};', start));
        expect(body).toMatch(/gpuRestartFromChildGone\(details, gpuRestarts\.next\(\), isQuitting\)/);
        expect(body).toMatch(/webContents\.send\(GPU_RESTARTED_CHANNEL, payload\)/);
        // main never builds a crash record itself outside the reporter
        // (merge-compatible with claude/quit-not-crash's wiring test).
        expect(body).not.toMatch(/crashFrom(ChildGone|RenderGone|MainError|RendererReport)\(/);
        expect(body).toMatch(/gpuCrashSignature\(details, /);
    });

    it('the outcome handler validates before it touches the crash store', () => {
        const start = main.indexOf('ipcMain.handle(GPU_RECOVERY_OUTCOME_CHANNEL');
        expect(start).toBeGreaterThan(-1);
        const body = main.slice(start, main.indexOf('\n});', start));
        const parseAt = body.indexOf('parseGpuRecoveryReport(report)');
        const throwAt = body.indexOf('throw new Error');
        const markAt = body.indexOf('pendingCrashes.markHandled');
        expect(parseAt).toBeGreaterThan(-1);
        expect(throwAt).toBeGreaterThan(parseAt);
        expect(markAt).toBeGreaterThan(throwAt);
    });

    it('preload uses the same channel names (subscribe + unsubscribe, invoke)', () => {
        expect(GPU_RESTARTED_CHANNEL).toBe('gpu:process-restarted');
        expect(GPU_RECOVERY_OUTCOME_CHANNEL).toBe('gpu:recovery-outcome');
        expect(preload).toContain("ipcRenderer.on('gpu:process-restarted', wrapped)");
        expect(preload).toContain("ipcRenderer.removeListener('gpu:process-restarted', wrapped)");
        // Only the two known fields cross the bridge.
        expect(preload).toContain("ipcRenderer.invoke('gpu:recovery-outcome', { seq: report.seq, outcome: report.outcome })");
    });

    it('the relaunch the restart prompt uses is still a real quit (not a crash)', () => {
        const start = main.indexOf("ipcMain.handle('app:relaunch'");
        const body = main.slice(start, main.indexOf('\n  });', start));
        // origin/main: setIsQuitting(true); claude/quit-not-crash: beginQuit('relaunch') (which calls it).
        expect(body).toMatch(/setIsQuitting\(true\)|beginQuit\('relaunch'\)/);
        expect(body).toMatch(/app\.relaunch\(\)/);
    });
});

describe('gpuCrashSignature', () => {
    it('is the crash reporter\'s own signature for the same death, null when it is not recorded', () => {
        const rec = crashFromChildGone(PROD_GPU_GONE, T0, '1.0.20')!;
        expect(gpuCrashSignature(PROD_GPU_GONE, T0 + 5, '1.0.20')).toBe(crashSignature(rec));
        expect(gpuCrashSignature({ type: 'GPU', reason: 'killed', exitCode: 1 }, T0, '1.0.20')).toBeNull();
    });
});
