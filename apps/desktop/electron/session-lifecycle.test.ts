import { describe, it, expect } from 'vitest';
import { SessionLifecycle, crashRecordFor, type CrashEvent, type QuitTrigger } from './session-lifecycle';
import {
    mainScrubber, serializeMarker, PendingCrashStore, isStaleUncleanExit,
    type CrashInfoLike, type MarkerFs, type PendingCrash, type PendingStorage,
} from './diagnostics';

/**
 * "I closed the app, reopened it, and it said Cipherline closed unexpectedly."
 *
 * Every test here is one launch → (something) → next launch, with the marker
 * file on an in-memory fs shared between the "processes", exactly as the real
 * userData file is shared between launches. The wiring of these calls into
 * main.ts is pinned by session-lifecycle.wiring.test.ts.
 */

const T0 = Date.UTC(2026, 9, 11, 18, 0, 0);
const P = '/ud/diag-session.json';
const ctx = { now: T0, appVersion: '1.0.21', scrubber: () => mainScrubber('/home/u', 'u') };

function memFs(initial: Record<string, string> = {}): MarkerFs & { files: Record<string, string> } {
    const files = { ...initial };
    return {
        files,
        readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
        writeFileSync: (p, d) => { files[p] = d; },
        unlinkSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); delete files[p]; },
    };
}

/** One app process: its lifecycle + the crash records it would persist. */
function launch(fs: MarkerFs, version = '1.0.21', at = T0) {
    const records: CrashInfoLike[] = [];
    const lc = new SessionLifecycle({ markerEnabled: true, fs, markerPath: () => P, appVersion: () => version, now: () => at });
    return {
        lc,
        records,
        /** createWindow after winning the port. */
        start() { const r = lc.start(); if (r) records.push(r); return this; },
        /** Any crash signal, through the same gate main.ts uses. */
        event(e: CrashEvent) {
            const r = crashRecordFor(e, lc.ignoresCrashes, { ...ctx, appVersion: version });
            if (r) records.push(r);
            return this;
        },
        quit(trigger: QuitTrigger) { lc.beginQuit(trigger); return this; },
    };
}

/** The records the NEXT launch would find (and so prompt about). */
const nextLaunchRecords = (fs: MarkerFs, version = '1.0.21') => launch(fs, version, T0 + 60_000).start().records;

/** What Electron's teardown does to the child processes on a normal quit. */
const TEARDOWN: CrashEvent[] = [
    { source: 'child-process-gone', details: { type: 'GPU', reason: 'killed', exitCode: 0 } },
    { source: 'child-process-gone', details: { type: 'Utility', reason: 'clean-exit', exitCode: 0, serviceName: 'network.mojom.NetworkService' } },
    // Windows: services torn down on log-off / mid-exit can report abnormal-exit.
    { source: 'child-process-gone', details: { type: 'Utility', reason: 'abnormal-exit', exitCode: 1, serviceName: 'audio.mojom.AudioService' } },
    { source: 'render-process-gone', details: { reason: 'crashed', exitCode: -1073741819 } },
    // A callback touching a half-destroyed window during teardown.
    { source: 'main-exception', thrown: new TypeError('Object has been destroyed'), origin: 'uncaughtException' },
];

// ── The decision table: event × reason × quitting ────────────────────────────

