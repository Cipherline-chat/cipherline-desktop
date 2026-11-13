import { describe, it, expect } from 'vitest';
import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import {
    InflightBoard, MainWatchdog, crashFromFreezeRecord, parseFreezeRecord, sanitizeFlags, sanitizeLabels, watchdogRuntime,
    FREEZE_RECORD_FILE, FREEZE_WRITE_MIN_GAP_MS, HUNG_EXIT_REASON, MAIN_STALL_RECORD_MS, MAX_FREEZE_RECORD_BYTES, WORKER_BOOT_SOURCE,
    type WatchdogDeps, type WorkerLike,
} from './freeze-evidence';
import { PendingCrashStore, crashSignature } from './diagnostics';

/** A memory file system + a manual clock + a counter main can "bump" or leave frozen. */
function rig(over: Partial<WatchdogDeps> = {}) {
    const files = new Map<string, string>();
    const writes: string[] = [];
    let t = 1_000_000;
    let counter = 0;
    let inflight: string[] = [];
    const deps: WatchdogDeps = {
        fs: {
            writeFileSync: (p, d) => { files.set(p, d); writes.push(d); },
            unlinkSync: (p) => { if (!files.delete(p)) throw new Error('ENOENT'); },
        },
        file: '/u/' + FREEZE_RECORD_FILE, now: () => t, readCounter: () => counter, readInflight: () => inflight,
        version: '1.0.24-staging.201', startedAt: 999_000, tickMs: 1000, stallMs: MAIN_STALL_RECORD_MS, minGapMs: FREEZE_WRITE_MIN_GAP_MS,
        ...over,
    };
    const wd = watchdogRuntime().createWatchdog(deps);
    return {
        wd, files, writes, file: deps.file,
        /** Main alive for `secs` seconds: bumps the counter every tick. */
        alive(secs: number) { for (let i = 0; i < secs; i++) { t += 1000; counter++; wd.tick(); } },
        /** Main blocked for `secs` seconds: the counter does not move. */
        blocked(secs: number) { for (let i = 0; i < secs; i++) { t += 1000; wd.tick(); } },
        setInflight(l: string[]) { inflight = l; },
        advance(ms: number) { t += ms; },
        now: () => t,
    };
}

