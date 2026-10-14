import { describe, it, expect } from 'vitest';
import {
    GpuSchedulingBoost, ShareBoostController, cleanGpuSchedResult, cleanGpuSchedRead, formatGpuSchedStatus,
    GPU_SCHED_NORMAL, GPU_SCHED_HIGH, GPU_SCHED_REALTIME, GPU_SCHED_ERR_UNAVAILABLE,
    type GpuSchedReport, type GpuSchedDeps, type GpuSchedNativeApi,
} from './share-boost';
import { CallPriorityBooster, type PriorityBoosterDeps } from './gaming-video-mode';
import { parseShareGpuSchedReport, shareGpuSchedEventDetail } from '../src/utils/shareGpuSchedEvent';
import { validateCallEvent } from '../src/utils/callEventLog';

/** STATUS_PRIVILEGE_NOT_HELD (0xC0000061) as the signed int32 the addon returns. */
const PRIVILEGE_NOT_HELD = 0xC0000061 | 0;

interface FakeOpts { privileged?: boolean; refuse?: Set<number>; unreadable?: boolean }

/** An addon stand-in: a pid -> class table with REALTIME gated on a privilege, like the kernel. */
function fakeNative(opts: FakeOpts = {}) {
    const levels = new Map<number, number>();
    const calls: Array<['set' | 'get', number, number?]> = [];
    const api: GpuSchedNativeApi = {
        setGpuSchedulingPriority: (pid: number, level: number) => {
            calls.push(['set', pid, level]);
            if (opts.refuse?.has(pid)) return { ok: false, status: 0, error: 5 };
            if (level === GPU_SCHED_REALTIME && !opts.privileged) return { ok: false, status: PRIVILEGE_NOT_HELD, error: 0 };
            levels.set(pid, level);
            return { ok: true, status: 0, error: 0 };
        },
        getGpuSchedulingPriority: (pid: number) => {
            calls.push(['get', pid]);
            if (opts.unreadable || !levels.has(pid)) return { ok: false, status: 0, error: 120, level: -1 };
            return { ok: true, status: 0, error: 0, level: levels.get(pid)! };
        },
    };
    return { api, levels, calls };
}

const SELF = 100;
const PROCS = [
    { pid: 100, type: 'Browser' },
    { pid: 101, type: 'GPU' },
    { pid: 102, type: 'Tab' },
    { pid: 103, type: 'Utility' },
];

function rig(opts: FakeOpts & { platform?: string; native?: GpuSchedNativeApi | null; procs?: Array<{ pid: number; type?: string }> } = {}) {
    const native = fakeNative(opts);
    const reports: GpuSchedReport[] = [];
    const procs = [...(opts.procs ?? PROCS)];
    const deps: GpuSchedDeps = {
        platform: opts.platform ?? 'win32',
        native: () => (opts.native === undefined ? native.api : opts.native),
        listProcesses: () => procs.map(p => ({ ...p })),
        selfPid: SELF,
        report: r => reports.push(r),
    };
    return { boost: new GpuSchedulingBoost(deps), native, reports, procs };
}