describe('crashRecordFor — event × reason × quitting', () => {
    const REASONS = ['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit', 'clean-exit', 'killed', 'memory-eviction'] as const;
    const CRASH = new Set(['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit']);

    for (const reason of REASONS) {
        for (const quitting of [false, true]) {
            const expected = CRASH.has(reason) && !quitting;
            it(`render-process-gone × ${reason} × quitting=${quitting} → ${expected ? 'record' : 'none'}`, () => {
                const r = crashRecordFor({ source: 'render-process-gone', details: { reason, exitCode: 1 } }, quitting, ctx);
                expect(r !== null).toBe(expected);
                if (r) expect(r).toMatchObject({ kind: 'renderer_gone', reason });
            });
            it(`child-process-gone (GPU) × ${reason} × quitting=${quitting} → ${expected ? 'record' : 'none'}`, () => {
                const r = crashRecordFor({ source: 'child-process-gone', details: { type: 'GPU', reason, exitCode: 1 } }, quitting, ctx);
                expect(r !== null).toBe(expected);
                if (r) expect(r).toMatchObject({ kind: 'child_process_gone', process_type: 'GPU', reason });
            });
        }
    }

    for (const origin of ['uncaughtException', 'unhandledRejection'] as const) {
        it(`main-exception (${origin}) → record while running, none once quitting`, () => {
            const e: CrashEvent = { source: 'main-exception', thrown: new Error('boom'), origin };
            expect(crashRecordFor(e, false, ctx)).toMatchObject({ kind: 'main_exception' });
            expect(crashRecordFor(e, true, ctx)).toBeNull();
        });
    }

    it('renderer-report → record while running (when it carries something), none once quitting', () => {
        const e: CrashEvent = { source: 'renderer-report', payload: { name: 'TypeError', message: 'x is undefined' } };
        expect(crashRecordFor(e, false, ctx)).toMatchObject({ kind: 'renderer_exception' });
        expect(crashRecordFor(e, true, ctx)).toBeNull();
        expect(crashRecordFor({ source: 'renderer-report', payload: {} }, false, ctx)).toBeNull();
    });
});

// ── Normal closes: none of these may prompt on the next launch ───────────────

describe('a normal close never prompts on the next launch', () => {
    const PATHS: Array<{ name: string; run: (fs: MarkerFs) => void }> = [
        {
            name: 'tray Quit / Ctrl+Q / Cmd+Q (before-quit → teardown → will-quit)',
            run: (fs) => {
                const a = launch(fs).start().quit('before-quit');
                for (const e of TEARDOWN) a.event(e);
                a.quit('before-quit'); // will-quit belt and braces
                expect(a.records).toEqual([]);
            },
        },
        {
            name: 'X / Alt+F4 with close-to-tray off (last window closes → app.quit)',
            run: (fs) => { launch(fs).start().quit('before-quit').quit('before-quit'); },
        },
        {
            name: 'a quit cut short after before-quit (slow quit ended in Task Manager)',
            run: (fs) => { launch(fs).start().quit('before-quit'); /* killed: no will-quit */ },
        },
        {
            name: 'Restart & install — NSIS --updated force-kills the old app mid-quit, same version relaunch',
            run: (fs) => { launch(fs).start().quit('quit-and-install'); /* taskkill /F before will-quit */ },
        },
        {
            name: 'Windows restart / shut down / log off (session-end, then the OS ends the process)',
            run: (fs) => {
                const a = launch(fs).start().quit('session-end');
                for (const e of TEARDOWN) a.event(e);
                expect(a.records).toEqual([]);
            },
        },
        {
            name: 'macOS / Linux shutdown (powerMonitor shutdown)',
            run: (fs) => { launch(fs).start().quit('os-shutdown'); },
        },
        {
            name: '"Restart Cipherline to apply" (relaunch)',
            run: (fs) => { launch(fs).start().quit('relaunch').quit('before-quit').quit('before-quit'); },
        },
    ];

    for (const p of PATHS) {
        it(p.name, () => {
            const fs = memFs();
            p.run(fs);
            expect(fs.files[P]).toBeUndefined();
            expect(nextLaunchRecords(fs)).toEqual([]);
        });
    }

    it('the marker is gone the moment the quit is asked for, before any later quit step', () => {
        const fs = memFs();
        const a = launch(fs).start();
        expect(fs.files[P]).toBeDefined();
        a.quit('quit-and-install');
        expect(fs.files[P]).toBeUndefined();
    });

    it('a second launch that slipped past the single-instance lock does not touch the marker', () => {
        // main.ts: startSessionMarker runs only after the port is won, and the
        // loser hands off + app.exit(0)s before that (wiring test pins it).
        const fs = memFs();
        const primary = launch(fs).start();
        const second = launch(fs, '1.0.21', T0 + 5_000); // never start()s
        expect(second.records).toEqual([]);
        expect(JSON.parse(fs.files[P]).started_at).toBe(new Date(T0).toISOString());
        primary.quit('before-quit');
        expect(nextLaunchRecords(fs)).toEqual([]);
    });

    it('REGRESSION: had the second launch taken the marker over, it would have reported the live one', () => {
        // The pre-fix placement (startSessionMarker at the top of createWindow,
        // before the port hand-off) — kept as a model to show the cost.
        const fs = memFs();
        launch(fs).start();
        const second = launch(fs, '1.0.21', T0 + 5_000).start();
        expect(second.records.map(r => r.kind)).toEqual(['unclean_exit']);
    });

    it('updating via an old build (marker left by the force-kill, different version) is not a crash', () => {
        const fs = memFs({ [P]: serializeMarker('1.0.20', T0 - 3_600_000) });
        expect(nextLaunchRecords(fs, '1.0.21')).toEqual([]);
        // and this session's marker replaced it
        expect(JSON.parse(fs.files[P]).version).toBe('1.0.21');
    });

    it('beginQuit before start (OS ending the session during startup) leaves no marker', () => {
        const fs = memFs();
        const a = launch(fs);
        a.quit('session-end');
        a.start();
        expect(fs.files[P]).toBeUndefined();
    });
});