describe('watchdog runtime: main-thread stall', () => {
    it('a healthy main never writes a record', () => {
        const r = rig();
        r.alive(30);
        expect(r.writes).toHaveLength(0);
        expect(r.files.size).toBe(0);
    });

    it('writes a record once main has been blocked for the threshold, naming what it was inside', () => {
        const r = rig();
        r.alive(3);
        r.setInflight(['ipc:desktop-capturer-resolve', 'audio:list-apps']);
        r.wd.message({ type: 'ctx', activity: ['ipc:presence-heartbeat', 'capture:resolve'], flags: { in_call: true, sharing: true } });
        r.blocked(MAIN_STALL_RECORD_MS / 1000 - 1);
        expect(r.writes).toHaveLength(0); // not yet
        r.blocked(1);
        expect(r.writes).toHaveLength(1);
        const rec = parseFreezeRecord(r.files.get(r.file))!;
        expect(rec.main_stalled_ms).toBeGreaterThanOrEqual(MAIN_STALL_RECORD_MS);
        expect(rec.inflight).toEqual(['ipc:desktop-capturer-resolve', 'audio:list-apps']);
        expect(rec.activity).toEqual(['ipc:presence-heartbeat', 'capture:resolve']);
        expect(rec.flags).toEqual({ in_call: true, sharing: true });
        expect(rec.quit_requested).toBe(false);
    });

    it('the record is small', () => {
        const r = rig();
        r.setInflight(Array.from({ length: 8 }, (_, i) => `ipc:some-long-handler-name-${i}`));
        r.wd.message({ type: 'ctx', activity: Array.from({ length: 30 }, (_, i) => `activity:label-number-${i}`), flags: {} });
        r.blocked(7);
        expect(r.writes[0].length).toBeLessThan(MAX_FREEZE_RECORD_BYTES);
    });

    it('rate limit: the same hang rewrites at most once per FREEZE_WRITE_MIN_GAP_MS', () => {
        const r = rig();
        r.blocked(6);
        expect(r.writes).toHaveLength(1);
        r.blocked(4); // t+10 s total, only 4 s since the write
        expect(r.writes).toHaveLength(1);
        r.blocked(1); // 5 s since the write
        expect(r.writes).toHaveLength(2);
        r.blocked(60);
        expect(r.writes.length).toBeLessThanOrEqual(2 + 12); // ~1 per 5 s, never 1 per tick
        expect(r.writes.length).toBeLessThan(20);
    });

    it('a state change (quit requested while hung) is written at once, not after the gap', () => {
        const r = rig();
        r.blocked(6);
        r.wd.message({ type: 'quit' });
        r.blocked(1);
        expect(r.writes).toHaveLength(2);
        expect(parseFreezeRecord(r.writes[1])!.quit_requested).toBe(true);
    });

    it('a hang that recovers deletes the record (nothing left behind)', () => {
        const r = rig();
        r.blocked(8);
        expect(r.files.size).toBe(1);
        r.alive(1);
        expect(r.files.size).toBe(0);
        r.alive(5);
        expect(r.writes).toHaveLength(1);
    });

    it('a machine sleep (a huge gap between ticks) is not a stall', () => {
        const r = rig();
        r.alive(3);
        r.advance(8 * 3600_000);
        r.wd.tick();
        expect(r.writes).toHaveLength(0);
    });

    it('resume() after a power event resets the stall clock', () => {
        const r = rig();
        r.blocked(5);
        r.wd.message({ type: 'resume' });
        r.blocked(5);
        expect(r.writes).toHaveLength(0);
    });

    it('a failing disk never throws out of the tick', () => {
        const r = rig({ fs: { writeFileSync: () => { throw new Error('ENOSPC'); }, unlinkSync: () => undefined } });
        expect(() => r.blocked(10)).not.toThrow();
    });
});

describe('watchdog runtime: renderer unresponsive', () => {
    it('writes while the renderer is unresponsive and main is fine, with the duration', () => {
        const r = rig();
        r.alive(2);
        r.wd.message({ type: 'renderer', unresponsive: true });
        r.alive(1);
        expect(r.writes).toHaveLength(1);
        r.alive(6);
        const rec = parseFreezeRecord(r.files.get(r.file))!;
        expect(rec.main_stalled_ms).toBe(0);
        expect(rec.renderer_unresponsive_ms).toBeGreaterThanOrEqual(6000);
    });

    it('responsive again removes the record', () => {
        const r = rig();
        r.wd.message({ type: 'renderer', unresponsive: true });
        r.alive(2);
        expect(r.files.size).toBe(1);
        r.wd.message({ type: 'renderer', unresponsive: false });
        r.alive(1);
        expect(r.files.size).toBe(0);
    });

    it('SIGTERM while the renderer is hung: the quit marker goes, the freeze record stays', () => {
        const r = rig();
        r.wd.message({ type: 'renderer', unresponsive: true });
        r.alive(2);
        r.wd.message({ type: 'quit' }); // beforeQuit -> sessionLifecycle drops its marker; the watchdog only annotates
        r.alive(1);
        expect(r.files.size).toBe(1);
        expect(parseFreezeRecord(r.files.get(r.file))!.quit_requested).toBe(true);
    });
});

