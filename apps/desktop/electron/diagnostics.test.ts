import { describe, it, expect } from 'vitest';
import {
    addPendingCrash, crashSignature, crashFromChildGone, crashFromRenderGone, crashFromMainError,
    crashFromRendererReport, crashFromLeftoverMarker, rotateSessionMarker, clearSessionMarker,
    parsePendingCrashes, PendingCrashStore, MAX_PENDING_CRASHES, isCrashReason, mainScrubber,
    buildSystemInfo, reportChannel, validateReportFile, defaultReportFileName, MAX_REPORT_FILE_BYTES,
    serializeMarker, parseSignatures, type CrashInfoLike, type MarkerFs, type PendingStorage,
} from './diagnostics';

const T0 = Date.UTC(2026, 9, 7, 18, 0, 0);
const HOME = '/home/Dawson Kraai';
const OS_USER = 'dawsonk';
const scrubber = mainScrubber(HOME, OS_USER);

const crash = (over: Partial<CrashInfoLike> = {}): CrashInfoLike => ({
    kind: 'renderer_gone', process_type: 'renderer', reason: 'crashed', occurred_at: new Date(T0).toISOString(), ...over,
});

describe('child / renderer process filter', () => {
    it('only abnormal reasons are crashes', () => {
        for (const r of ['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit']) expect(isCrashReason(r)).toBe(true);
        for (const r of ['clean-exit', 'killed', 'memory-eviction', undefined, 42, 'CRASHED']) expect(isCrashReason(r)).toBe(false);
    });

    it('child-process-gone keeps type, reason, exit code, service name — and nothing else', () => {
        const c = crashFromChildGone({ type: 'GPU', reason: 'crashed', exitCode: -1073741819, name: "Dawson's GPU", serviceName: 'viz.mojom.GpuService' }, T0, '1.0.17');
        expect(c).toEqual({
            kind: 'child_process_gone', process_type: 'GPU', reason: 'crashed', exit_code: -1073741819,
            service_name: 'viz.mojom.GpuService', occurred_at: '2026-10-07T18:00:00.000Z', app_version_at_crash: '1.0.17',
        });
        expect(JSON.stringify(c)).not.toContain('Dawson');
    });

    it('child-process-gone with a normal exit is ignored', () => {
        expect(crashFromChildGone({ type: 'Utility', reason: 'clean-exit', exitCode: 0 }, T0, '1.0.17')).toBeNull();
        expect(crashFromChildGone({ type: 'Utility', reason: 'killed', exitCode: 1 }, T0, '1.0.17')).toBeNull();
    });

    it('a weird process type / service name is not passed through', () => {
        const c = crashFromChildGone({ type: '/home/x/evil<script>', reason: 'oom', serviceName: 'has spaces and /slashes' }, T0, '1.0.17')!;
        expect(c.process_type).toBe('unknown');
        expect(c.service_name).toBeUndefined();
    });

    it('render-process-gone', () => {
        expect(crashFromRenderGone({ reason: 'oom', exitCode: -536870904 }, T0, '1.0.17')).toMatchObject({ kind: 'renderer_gone', reason: 'oom', exit_code: -536870904 });
        expect(crashFromRenderGone({ reason: 'clean-exit', exitCode: 0 }, T0, '1.0.17')).toBeNull();
    });
});