// ── Real crashes are still caught ────────────────────────────────────────────

describe('real crashes are still caught', () => {
    it('main process hard-killed (taskkill /F, native crash, power loss) → unclean_exit next launch', () => {
        const fs = memFs();
        launch(fs).start(); // ... and the process just vanishes
        const recs = nextLaunchRecords(fs);
        expect(recs).toHaveLength(1);
        expect(recs[0]).toMatchObject({ kind: 'unclean_exit', app_version_at_crash: '1.0.21', occurred_at: new Date(T0).toISOString() });
    });

    it('a garbage / unversioned marker is still reported', () => {
        expect(nextLaunchRecords(memFs({ [P]: '{{{' }))).toMatchObject([{ kind: 'unclean_exit' }]);
    });

    it('renderer / GPU crash and main exceptions while running are recorded', () => {
        const a = launch(memFs()).start()
            .event({ source: 'render-process-gone', details: { reason: 'crashed', exitCode: -1073741819 } })
            .event({ source: 'child-process-gone', details: { type: 'GPU', reason: 'crashed', exitCode: 1 } })
            .event({ source: 'main-exception', thrown: new Error('boom'), origin: 'unhandledRejection' });
        expect(a.records.map(r => r.kind)).toEqual(['renderer_gone', 'child_process_gone', 'main_exception']);
    });

    it('Restart & install that could not launch the installer → cancelQuit re-arms: a later kill is caught', () => {
        const fs = memFs();
        const a = launch(fs).start().quit('quit-and-install');
        expect(fs.files[P]).toBeUndefined();
        expect(a.lc.quitTrigger).toBe('quit-and-install');
        a.lc.cancelQuit();
        expect(a.lc.isQuitting).toBe(false);
        expect(a.lc.quitTrigger).toBeNull();
        expect(JSON.parse(fs.files[P])).toMatchObject({ version: '1.0.21', started_at: new Date(T0).toISOString() });
        a.event({ source: 'render-process-gone', details: { reason: 'oom' } });
        expect(a.records.map(r => r.kind)).toEqual(['renderer_gone']);
        // the process then dies without quitting
        expect(nextLaunchRecords(fs)).toMatchObject([{ kind: 'unclean_exit' }]);
    });

    it('cancelQuit without a quit is a no-op', () => {
        const fs = memFs();
        const a = launch(fs).start();
        const before = fs.files[P];
        a.lc.cancelQuit();
        expect(fs.files[P]).toBe(before);
    });

    it('disabled (dev / smoke test): no marker is ever written or read', () => {
        const fs = memFs({ [P]: serializeMarker('1.0.21', T0 - 1000) });
        const lc = new SessionLifecycle({ markerEnabled: false, fs, markerPath: () => P, appVersion: () => '1.0.21', now: () => T0 });
        expect(lc.start()).toBeNull();
        lc.beginQuit('before-quit');
        expect(fs.files[P]).toBe(serializeMarker('1.0.21', T0 - 1000));
    });

    it('start() is once per process (macOS re-creating the window)', () => {
        const fs = memFs();
        const a = launch(fs).start();
        const first = fs.files[P];
        a.start();
        expect(fs.files[P]).toBe(first);
        expect(a.records).toEqual([]);
    });
});

// ── Stale records already persisted by older builds ──────────────────────────