describe('GpuSchedulingBoost: apply -> readback -> restore', () => {
    it('privileged: REALTIME for the main and GPU processes (and only those), read back, one report', () => {
        const r = rig({ privileged: true });
        r.boost.setActive(true);
        expect(r.native.levels.get(100)).toBe(GPU_SCHED_REALTIME);
        expect(r.native.levels.get(101)).toBe(GPU_SCHED_REALTIME);
        expect(r.native.levels.has(102)).toBe(false);   // renderers: not capture, not encode
        expect(r.native.levels.has(103)).toBe(false);
        expect(r.boost.heldPids().sort()).toEqual([100, 101]);
        expect(r.reports).toEqual([{
            phase: 'apply', procs: 2,
            main: { level: 'realtime', rt: '0', status: '0' },
            gpu: { level: 'realtime', rt: '0', status: '0' },
        }]);
        // Every set was followed by a read of the same pid (the confirmation is real).
        expect(r.native.calls.filter(c => c[0] === 'get').map(c => c[1]).sort()).toEqual([100, 101]);
    });

    it('unprivileged: REALTIME is refused (STATUS_PRIVILEGE_NOT_HELD) and HIGH is used instead, per process', () => {
        const r = rig({ privileged: false });
        r.boost.setActive(true);
        expect(r.native.levels.get(100)).toBe(GPU_SCHED_HIGH);
        expect(r.native.levels.get(101)).toBe(GPU_SCHED_HIGH);
        // Order per process: REALTIME tried first, then HIGH.
        const mainSets = r.native.calls.filter(c => c[0] === 'set' && c[1] === 100).map(c => c[2]);
        expect(mainSets).toEqual([GPU_SCHED_REALTIME, GPU_SCHED_HIGH]);
        expect(r.reports[0]).toEqual({
            phase: 'apply', procs: 2,
            main: { level: 'high', rt: '0xc0000061', status: '0' },
            gpu: { level: 'high', rt: '0xc0000061', status: '0' },
        });
    });

    it('restore puts NORMAL back on exactly the processes it raised, reads it back, and reports', () => {
        const r = rig({ privileged: true });
        r.boost.setActive(true);
        r.reports.length = 0;
        r.boost.setActive(false);
        expect(r.native.levels.get(100)).toBe(GPU_SCHED_NORMAL);
        expect(r.native.levels.get(101)).toBe(GPU_SCHED_NORMAL);
        expect(r.boost.heldPids()).toEqual([]);
        expect(r.reports).toEqual([{
            phase: 'restore', procs: 2,
            main: { level: 'normal', rt: 'na', status: '0' },
            gpu: { level: 'normal', rt: 'na', status: '0' },
        }]);
    });

    it('restore is once: a second setActive(false) does nothing; so does a repeated setActive(true)', () => {
        const r = rig({ privileged: true });
        r.boost.setActive(true);
        r.boost.setActive(true);
        expect(r.reports).toHaveLength(1);
        r.boost.setActive(false);
        const n = r.native.calls.length;
        r.boost.setActive(false);
        expect(r.native.calls).toHaveLength(n);
        expect(r.reports).toHaveLength(2);
    });

    it('when the setting is off (never active) nothing is set at all', () => {
        const r = rig({ privileged: true });
        r.boost.tick();
        expect(r.native.calls).toEqual([]);
        expect(r.reports).toEqual([]);
    });

    it('every attempt refused: level "none", the statuses say why, nothing is held, and there is nothing to restore', () => {
        const r = rig({ refuse: new Set([100, 101]) });
        r.boost.setActive(true);
        expect(r.boost.heldPids()).toEqual([]);
        expect(r.reports[0].main).toEqual({ level: 'none', rt: 'err5', status: 'err5' });
        r.reports.length = 0;
        r.boost.setActive(false);
        expect(r.reports).toEqual([]);
    });

    it('a read-back that fails reports "unread" but the process is still held and still restored', () => {
        const r = rig({ privileged: true, unreadable: true });
        r.boost.setActive(true);
        expect(r.reports[0].main.level).toBe('unread');
        expect(r.boost.heldPids().sort()).toEqual([100, 101]);
        r.boost.setActive(false);
        expect(r.native.levels.get(100)).toBe(GPU_SCHED_NORMAL);
    });

    it('a process the OS refused is the only one missing: main raised, GPU reports "none"', () => {
        const r = rig({ privileged: true, refuse: new Set([101]) });
        r.boost.setActive(true);
        expect(r.reports[0].main.level).toBe('realtime');
        expect(r.reports[0].gpu.level).toBe('none');
        expect(r.boost.heldPids()).toEqual([100]);
    });
});

describe('GpuSchedulingBoost: pid changes', () => {
    it('a restarted GPU process (new pid) is picked up by tick(); the dead one is forgotten, not restored', () => {
        const r = rig({ privileged: true });
        r.boost.setActive(true);
        r.reports.length = 0;
        r.procs.splice(1, 1, { pid: 201, type: 'GPU' });   // GPU died, a new one started
        r.boost.tick();
        expect(r.native.levels.get(201)).toBe(GPU_SCHED_REALTIME);
        expect(r.boost.heldPids().sort()).toEqual([100, 201]);
        expect(r.reports).toEqual([{
            phase: 'reapply', procs: 1,
            main: { level: 'realtime', rt: '0', status: '0' },
            gpu: { level: 'realtime', rt: '0', status: '0' },
        }]);
        // The main process was NOT set again.
        expect(r.native.calls.filter(c => c[0] === 'set' && c[1] === 100)).toHaveLength(1);
        // Restore touches the live GPU process, never the dead pid.
        r.native.calls.length = 0;
        r.boost.setActive(false);
        expect(r.native.calls.filter(c => c[0] === 'set').map(c => c[1]).sort()).toEqual([100, 201]);
    });

    it('a tick that finds nothing new reports nothing and sets nothing', () => {
        const r = rig({ privileged: true });
        r.boost.setActive(true);
        r.reports.length = 0;
        r.native.calls.length = 0;
        r.boost.tick();
        r.boost.tick();
        expect(r.reports).toEqual([]);
        expect(r.native.calls).toEqual([]);
    });

    it('a process that failed is not retried on every tick', () => {
        const r = rig({ refuse: new Set([101]) });
        r.boost.setActive(true);
        r.native.calls.length = 0;
        r.boost.tick();
        expect(r.native.calls).toEqual([]);
    });

    it('no GPU process listed yet: the gpu slot says "absent"; when it appears it is handled', () => {
        const r = rig({ privileged: true, procs: [{ pid: 100, type: 'Browser' }] });
        r.boost.setActive(true);
        expect(r.reports[0].gpu).toEqual({ level: 'absent', rt: 'na', status: 'na' });
        r.procs.push({ pid: 301, type: 'GPU' });
        r.boost.tick();
        expect(r.reports[1].phase).toBe('reapply');
        expect(r.reports[1].gpu.level).toBe('realtime');
    });

    it('the main process is handled even if the metrics list lost it', () => {
        const r = rig({ privileged: true, procs: [{ pid: 101, type: 'GPU' }] });
        r.boost.setActive(true);
        expect(r.native.levels.get(SELF)).toBe(GPU_SCHED_REALTIME);
    });

    it('a throwing process list degrades to the main process only', () => {
        const native = fakeNative({ privileged: true });
        const b = new GpuSchedulingBoost({
            platform: 'win32', native: () => native.api, selfPid: SELF,
            listProcesses: () => { throw new Error('metrics'); },
        });
        b.setActive(true);
        expect(b.heldPids()).toEqual([SELF]);
    });
});