describe('main / renderer exceptions are scrubbed', () => {
    it('uncaughtException: home dir, OS user, emails, paths and tokens are gone', () => {
        const err = new TypeError(`Cannot read 'x' of undefined while opening ${HOME}/Documents/secret plan.docx for dawson@example.com token=abcdef123456`);
        err.stack = `TypeError: boom\n    at load (${HOME}/AppData/Local/Programs/cipherline/resources/app.asar/dist-electron/main.js:10:5)\n    at /home/${OS_USER}/x.js:1:1`;
        const c = crashFromMainError(err, 'uncaughtException', T0, '1.0.17', scrubber);
        const s = JSON.stringify(c);
        for (const bad of ['Dawson Kraai', 'secret plan', 'dawson@example.com', 'abcdef123456', OS_USER, 'Documents']) expect(s).not.toContain(bad);
        expect(c.error_name).toBe('TypeError');
        expect(c.stack).toContain('app.asar/dist-electron/main.js:10:5');
        expect(c.reason).toBe('uncaught-exception');
    });

    it('unhandledRejection with a non-Error value', () => {
        const c = crashFromMainError(`failed for ${HOME}/notes.txt`, 'unhandledRejection', T0, '1.0.17', scrubber);
        expect(c.reason).toBe('unhandled-rejection');
        expect(c.message).not.toContain('Dawson');
        expect(c.error_name).toBeUndefined();
    });

    it('renderer error-boundary report: untrusted shape, scrubbed', () => {
        expect(crashFromRendererReport(null, T0, '1.0.17', scrubber)).toBeNull();
        expect(crashFromRendererReport({}, T0, '1.0.17', scrubber)).toBeNull();
        expect(crashFromRendererReport([1, 2], T0, '1.0.17', scrubber)).toBeNull();
        const c = crashFromRendererReport({ name: 'Error', message: 'chat with @alice_w broke at https://evil.example.com/a?b=c', stack: 'Error\n    at X (http://127.0.0.1:42917/assets/index-AbC.js:1:2)' }, T0, '1.0.17', scrubber)!;
        expect(c.kind).toBe('renderer_exception');
        expect(c.message).not.toContain('alice_w');
        expect(c.message).not.toContain('evil.example.com');
        expect(c.stack).toContain('assets/index-AbC.js:1:2');
        expect(crashFromRendererReport({ name: 'Bad Name With Spaces', message: 'x' }, T0, '1.0.17', scrubber)!.error_name).toBeUndefined();
    });
});

describe('pending crash list', () => {
    it('dedupes identical signatures (newest wins, count kept, seen reset)', () => {
        let l = addPendingCrash([], crash({ exit_code: 1 }));
        l[0].seen = true;
        l = addPendingCrash(l, crash({ exit_code: 2, occurred_at: '2026-10-07T18:05:00.000Z' }));
        expect(l).toHaveLength(1);
        expect(l[0].count).toBe(2);
        expect(l[0].seen).toBe(false);
        expect(l[0].crash.exit_code).toBe(2);
    });

    it('signature ignores time and exit code but not reason or process type', () => {
        expect(crashSignature(crash({ exit_code: 1 }))).toBe(crashSignature(crash({ exit_code: 9, occurred_at: '2026-01-01T00:00:00.000Z' })));
        expect(crashSignature(crash())).not.toBe(crashSignature(crash({ reason: 'oom' })));
        expect(crashSignature(crash())).not.toBe(crashSignature(crash({ kind: 'child_process_gone', process_type: 'GPU' })));
    });

    it(`caps at ${MAX_PENDING_CRASHES}, dropping the oldest`, () => {
        let l: ReturnType<typeof addPendingCrash> = [];
        for (let i = 0; i < 9; i++) l = addPendingCrash(l, crash({ reason: 'crashed', service_name: `svc${i}` }));
        expect(l).toHaveLength(MAX_PENDING_CRASHES);
        expect(l.map(p => p.crash.service_name)).toEqual(['svc4', 'svc5', 'svc6', 'svc7', 'svc8']);
    });

    it('parsePendingCrashes drops malformed entries and unknown kinds', () => {
        const good = addPendingCrash([], crash());
        const raw = JSON.stringify([...good, { crash: { kind: 'evil', occurred_at: '2026-10-07T18:00:00.000Z' } }, { crash: crash({ occurred_at: 'yesterday' }) }, 'x', null]);
        const parsed = parsePendingCrashes(raw);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].crash).toEqual(good[0].crash);
        expect(parsePendingCrashes('not json')).toEqual([]);
        expect(parsePendingCrashes(null)).toEqual([]);
    });

    it('store: records before attach survive, persist as JSON through the adapter, remove/markSeen work', () => {
        let stored: string | null = JSON.stringify(addPendingCrash([], crash({ reason: 'oom' })));
        const storage: PendingStorage = { read: () => stored, write: v => { stored = v; }, clear: () => { stored = null; } };
        const s = new PendingCrashStore();
        s.add(crash({ reason: 'crashed' }));            // before SecureStore is ready
        s.attach(storage);
        expect(s.all().map(p => p.crash.reason)).toEqual(['oom', 'crashed']);
        expect(parsePendingCrashes(stored)).toHaveLength(2);
        s.markSeen();
        expect(s.all().every(p => p.seen)).toBe(true);
        s.remove([s.all()[0].signature]);
        expect(s.all().map(p => p.crash.reason)).toEqual(['crashed']);
        s.remove();
        expect(stored).toBeNull();
    });

    it('a throwing store (locked) degrades to memory only', () => {
        const storage: PendingStorage = { read: () => { throw new Error('locked'); }, write: () => { throw new Error('locked'); }, clear: () => { throw new Error('locked'); } };
        const s = new PendingCrashStore();
        s.attach(storage);
        s.add(crash());
        expect(s.all()).toHaveLength(1);
    });

    it('parseSignatures', () => {
        expect(parseSignatures(undefined)).toBeUndefined();
        expect(parseSignatures('x')).toEqual([]);
        expect(parseSignatures(['a', 1, 'b'])).toEqual(['a', 'b']);
    });
});