describe('stale unclean exits from an older version are dropped on attach', () => {
    const rec = (over: Partial<CrashInfoLike>, seen = false): PendingCrash => ({
        signature: 'x', count: 1, seen,
        crash: { kind: 'unclean_exit', process_type: 'browser', reason: 'unclean-exit', occurred_at: '2026-10-10T10:00:00.000Z', ...over },
    });

    it('isStaleUncleanExit', () => {
        expect(isStaleUncleanExit(rec({ app_version_at_crash: '1.0.20' }), '1.0.21')).toBe(true);
        expect(isStaleUncleanExit(rec({ app_version_at_crash: '1.0.21' }), '1.0.21')).toBe(false);
        expect(isStaleUncleanExit(rec({ app_version_at_crash: '1.0.20' }, true), '1.0.21')).toBe(false);
        expect(isStaleUncleanExit(rec({}), '1.0.21')).toBe(false);
        expect(isStaleUncleanExit(rec({ kind: 'renderer_gone', app_version_at_crash: '1.0.20' }), '1.0.21')).toBe(false);
        expect(isStaleUncleanExit(rec({ app_version_at_crash: '1.0.20' }), 'garbage')).toBe(false);
    });

    it('attach(storage, version) keeps real records and this launch\'s, drops the stale one', () => {
        const persisted = [
            rec({ app_version_at_crash: '1.0.20' }),
            { signature: 'y', count: 1, seen: false, crash: { kind: 'renderer_gone' as const, process_type: 'renderer', reason: 'crashed', occurred_at: '2026-10-10T10:00:00.000Z', app_version_at_crash: '1.0.20' } },
        ];
        let stored: string | null = JSON.stringify(persisted);
        const storage: PendingStorage = { read: () => stored, write: (v) => { stored = v; }, clear: () => { stored = null; } };
        const store = new PendingCrashStore();
        store.add({ kind: 'unclean_exit', process_type: 'browser', reason: 'unclean-exit', occurred_at: '2026-10-11T09:00:00.000Z', app_version_at_crash: '1.0.21' });
        store.attach(storage, '1.0.21');
        const kinds = store.all().map(p => [p.crash.kind, p.crash.app_version_at_crash]);
        expect(kinds).toEqual([['renderer_gone', '1.0.20'], ['unclean_exit', '1.0.21']]);
        expect(JSON.parse(stored!)).toHaveLength(2);
    });

    it('attach without a version keeps everything (old behaviour)', () => {
        let stored: string | null = JSON.stringify([rec({ app_version_at_crash: '1.0.20' })]);
        const store = new PendingCrashStore();
        store.attach({ read: () => stored, write: (v) => { stored = v; }, clear: () => { stored = null; } });
        expect(store.all()).toHaveLength(1);
    });
});

// ── Windows log-off / shutdown: reports b40df5f4, 8034b4a1, 5f888d8a, 88ce6334 ─

