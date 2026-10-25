import { describe, it, expect, vi } from 'vitest';
import { createHandledUpdateCheck } from './update-check';
import { captureUnhandledRejections } from './test-unhandled-capture';
import { UpdateCheckScheduler, UPDATE_SCHEDULE as S } from './update-check-scheduler';
import { updaterErrorCode } from './net-error';

const netErr = () => new Error('net::ERR_HTTP2_PROTOCOL_ERROR');

/** A promise whose `.catch` calls are counted: did anyone attach a rejection handler? */
function spyPromise() {
    const p = Promise.resolve([] as string[]);
    const catchSpy = vi.spyOn(p, 'catch');
    return { p, catchSpy };
}

describe('createHandledUpdateCheck', () => {
    it('a download that rejects with net::ERR_HTTP2_PROTOCOL_ERROR is HANDLED: no unhandledRejection, breadcrumb written', async () => {
        const onDownloadRejected = vi.fn();
        const check = createHandledUpdateCheck({
            blocked: () => null,
            emitError: vi.fn(),
            check: async () => ({ isUpdateAvailable: true, downloadPromise: Promise.reject(netErr()) }),
            onDownloadRejected,
        });
        const unhandled = await captureUnhandledRejections(async () => { await check(); });
        expect(unhandled).toEqual([]);
        expect(onDownloadRejected).toHaveBeenCalledTimes(1);
        expect(onDownloadRejected.mock.calls[0][0]).toMatchObject({ message: 'net::ERR_HTTP2_PROTOCOL_ERROR' });
    });

    it('NEGATIVE CONTROL: the 1.0.20 shape (await the check, drop the downloadPromise) DOES leak the very same rejection', async () => {
        const rawCheck = async () => ({ isUpdateAvailable: true, downloadPromise: Promise.reject(netErr()) as Promise<unknown> });
        const unhandled = await captureUnhandledRejections(async () => { await rawCheck(); });
        expect(unhandled).toHaveLength(1);
        expect((unhandled[0] as Error).message).toBe('net::ERR_HTTP2_PROTOCOL_ERROR');
    });

    it('attaches a handler to the downloadPromise it is given (and none is needed when there is none)', async () => {
        const { p, catchSpy } = spyPromise();
        const check = createHandledUpdateCheck({ blocked: () => null, emitError: vi.fn(), check: async () => ({ downloadPromise: p }), onDownloadRejected: vi.fn() });
        await check();
        expect(catchSpy).toHaveBeenCalledTimes(1);
        // autoDownload off / no update / dev build: nothing to attach to
        for (const r of [{ downloadPromise: null }, {}, null, undefined]) {
            const c = createHandledUpdateCheck({ blocked: () => null, emitError: vi.fn(), check: async () => r as never, onDownloadRejected: vi.fn() });
            await expect(c()).resolves.toBe(r);
        }
    });

    it('a failing breadcrumb handler cannot itself become an unhandled rejection', async () => {
        const check = createHandledUpdateCheck({
            blocked: () => null, emitError: vi.fn(),
            check: async () => ({ downloadPromise: Promise.reject(netErr()) }),
            onDownloadRejected: () => { throw new Error('logging failed'); },
        });
        expect(await captureUnhandledRejections(async () => { await check(); })).toEqual([]);
    });

    it('a check that itself rejects with a net error rejects to the CALLER (the scheduler / retry path), not to nobody', async () => {
        const e = netErr();
        const check = createHandledUpdateCheck({ blocked: () => null, emitError: vi.fn(), check: () => Promise.reject(e), onDownloadRejected: vi.fn() });
        let caught: unknown;
        const unhandled = await captureUnhandledRejections(async () => { await check().catch((x) => { caught = x; }); });
        expect(caught).toBe(e);
        expect(unhandled).toEqual([]);
    });

    it('a blocked check (no manifest verifier where one is required) emits the error and throws it, without checking', async () => {
        const err = new Error('verifier-unavailable');
        const emitError = vi.fn();
        const inner = vi.fn();
        const check = createHandledUpdateCheck({ blocked: () => err, emitError, check: inner, onDownloadRejected: vi.fn() });
        await expect(check()).rejects.toBe(err);
        expect(emitError).toHaveBeenCalledWith(err);
        expect(inner).not.toHaveBeenCalled();
    });
});

describe('the scheduler around a net error (the updater’s retry)', () => {
    async function scenario(firstFails: boolean) {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-17T09:00:00Z'));
        try {
            const logs: string[] = [];
            const records: string[] = [];
            let fail = firstFails;
            const sched = new UpdateCheckScheduler({
                now: () => Date.now(),
                isOnline: () => true,
                canCheck: () => null,
                run: async () => { if (fail) throw netErr(); return 'not-available'; },
                describeError: (e) => `error code=${updaterErrorCode(e)}`,
                log: (l) => logs.push(l),
                record: (r, res) => records.push(`${r}:${res}`),
            });
            const unhandled = await captureUnhandledRejections(async () => {
                sched.start();
                await vi.advanceTimersByTimeAsync(S.STARTUP_DELAY_MS + 1);
            }, 0);
            // the machine wakes two minutes later, network back
            fail = false;
            await vi.advanceTimersByTimeAsync(2 * 60_000);
            sched.noteResume();
            await vi.advanceTimersByTimeAsync(S.RESUME_SETTLE_MS + 1);
            sched.dispose();
            return { unhandled, logs, records };
        } finally { vi.useRealTimers(); }
    }

    it('logs `result=error code=ERR_HTTP2_PROTOCOL_ERROR` (not code=none), does not reject, and retries on wake after the SHORT error gap', async () => {
        const r = await scenario(true);
        expect(r.unhandled).toEqual([]);
        expect(r.logs).toContain('check reason=startup result=error code=ERR_HTTP2_PROTOCOL_ERROR');
        expect(r.records).toContain('startup:error code=ERR_HTTP2_PROTOCOL_ERROR');
        expect(r.records).toContain('resume:not-available'); // 2 min > ERROR_MIN_GAP_MS (1 min)
    });

    it('NEGATIVE CONTROL: after a SUCCESSFUL check the same wake is debounced (10-minute gap) — so the short gap above is the error path’s doing', async () => {
        const r = await scenario(false);
        expect(r.records).toContain('startup:not-available');
        expect(r.records).not.toContain('resume:not-available');
        expect(r.logs).toContain('check reason=resume result=skipped-debounced');
    });

    it('a throwing dependency in a timer-driven check does not become an unhandled rejection', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-17T09:00:00Z'));
        try {
            const sched = new UpdateCheckScheduler({
                now: () => Date.now(), isOnline: () => true,
                canCheck: () => { throw new Error('canCheck exploded'); },
                run: async () => 'x', describeError: () => 'e', log: () => {}, record: () => {},
            });
            const unhandled = await captureUnhandledRejections(async () => {
                sched.start();
                await vi.advanceTimersByTimeAsync(S.STARTUP_DELAY_MS + 1);
            }, 0);
            expect(unhandled).toEqual([]);
            sched.dispose();
        } finally { vi.useRealTimers(); }
    });
});
