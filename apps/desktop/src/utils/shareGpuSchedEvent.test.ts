import { describe, it, expect } from 'vitest';
import { parseShareGpuSchedReport, shareGpuSchedEventDetail, type ShareGpuSchedDetail } from './shareGpuSchedEvent';
import { validateCallEvent, logCallEvent, getCallEvents, clearCallEvents } from './callEventLog';

const GOOD: ShareGpuSchedDetail = {
    phase: 'apply', procs: 2,
    main: { level: 'high', rt: '0xc0000061', status: '0' },
    gpu: { level: 'realtime', rt: '0', status: '0' },
};

describe('parseShareGpuSchedReport', () => {
    it('accepts what main sends and returns it narrowed', () => {
        expect(parseShareGpuSchedReport(GOOD)).toEqual(GOOD);
    });

    it('accepts every shape main can produce: restore, absent process, never-made call, none', () => {
        for (const r of [
            { phase: 'restore', procs: 2, main: { level: 'normal', rt: 'na', status: '0' }, gpu: { level: 'unread', rt: 'na', status: '0' } },
            { phase: 'reapply', procs: 0, main: { level: 'absent', rt: 'na', status: 'na' }, gpu: { level: 'none', rt: 'err5', status: 'err5' } },
        ]) expect(parseShareGpuSchedReport(r)).toEqual(r);
    });

    it('rejects anything malformed, whole - never half-logged', () => {
        const bad: unknown[] = [
            null, undefined, 'x', 3, [],
            { ...GOOD, phase: 'later' },
            { ...GOOD, procs: -1 },
            { ...GOOD, procs: 1.5 },
            { ...GOOD, procs: 'two' },
            { ...GOOD, main: null },
            { ...GOOD, main: { ...GOOD.main, level: 'ultra' } },
            { ...GOOD, gpu: { ...GOOD.gpu, rt: 'C:\\Users\\someone' } },          // a path where a status belongs
            { ...GOOD, gpu: { ...GOOD.gpu, status: '0xZZ' } },
            { ...GOOD, gpu: { ...GOOD.gpu, status: 5 } },
            { phase: 'apply', procs: 1 },
        ];
        for (const b of bad) expect(parseShareGpuSchedReport(b), JSON.stringify(b)).toBeNull();
    });
});

describe('the share_gpu_sched call event', () => {
    it('uses the documented gpu_sched_* fields and fits the log (<= 11 keys, valid against the contract)', () => {
        const detail = shareGpuSchedEventDetail(GOOD);
        expect(detail).toEqual({
            phase: 'apply', procs: 2,
            gpu_sched_main: 'high', gpu_sched_gpu: 'realtime',
            gpu_sched_main_rt: '0xc0000061', gpu_sched_gpu_rt: '0',
            gpu_sched_main_st: '0', gpu_sched_gpu_st: '0',
        });
        expect(Object.keys(detail).length).toBeLessThanOrEqual(11);
        expect(validateCallEvent({ t: Date.now(), kind: 'share_gpu_sched', detail })).toEqual([]);
    });

    it('is recorded by the log with every field intact (not dropped by the allowlist/sanitizer)', () => {
        clearCallEvents();
        logCallEvent('share_gpu_sched', shareGpuSchedEventDetail(GOOD));
        const e = getCallEvents().find(x => x.kind === 'share_gpu_sched');
        expect(e?.detail).toEqual(shareGpuSchedEventDetail(GOOD));
    });

    it('negative control: an unknown kind is not recorded', () => {
        clearCallEvents();
        // @ts-expect-error not a CallEventKind
        logCallEvent('share_gpu_schedx', { phase: 'apply' });
        expect(getCallEvents()).toEqual([]);
    });
});
