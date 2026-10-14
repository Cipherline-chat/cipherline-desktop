import { describe, it, expect, beforeEach } from 'vitest';
import { parseSharePowerReport } from './sharePowerEvent';
import { logCallEvent, getCallEvents, clearCallEvents, CALL_EVENT_KINDS, validateCallEvent } from './callEventLog';

const GOOD = { phase: 'apply', procs: 3, ok: 3, failed: 0, mainErr: 0, gpuErr: 0, rendererErr: 0, mask: 5, timer: true };

describe('parseSharePowerReport', () => {
    it('accepts what main sends', () => {
        expect(parseSharePowerReport(GOOD)).toEqual(GOOD);
        expect(parseSharePowerReport({ ...GOOD, phase: 'restore', mask: 0 })?.phase).toBe('restore');
        expect(parseSharePowerReport({ ...GOOD, gpuErr: -1, rendererErr: 87, mainErr: 0x20000001 })).toMatchObject({ gpuErr: -1, rendererErr: 87, mainErr: 0x20000001 });
    });

    it.each([
        [null], [undefined], ['apply'], [5],
        [{ ...GOOD, phase: 'other' }],
        [{ ...GOOD, procs: -1 }], [{ ...GOOD, procs: 1.5 }], [{ ...GOOD, ok: '3' }],
        [{ ...GOOD, mask: 999 }], [{ ...GOOD, mainErr: -99 }], [{ ...GOOD, timer: 'yes' }],
        [{ phase: 'apply' }],
    ])('rejects %j', (raw) => expect(parseSharePowerReport(raw)).toBeNull());
});

describe('share_power in the call event log', () => {
    beforeEach(() => clearCallEvents());

    // The literal ShareBoostGuard logs (keys must match the privacy scan's allowlist).
    const log = (r: NonNullable<ReturnType<typeof parseSharePowerReport>>) => logCallEvent('share_power', {
        phase: r.phase, procs: r.procs, ok_n: r.ok, fail_n: r.failed,
        main_err: r.mainErr, gpu_err: r.gpuErr, ren_err: r.rendererErr, mask: r.mask, timer: r.timer,
    });

    it('is a published kind, and the event is valid and keeps every field', () => {
        expect(CALL_EVENT_KINDS as readonly string[]).toContain('share_power');
        expect(CALL_EVENT_KINDS as readonly string[]).toContain('share_hint');
        log(parseSharePowerReport(GOOD)!);
        const [ev] = getCallEvents();
        expect(ev.kind).toBe('share_power');
        expect(ev.detail).toEqual({
            phase: 'apply', procs: 3, ok_n: 3, fail_n: 0, main_err: 0, gpu_err: 0, ren_err: 0, mask: 5, timer: true,
        });
        expect(validateCallEvent(ev)).toEqual([]);
    });

    it('a failure result is readable straight from the event (the owner-test fields)', () => {
        log(parseSharePowerReport({ ...GOOD, ok: 1, failed: 2, gpuErr: 5, rendererErr: -2, mask: 1 })!);
        expect(getCallEvents()[0].detail).toMatchObject({ ok_n: 1, fail_n: 2, gpu_err: 5, ren_err: -2, mask: 1 });
    });
});