describe('GpuSchedulingBoost: not Windows, no addon, bad addon', () => {
    it.each(['linux', 'darwin'])('is a complete no-op on %s: no addon call, no report, never active', (platform) => {
        const r = rig({ platform, privileged: true });
        r.boost.setActive(true);
        r.boost.tick();
        r.boost.setActive(false);
        expect(r.native.calls).toEqual([]);
        expect(r.reports).toEqual([]);
        expect(r.boost.active).toBe(false);
    });

    it('an addon without the exports (stale build) reports "none" with na statuses and holds nothing', () => {
        const r = rig({ native: {} });
        r.boost.setActive(true);
        expect(r.reports[0].main).toEqual({ level: 'none', rt: 'na', status: 'na' });
        expect(r.boost.heldPids()).toEqual([]);
        expect(() => r.boost.setActive(false)).not.toThrow();
    });

    it('no addon loaded at all (null) never throws', () => {
        const r = rig({ native: null });
        expect(() => { r.boost.setActive(true); r.boost.tick(); r.boost.setActive(false); }).not.toThrow();
    });

    it('an addon that throws is "unavailable", not a crash', () => {
        const r = rig({ native: { setGpuSchedulingPriority: () => { throw new Error('boom'); } } });
        expect(() => r.boost.setActive(true)).not.toThrow();
        expect(r.reports[0].main.level).toBe('none');
    });
});

describe('what crosses the native boundary is validated', () => {
    it('cleanGpuSchedResult accepts only {ok:boolean,status:int32,error:int32}', () => {
        expect(cleanGpuSchedResult({ ok: true, status: 0, error: 0 })).toEqual({ ok: true, status: 0, error: 0 });
        expect(cleanGpuSchedResult({ ok: false, status: PRIVILEGE_NOT_HELD, error: 0 })).toEqual({ ok: false, status: PRIVILEGE_NOT_HELD, error: 0 });
        for (const bad of [null, undefined, 3, 'x', {}, { ok: 1, status: 0, error: 0 }, { ok: true, status: 'a', error: 0 }, { ok: true, status: 0.5, error: 0 }, { ok: true, status: 2 ** 40, error: 0 }]) {
            expect(cleanGpuSchedResult(bad), JSON.stringify(bad)).toEqual({ ok: false, status: 0, error: GPU_SCHED_ERR_UNAVAILABLE });
        }
    });

    it('cleanGpuSchedRead rejects an out-of-range or missing level even when ok is true', () => {
        expect(cleanGpuSchedRead({ ok: true, status: 0, error: 0, level: 4 }).level).toBe(4);
        for (const level of [-1, 6, 2.5, '4', undefined, null]) {
            const r = cleanGpuSchedRead({ ok: true, status: 0, error: 0, level });
            expect(r.ok, String(level)).toBe(false);
            expect(r.level).toBe(-1);
        }
    });

    it('formatGpuSchedStatus: 0, hex NTSTATUS, errN for a call never made, na', () => {
        expect(formatGpuSchedStatus({ ok: true, status: 0, error: 0 })).toBe('0');
        expect(formatGpuSchedStatus({ ok: false, status: PRIVILEGE_NOT_HELD, error: 0 })).toBe('0xc0000061');
        expect(formatGpuSchedStatus({ ok: false, status: 0, error: 5 })).toBe('err5');
        expect(formatGpuSchedStatus({ ok: false, status: 0, error: GPU_SCHED_ERR_UNAVAILABLE })).toBe('na');
        expect(formatGpuSchedStatus(null)).toBe('na');
    });
});