describe('unclean-exit marker', () => {
    function memFs(initial: Record<string, string> = {}): MarkerFs & { files: Record<string, string> } {
        const files = { ...initial };
        return {
            files,
            readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
            writeFileSync: (p, d) => { files[p] = d; },
            unlinkSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); delete files[p]; },
        };
    }
    const P = '/ud/diag-session.json';

    it('first launch: no record, marker written with version + start time only', () => {
        const fs = memFs();
        expect(rotateSessionMarker(fs, P, '1.0.17', T0)).toBeNull();
        expect(JSON.parse(fs.files[P])).toEqual({ v: 1, version: '1.0.17', started_at: '2026-10-07T18:00:00.000Z' });
    });

    it('clean quit removes it → next launch has no record', () => {
        const fs = memFs();
        rotateSessionMarker(fs, P, '1.0.17', T0);
        clearSessionMarker(fs, P);
        clearSessionMarker(fs, P); // idempotent
        expect(rotateSessionMarker(fs, P, '1.0.17', T0 + 1000)).toBeNull();
    });

    it('a leftover marker → unclean_exit with the old session start + version', () => {
        const fs = memFs({ [P]: serializeMarker('1.0.16', T0 - 3600_000) });
        const c = rotateSessionMarker(fs, P, '1.0.17', T0)!;
        expect(c.kind).toBe('unclean_exit');
        expect(c.occurred_at).toBe('2026-10-07T17:00:00.000Z');
        expect(c.app_version_at_crash).toBe('1.0.16');
        // and the new session's marker replaced it
        expect(JSON.parse(fs.files[P]).version).toBe('1.0.17');
    });

    it('a garbage marker is still an unclean exit, with no invented version', () => {
        const c = crashFromLeftoverMarker('{{{', T0)!;
        expect(c.kind).toBe('unclean_exit');
        expect(c.app_version_at_crash).toBeUndefined();
        expect(crashFromLeftoverMarker(null, T0)).toBeNull();
    });
});