describe('privacy', () => {
    const PLANTED = ['/home/alice/secret-project/notes.txt', 'alice@example.com', 'user 4f1d2c3b-aaaa-bbbb-cccc-1234567890ab', 'C:\\Users\\alice\\x', 'ipc:foo bar'];

    it('planted values never reach the file via context messages or the in-flight board', () => {
        const r = rig();
        const board = new InflightBoard();
        for (const p of PLANTED) expect(board.enter(p)).toBe(-1);
        r.setInflight(board.read());
        r.wd.message({ type: 'ctx', activity: [...PLANTED, 'ipc:ok-label'] as string[], flags: { in_call: true, nickname: 'alice', sharing: 'yes' } as never });
        r.blocked(7);
        const text = r.writes[0];
        for (const p of PLANTED) expect(text).not.toContain(p);
        expect(text).not.toContain('alice');
        const rec = parseFreezeRecord(text)!;
        expect(rec.activity).toEqual(['ipc:ok-label']);
        expect(rec.flags).toEqual({ in_call: true });
    });

    it('negative control: a legitimate static label DOES get through', () => {
        const r = rig();
        r.setInflight(['ipc:securekv-open']);
        r.blocked(7);
        expect(parseFreezeRecord(r.writes[0])!.inflight).toEqual(['ipc:securekv-open']);
    });

    it('a hand-edited / corrupt file cannot smuggle text into the crash record', () => {
        const evil = JSON.stringify({
            v: 1, version: '1.0.24-staging.201', started_at: 1, written_at: 2, hung_since: 1, main_stalled_ms: 9000, renderer_unresponsive_ms: 0,
            quit_requested: false, flags: { in_call: true, secret: 'x' }, inflight: PLANTED, activity: PLANTED, extra: 'alice',
        });
        const c = crashFromFreezeRecord(evil, 10_000, '1.0.24-staging.201')!;
        for (const p of PLANTED) expect(c.message).not.toContain(p);
        expect(c.message).not.toContain('alice');
        expect(c.message).toContain('in_flight=none');
        expect(c.message).toContain('state=in_call');
    });

    it('sanitizers drop non-strings, non-labels and duplicates and cap the count', () => {
        expect(sanitizeLabels([1, null, 'ok', 'ok', '9bad', 'a'.repeat(80)])).toEqual(['ok']);
        expect(sanitizeLabels(Array.from({ length: 50 }, (_, i) => `l${i}`))).toHaveLength(12);
        expect(sanitizeLabels('nope')).toEqual([]);
        expect(sanitizeFlags({ in_call: 1, sharing: true, evil: true })).toEqual({ sharing: true });
    });
});