describe('Windows ends the session: the child dies first, or session-end never arrives', () => {
    const LOGOFF = -1073741205; // 0xC000026B STATUS_DLL_INIT_FAILED_LOGOFF
    const netService: CrashEvent = { source: 'child-process-gone', details: { type: 'Utility', reason: 'crashed', exitCode: LOGOFF, serviceName: 'network.mojom.NetworkService' } };
    const videoCapture: CrashEvent = { source: 'child-process-gone', details: { type: 'Utility', reason: 'crashed', exitCode: LOGOFF, serviceName: 'video_capture.mojom.VideoCaptureService' } };

    it('the log-off exit code is never a crash record, with the app otherwise running (b40df5f4 / 8034b4a1)', () => {
        for (const e of [netService, videoCapture]) expect(crashRecordFor(e, false, ctx)).toBeNull();
        expect(crashRecordFor({ source: 'render-process-gone', details: { reason: 'crashed', exitCode: LOGOFF } }, false, ctx)).toBeNull();
    });

    it('POSITIVE CONTROL: the same process dying with any other crash code is still a record', () => {
        const other = (exitCode: number): CrashEvent => ({ source: 'child-process-gone', details: { type: 'Utility', reason: 'crashed', exitCode, serviceName: 'network.mojom.NetworkService' } });
        for (const code of [-1073741819, -1073741795, 34, 1, LOGOFF + 1]) {
            expect(crashRecordFor(other(code), false, ctx), `exit ${code}`).toMatchObject({ kind: 'child_process_gone', exit_code: code });
        }
    });

    it('query-session-end (negotiation) drops the marker and silences crash events', () => {
        const fs = memFs();
        const a = launch(fs).start();
        a.lc.suspectSessionEnd();
        expect(fs.files[P]).toBeUndefined();
        expect(a.lc.isQuitting).toBe(false); // not a quit: close-to-tray keeps hiding the window
        expect(a.lc.ignoresCrashes).toBe(true);
        // Windows takes the children down, then the app, without ever dispatching session-end
        for (const e of TEARDOWN) a.event(e);
        expect(a.records).toEqual([]);
        expect(nextLaunchRecords(fs)).toEqual([]); // 5f888d8a / 88ce6334: no "closed unexpectedly"
    });

    it('a child dying of the log-off code is a session end: the marker goes even with no query/session-end event', () => {
        const fs = memFs();
        const a = launch(fs).start();
        // main.ts noteOsSessionEndExit → beginQuit('session-end') before recordCrash
        a.quit('session-end').event(netService);
        expect(a.records).toEqual([]);
        expect(a.lc.quitTrigger).toBe('session-end');
        expect(nextLaunchRecords(fs)).toEqual([]);
    });

    it('a shutdown that was CANCELLED re-arms the marker and crash events (a later kill is caught)', () => {
        const fs = memFs();
        const a = launch(fs).start();
        a.lc.suspectSessionEnd();
        a.lc.resumeAfterSuspectedEnd();
        expect(a.lc.ignoresCrashes).toBe(false);
        expect(a.lc.armed).toBe(true);
        expect(JSON.parse(fs.files[P]).started_at).toBe(new Date(T0).toISOString());
        a.event({ source: 'render-process-gone', details: { reason: 'crashed', exitCode: -1073741819 } });
        expect(a.records).toHaveLength(1);
        expect(nextLaunchRecords(fs).map(r => r.kind)).toEqual(['unclean_exit']);
    });

    it('session-end after a suspected end stays a quit; a late resume cannot resurrect the marker', () => {
        const fs = memFs();
        const a = launch(fs).start();
        a.lc.suspectSessionEnd();
        a.quit('session-end');
        a.lc.resumeAfterSuspectedEnd(); // the timer firing afterwards
        expect(a.lc.isQuitting).toBe(true);
        expect(fs.files[P]).toBeUndefined();
        expect(nextLaunchRecords(fs)).toEqual([]);
    });

    it('suspecting before start() leaves no marker either', () => {
        const fs = memFs();
        const a = launch(fs);
        a.lc.suspectSessionEnd();
        a.start();
        expect(fs.files[P]).toBeUndefined();
    });

    it('suspecting after a quit changes nothing; resume without a suspicion is a no-op', () => {
        const fs = memFs();
        const a = launch(fs).start().quit('before-quit');
        a.lc.suspectSessionEnd();
        a.lc.resumeAfterSuspectedEnd();
        expect(a.lc.isQuitting).toBe(true);
        expect(fs.files[P]).toBeUndefined();
        const b = launch(memFs()).start();
        b.lc.resumeAfterSuspectedEnd();
        expect(b.lc.armed).toBe(true);
    });
});

// ── Transient network failures: report 49e3d5ce ──────────────────────────────

describe('a bare net::ERR_* unhandled rejection is not a crash', () => {
    const rejection = (m: string): CrashEvent => ({ source: 'main-exception', thrown: new Error(m), origin: 'unhandledRejection' });

    it('net::ERR_HTTP2_PROTOCOL_ERROR (the updater download on 1.0.20)', () => {
        expect(crashRecordFor(rejection('net::ERR_HTTP2_PROTOCOL_ERROR'), false, ctx)).toBeNull();
        expect(crashRecordFor(rejection('net::ERR_CONNECTION_RESET'), false, ctx)).toBeNull();
    });

    it('POSITIVE CONTROL: every other rejection, and a net error as an uncaught EXCEPTION, still records', () => {
        expect(crashRecordFor(rejection('Cannot read properties of undefined'), false, ctx)).toMatchObject({ kind: 'main_exception' });
        expect(crashRecordFor(rejection('request failed: net::ERR_HTTP2_PROTOCOL_ERROR at https://x'), false, ctx)).toMatchObject({ kind: 'main_exception' });
        expect(crashRecordFor({ source: 'main-exception', thrown: new Error('net::ERR_HTTP2_PROTOCOL_ERROR'), origin: 'uncaughtException' }, false, ctx)).toMatchObject({ kind: 'main_exception' });
    });
});