describe('ShareBoostController drives the GPU class with (setting ON) AND (share live)', () => {
    function ctrl(opts: FakeOpts = { privileged: true }) {
        const native = fakeNative(opts);
        const reports: GpuSchedReport[] = [];
        const gpu = new GpuSchedulingBoost({
            platform: 'win32', native: () => native.api, selfPid: SELF,
            listProcesses: () => PROCS.map(p => ({ ...p })), report: r => reports.push(r),
        });
        const prio = new Map<number, number>(PROCS.map(p => [p.pid, 0]));
        const boosterDeps: PriorityBoosterDeps = {
            platform: 'win32', listPids: () => PROCS.map(p => p.pid), listProcesses: () => PROCS.map(p => ({ ...p })),
            getPriority: pid => prio.get(pid)!, setPriority: (pid, p) => { prio.set(pid, p); },
        };
        const power = { start: () => 1, stop: () => {}, isStarted: () => true };
        const share = new ShareBoostController(new CallPriorityBooster(boosterDeps), power, undefined, gpu);
        return { share, native, reports, gpu };
    }

    it('raised only while enabled AND sharing; restored the moment either goes false', () => {
        const c = ctrl();
        c.share.setSharing(true);
        expect(c.native.levels.size).toBe(0);           // setting off: nothing
        c.share.setEnabled(true);
        expect(c.native.levels.get(100)).toBe(GPU_SCHED_REALTIME);
        c.share.setEnabled(false);                       // setting turned off mid-share
        expect(c.native.levels.get(100)).toBe(GPU_SCHED_NORMAL);
        expect(c.native.levels.get(101)).toBe(GPU_SCHED_NORMAL);
        c.share.setEnabled(true);
        expect(c.native.levels.get(100)).toBe(GPU_SCHED_REALTIME);
        c.share.setSharing(false);                       // share stops / crash / quit all route here
        expect(c.native.levels.get(100)).toBe(GPU_SCHED_NORMAL);
        expect(c.reports.map(r => r.phase)).toEqual(['apply', 'restore', 'apply', 'restore']);
    });

    it('the re-apply timer condition and tick cover the GPU class too', () => {
        const c = ctrl();
        expect(c.share.throttleActive).toBe(false);
        c.share.setEnabled(true);
        c.share.setSharing(true);
        expect(c.share.throttleActive).toBe(true);
        c.native.calls.length = 0;
        c.share.tickThrottle();
        expect(c.native.calls).toEqual([]);   // nothing new -> nothing to do
        c.share.setSharing(false);
        expect(c.share.throttleActive).toBe(false);
    });

    it('negative control: with the setting OFF the same share never touches the GPU class', () => {
        const c = ctrl();
        c.share.setEnabled(false);
        c.share.setSharing(true);
        c.share.tickThrottle();
        expect(c.native.calls).toEqual([]);
        expect(c.reports).toEqual([]);
    });
});

describe('the renderer side reads exactly what this class emits', () => {
    it('end to end: what the main-side class emits parses and logs without loss', () => {
        const reports: GpuSchedReport[] = [];
        const levels = new Map<number, number>();
        const boost = new GpuSchedulingBoost({
            platform: 'win32', selfPid: 1,
            listProcesses: () => [{ pid: 1, type: 'Browser' }, { pid: 2, type: 'GPU' }],
            native: () => ({
                setGpuSchedulingPriority: (pid: number, level: number) =>
                    level === 5 ? { ok: false, status: 0xC0000061 | 0, error: 0 } : (levels.set(pid, level), { ok: true, status: 0, error: 0 }),
                getGpuSchedulingPriority: (pid: number) => ({ ok: true, status: 0, error: 0, level: levels.get(pid) ?? -1 }),
            }),
            report: r => reports.push(r),
        });
        boost.setActive(true);
        boost.setActive(false);
        expect(reports.map(r => r.phase)).toEqual(['apply', 'restore']);
        for (const r of reports) {
            // Through the IPC boundary (structured clone = JSON-shaped) and back.
            const parsed = parseShareGpuSchedReport(JSON.parse(JSON.stringify(r)));
            expect(parsed, JSON.stringify(r)).not.toBeNull();
            expect(validateCallEvent({ t: Date.now(), kind: 'share_gpu_sched', detail: shareGpuSchedEventDetail(parsed!) })).toEqual([]);
        }
        expect(reports[0].main).toEqual({ level: 'high', rt: '0xc0000061', status: '0' });
    });
});