describe('next launch: crashFromFreezeRecord', () => {
    const base = {
        v: 1, version: '1.0.24-staging.201', started_at: 1_000, written_at: 2_000_000, hung_since: 1_500_000,
        main_stalled_ms: 0, renderer_unresponsive_ms: 42_000, quit_requested: true,
        flags: { in_call: true, sharing: true }, inflight: ['ipc:foo'], activity: ['capture:resolve'],
    };

    it('turns a record into an unclean_exit crash with reason hung-exit and the evidence in the message', () => {
        const c = crashFromFreezeRecord(JSON.stringify(base), 3_000_000, '1.0.24-staging.201')!;
        expect(c.kind).toBe('unclean_exit');
        expect(c.reason).toBe(HUNG_EXIT_REASON);
        expect(c.occurred_at).toBe(new Date(1_500_000).toISOString());
        expect(c.message).toContain('renderer_unresponsive=42s');
        expect(c.message).toContain('quit_requested=1');
        expect(c.message).toContain('state=in_call,sharing');
        expect(c.message).toContain('in_flight=ipc:foo');
        expect(c.message).toContain('recent=capture:resolve');
    });

    it('a record from another app version is dropped (an installer replaced the app)', () => {
        expect(crashFromFreezeRecord(JSON.stringify(base), 3_000_000, '1.0.25')).toBeNull();
    });

    it('missing, garbage, oversized, wrong-schema and not-a-hang files are null (never coerced)', () => {
        expect(crashFromFreezeRecord(null, 1, '1.0.24-staging.201')).toBeNull();
        expect(crashFromFreezeRecord('{not json', 1, '1.0.24-staging.201')).toBeNull();
        expect(crashFromFreezeRecord(JSON.stringify({ ...base, v: 2 }), 1, '1.0.24-staging.201')).toBeNull();
        expect(crashFromFreezeRecord(JSON.stringify({ ...base, main_stalled_ms: 0, renderer_unresponsive_ms: 0 }), 1, '1.0.24-staging.201')).toBeNull();
        expect(crashFromFreezeRecord(JSON.stringify({ ...base, hung_since: 'x' }), 1, '1.0.24-staging.201')).toBeNull();
        expect(crashFromFreezeRecord(JSON.stringify({ ...base, pad: 'x'.repeat(MAX_FREEZE_RECORD_BYTES) }), 1, '1.0.24-staging.201')).toBeNull();
    });

    it('main-thread hang detected after the fact: blocked main + kill leaves a record the next start reads; a healthy kill leaves none', () => {
        const hung = rig();
        hung.alive(5);
        hung.setInflight(['ipc:audio-list-apps']);
        hung.blocked(12); // ... and the user kills it here: nothing more can run
        const next = crashFromFreezeRecord(hung.files.get(hung.file) ?? null, hung.now() + 20_000, '1.0.24-staging.201')!;
        expect(next.reason).toBe(HUNG_EXIT_REASON);
        expect(next.message).toContain('main_blocked=');
        expect(next.message).toContain('in_flight=ipc:audio-list-apps');

        const healthy = rig();
        healthy.alive(40); // killed while healthy: no file, so the plain unclean-exit marker rules
        expect(crashFromFreezeRecord(healthy.files.get(healthy.file) ?? null, healthy.now(), '1.0.24-staging.201')).toBeNull();
    });

    it('goes through the pending-crash store like any crash and survives dedupe', () => {
        const store = new PendingCrashStore();
        const c = crashFromFreezeRecord(JSON.stringify(base), 3_000_000, '1.0.24-staging.201')!;
        store.add(c);
        store.add(c);
        const all = store.all();
        expect(all).toHaveLength(1);
        expect(all[0].count).toBe(2);
        expect(all[0].crash.reason).toBe(HUNG_EXIT_REASON);
        expect(all[0].signature).toBe(crashSignature(c));
    });
});

describe('InflightBoard', () => {
    it('enter / leave / read; a full board skips instead of throwing', () => {
        const b = new InflightBoard();
        const slots = Array.from({ length: 8 }, (_, i) => b.enter(`ipc:h${i}`));
        expect(slots.every(s => s >= 0)).toBe(true);
        expect(b.enter('ipc:ninth')).toBe(-1);
        expect(b.read()).toHaveLength(8);
        b.leave(slots[3]);
        expect(b.read()).not.toContain('ipc:h3');
        expect(b.enter('ipc:ninth')).toBe(slots[3]);
    });
});