describe('system info', () => {
    const deps = {
        appVersion: '1.0.17',
        versions: { electron: '43.2.0', chrome: '140.0.7339.133', node: '22.19.0' },
        platform: 'win32', osRelease: '10.0.22631', arch: 'x64',
        cpus: Array.from({ length: 12 }, () => ({ model: 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz' })),
        totalMemBytes: 17_066_000_000,
        gpuInfo: { gpuDevice: [{ vendorId: 0x8086, deviceId: 0x3e92, active: true, driverVendor: 'Intel', driverVersion: '31.0.101.2125' }, { vendorId: 4318, deviceId: 7682, active: false, driverVersion: 'evil version with spaces' }] },
        gpuFeatureStatus: { gpu_compositing: 'enabled', video_encode: 'disabled_software', 'Bad Key': 'x', webgl: 'Has Spaces' },
        displays: [{ id: 1, size: { width: 1280, height: 720 }, scaleFactor: 2, displayFrequency: 143.998 }, { id: 2, size: { width: 1920, height: 1080 }, scaleFactor: 1, displayFrequency: 60 }],
        primaryDisplayId: 1, hardwareAcceleration: true, uptimeS: 5412.4, channel: 'stable' as const,
    };

    it('maps Electron values to the wire shape', () => {
        const s = buildSystemInfo(deps);
        expect(s.gpu.devices[0]).toEqual({ vendor_id: '0x8086', device_id: '0x3e92', active: true, driver_vendor: 'Intel', driver_version: '31.0.101.2125' });
        expect(s.gpu.devices[1]).toEqual({ vendor_id: '0x10de', device_id: '0x1e02', active: false });
        expect(s.gpu.feature_status).toEqual({ gpu_compositing: 'enabled', video_encode: 'disabled_software' });
        expect(s.displays).toEqual([
            { width: 2560, height: 1440, scale_factor: 2, refresh_hz: 144, primary: true },
            { width: 1920, height: 1080, scale_factor: 1, refresh_hz: 60, primary: false },
        ]);
        expect(s.ram_gb).toBe(15.9);
        expect(s.cpu_cores).toBe(12);
        expect(s.uptime_s).toBe(5412);
        expect(s.build_commit).toBe('unknown');
    });

    it('channel', () => {
        expect(reportChannel(false, 'staging', '1.0.17')).toBe('dev');
        expect(reportChannel(true, 'latest', '1.0.17-staging.3')).toBe('stable');
        expect(reportChannel(true, null, '1.0.17-staging.3')).toBe('staging');
        expect(reportChannel(true, null, '1.0.17')).toBe('stable');
    });
});

describe('save to file', () => {
    it('accepts a JSON object string under the cap', () => {
        expect(validateReportFile('screen_share', '{"schema":1}')).toEqual({ ok: true, category: 'screen_share', text: '{"schema":1}' });
    });
    it('rejects everything else', () => {
        expect(validateReportFile('screen_share', 42)).toMatchObject({ ok: false });
        expect(validateReportFile('screen_share', 'nope')).toMatchObject({ ok: false, error: 'not-json' });
        expect(validateReportFile('screen_share', '[1,2]')).toMatchObject({ ok: false, error: 'not-an-object' });
        expect(validateReportFile('../../etc', '{}')).toMatchObject({ ok: false, error: 'bad-category' });
        const big = JSON.stringify({ x: 'a'.repeat(MAX_REPORT_FILE_BYTES) });
        expect(validateReportFile('other', big)).toMatchObject({ ok: false, error: 'too-large' });
        // multi-byte characters count as bytes, not chars
        const wide = JSON.stringify({ x: 'é'.repeat(MAX_REPORT_FILE_BYTES / 2) });
        expect(validateReportFile('other', wide)).toMatchObject({ ok: false, error: 'too-large' });
    });
    it('default file name', () => {
        expect(defaultReportFileName('screen_share', new Date(2026, 9, 7, 12))).toBe('cipherline-diagnostics-screen_share-2026-10-07.json');
        expect(defaultReportFileName('../x', new Date(2026, 0, 2))).toBe('cipherline-diagnostics-other-2026-01-02.json');
    });
});