describe('MainWatchdog (controller)', () => {
    function fakeWorkerFactory() {
        const made: Array<{ data: Record<string, unknown>; posted: unknown[]; terminated: boolean; errorCb?: (e: unknown) => void }> = [];
        const make = (_src: string, data: Record<string, unknown>): WorkerLike => {
            const rec: { data: Record<string, unknown>; posted: unknown[]; terminated: boolean; errorCb?: (e: unknown) => void } = { data, posted: [], terminated: false };
            made.push(rec);
            return {
                postMessage: (m) => { rec.posted.push(m); },
                terminate: () => { rec.terminated = true; },
                on: (ev, cb) => { if (ev === 'error') rec.errorCb = cb as (e: unknown) => void; },
            };
        };
        return { make, made };
    }

    it('smoke-test guard: disabled = no worker, no timer, no file system access at all', () => {
        const f = fakeWorkerFactory();
        const touched: string[] = [];
        const fs = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return () => undefined; } }) as unknown as WatchdogDeps['fs'];
        const wd = new MainWatchdog({ fs, file: '/u/x', version: '1.0.0', makeWorker: f.make }, false);
        wd.start();
        wd.setContext(['ipc:a'], { in_call: true });
        wd.setRendererUnresponsive(true);
        wd.noteQuit();
        wd.stop();
        expect(wd.mode).toBe('off');
        expect(f.made).toHaveLength(0);
        expect(touched).toEqual([]);
    });

    it('enabled: starts a worker with the shared counter and board, forwards state, dedupes identical context', () => {
        const f = fakeWorkerFactory();
        const wd = new MainWatchdog({ fs: {} as never, file: '/u/x', version: '1.0.0', makeWorker: f.make }, true);
        wd.start();
        try {
            expect(wd.mode).toBe('worker');
            expect(f.made[0].data.board).toBe(wd.board.buffer);
            wd.setContext(['ipc:a', '/home/alice/x'], { in_call: true, junk: 1 });
            wd.setContext(['ipc:a'], { in_call: true });
            wd.setRendererUnresponsive(true);
            wd.noteQuit();
            expect(f.made[0].posted).toEqual([
                { type: 'ctx', activity: ['ipc:a'], flags: { in_call: true } },
                { type: 'renderer', unresponsive: true },
                { type: 'quit' },
            ]);
        } finally { wd.stop(); }
        expect(f.made[0].terminated).toBe(true);
    });

    it('falls back to an in-thread watchdog when a worker cannot be made (renderer hangs still recorded)', () => {
        const files = new Map<string, string>();
        const fs = { writeFileSync: (p: string, d: string) => { files.set(p, d); }, unlinkSync: (p: string) => { files.delete(p); } };
        const wd = new MainWatchdog({
            fs, file: '/u/x', version: '1.0.0', tickMs: 10, makeWorker: () => { throw new Error('no worker_threads'); },
        }, true);
        wd.start();
        try {
            expect(wd.mode).toBe('in-thread');
            wd.setRendererUnresponsive(true);
        } finally { wd.stop(); }
    });
});

describe('real worker thread (integration)', () => {
    it('writes the record from the worker WHILE the main thread is blocked, then removes it when main recovers', async () => {
        const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'freeze-ev-'));
        const file = path.join(dir, FREEZE_RECORD_FILE);
        const wd = new MainWatchdog({
            fs: nodeFs, file, version: '1.0.24-staging.201', tickMs: 40, stallMs: 250, minGapMs: 100,
            makeWorker: (src, data) => new Worker(src, { eval: true, workerData: data }) as unknown as WorkerLike,
        }, true);
        try {
            expect(WORKER_BOOT_SOURCE).toContain('createWatchdog');
            wd.start();
            await new Promise(r => setTimeout(r, 150)); // worker is up, main beating
            expect(nodeFs.existsSync(file)).toBe(false);
            const slot = wd.board.enter('ipc:test-blocker');
            wd.setContext(['capture:test'], { in_call: true });
            await new Promise(r => setTimeout(r, 120)); // let the context message land
            // Block the main thread: no timers run, no beats, no messages.
            const until = Date.now() + 900;
            while (Date.now() < until) { /* busy */ }
            // Still synchronous: nothing on main has run since the block began.
            const during = nodeFs.existsSync(file) ? nodeFs.readFileSync(file, 'utf8') : null;
            expect(during).not.toBeNull();
            const rec = parseFreezeRecord(during)!;
            expect(rec.main_stalled_ms).toBeGreaterThanOrEqual(250);
            expect(rec.inflight).toContain('ipc:test-blocker');
            expect(rec.activity).toEqual(['capture:test']);
            expect(rec.flags).toEqual({ in_call: true });
            wd.board.leave(slot);
            // Main is back: beats resume and the worker removes the record.
            await new Promise(r => setTimeout(r, 400));
            expect(nodeFs.existsSync(file)).toBe(false);
        } finally {
            wd.stop();
            nodeFs.rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});
