import { describe, it, expect, vi } from 'vitest';
import { createMainErrorHandler, isNetworkClassError, networkErrorCode, updaterErrorCode, type MainErrorDeps } from './net-error';
import { crashRecordFor } from './session-lifecycle';
import { mainScrubber } from './diagnostics';
import { classifyUpdateError, onUpdateError, RETRY_DELAYS_MS, type UpdateState } from './updater-state';
import { DETAIL_RE, LABEL_RE } from './freeze-monitor';

/** The report from user 1998a718 (1.0.20), as the Error object Electron produced. */
const reported = () => new Error('net::ERR_HTTP2_PROTOCOL_ERROR');

describe('networkErrorCode / isNetworkClassError', () => {
    it('recognises the reported error and the usual Chromium net failures', () => {
        expect(networkErrorCode(reported())).toBe('ERR_HTTP2_PROTOCOL_ERROR');
        for (const n of ['ERR_CONNECTION_RESET', 'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_CLOSED', 'ERR_QUIC_PROTOCOL_ERROR']) {
            expect(isNetworkClassError(new Error(`net::${n}`)), n).toBe(true);
            expect(networkErrorCode(new Error(`net::${n}`))).toBe(n);
        }
    });

    it("recognises Electron's loadURL() flavour, and a bare string", () => {
        expect(networkErrorCode(new Error("ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:5174/'"))).toBe('ERR_CONNECTION_REFUSED');
        expect(networkErrorCode(new Error("ERR_ABORTED (-3) loading 'http://127.0.0.1:1/'"))).toBe('ERR_ABORTED');
        expect(networkErrorCode('net::ERR_HTTP2_PROTOCOL_ERROR')).toBe('ERR_HTTP2_PROTOCOL_ERROR');
        expect(networkErrorCode({ message: 'net::ERR_TIMED_OUT' })).toBe('ERR_TIMED_OUT');
    });

    it('returns only the static name, never the URL that may follow it', () => {
        const code = networkErrorCode(new Error('net::ERR_CONNECTION_RESET https://updates.cipherline.chat/secret?token=abc'));
        expect(code).toBe('ERR_CONNECTION_RESET');
        expect(code).toMatch(/^[A-Z0-9_]+$/);
    });

    // ── negative controls: these are bugs, and must stay fatal ──
    it('NEGATIVE: a TypeError is never a network error (even one that quotes a net error)', () => {
        expect(isNetworkClassError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
        expect(isNetworkClassError(new TypeError('net::ERR_HTTP2_PROTOCOL_ERROR'))).toBe(false);
        expect(isNetworkClassError(new RangeError('net::ERR_TIMED_OUT'))).toBe(false);
        expect(isNetworkClassError(new ReferenceError('net::ERR_TIMED_OUT'))).toBe(false);
        expect(isNetworkClassError(new SyntaxError('net::ERR_TIMED_OUT'))).toBe(false);
        // cross-realm / re-thrown copies are matched by name too
        expect(isNetworkClassError(Object.assign(new Error('net::ERR_TIMED_OUT'), { name: 'TypeError' }))).toBe(false);
    });

    it('NEGATIVE: ordinary errors, other ERR_ codes and look-alikes are not network errors', () => {
        expect(isNetworkClassError(new Error('boom'))).toBe(false);
        expect(isNetworkClassError(new Error(''))).toBe(false);
        // Node / updater codes start with ERR_ too; the `code` property is deliberately ignored
        expect(isNetworkClassError(Object.assign(new TypeError('The "path" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' }))).toBe(false);
        expect(isNetworkClassError(Object.assign(new Error('manifest rejected'), { code: 'ERR_UPDATER_MANIFEST_SIGNATURE' }))).toBe(false);
        expect(isNetworkClassError(Object.assign(new Error('bad signature'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }))).toBe(false);
        expect(isNetworkClassError(Object.assign(new Error('x'), { code: 'ERR_HTTP2_PROTOCOL_ERROR' }))).toBe(false);
        // mentions one in passing — must START with it
        expect(isNetworkClassError(new Error('failed to parse the reply to net::ERR_TIMED_OUT'))).toBe(false);
        expect(isNetworkClassError(new Error('xnet::ERR_TIMED_OUT'))).toBe(false);
        expect(isNetworkClassError(new Error('net::ERR_'))).toBe(false);
        expect(isNetworkClassError(new Error('net::err_timed_out'))).toBe(false);
        // not an Electron loadURL shape
        expect(isNetworkClassError(new Error('ERR_CONNECTION_REFUSED'))).toBe(false);
    });

    it('NEGATIVE: junk throwables are not network errors (and never throw)', () => {
        for (const v of [undefined, null, 0, 42, true, {}, [], Symbol('s'), { message: 5 }, () => 1]) {
            expect(() => isNetworkClassError(v)).not.toThrow();
            expect(isNetworkClassError(v)).toBe(false);
        }
    });
});

describe('updaterErrorCode (the code= in `updater:check … result=error code=…`)', () => {
    it('a net error has no .code, so it names the net error instead of "none"', () => {
        expect(updaterErrorCode(reported())).toBe('ERR_HTTP2_PROTOCOL_ERROR');
    });
    it('keeps the error’s own code when it has one', () => {
        expect(updaterErrorCode(Object.assign(new Error('x'), { code: 'ERR_UPDATER_MANIFEST_SIGNATURE' }))).toBe('ERR_UPDATER_MANIFEST_SIGNATURE');
    });
    it('NEGATIVE: unknown errors, junk and odd codes read "none"', () => {
        expect(updaterErrorCode(new Error('boom'))).toBe('none');
        expect(updaterErrorCode(null)).toBe('none');
        expect(updaterErrorCode(Object.assign(new Error('x'), { code: 'lower case & spaces' }))).toBe('none');
    });
});

function rig() {
    const record = vi.fn<MainErrorDeps['record']>();
    const event = vi.fn<MainErrorDeps['event']>();
    const log = vi.fn<MainErrorDeps['log']>();
    return { record, event, log, deps: { record, event, log } satisfies MainErrorDeps };
}

describe('the global unhandledRejection / uncaughtException handler', () => {
    it('net::ERR_* is NON-FATAL: logged as a diagnostic event, not recorded as a crash', () => {
        const r = rig();
        createMainErrorHandler('unhandledRejection', r.deps)(reported());
        expect(r.record).not.toHaveBeenCalled();
        expect(r.event).toHaveBeenCalledTimes(1);
        const [name, ms, detail] = r.event.mock.calls[0];
        expect(name).toBe('net:unhandled-rejection');
        expect(detail).toBe('code=ERR_HTTP2_PROTOCOL_ERROR');
        expect(ms).toBe(0);
        // …and it is something freeze-monitor will actually keep
        expect(LABEL_RE.test(name)).toBe(true);
        expect(DETAIL_RE.test(detail)).toBe(true);
        expect(r.log).toHaveBeenCalledWith('warn', expect.stringContaining('ERR_HTTP2_PROTOCOL_ERROR'), expect.anything());
    });

    it('the same for an uncaught exception, under its own event name', () => {
        const r = rig();
        createMainErrorHandler('uncaughtException', r.deps)(reported());
        expect(r.record).not.toHaveBeenCalled();
        expect(r.event).toHaveBeenCalledWith('net:uncaught-exception', 0, 'code=ERR_HTTP2_PROTOCOL_ERROR');
    });

    it('a TypeError is still FATAL: recorded exactly as before, with its origin, and no net event', () => {
        const r = rig();
        const err = new TypeError("Cannot read properties of null (reading 'webContents')");
        createMainErrorHandler('unhandledRejection', r.deps)(err);
        expect(r.record).toHaveBeenCalledWith(err, 'unhandledRejection');
        expect(r.event).not.toHaveBeenCalled();
        expect(r.log).toHaveBeenCalledWith('error', '[Main] unhandledRejection:', err);
    });

    it('NEGATIVE: a plain Error, a string and an updater-coded error are still recorded', () => {
        for (const thrown of [new Error('boom'), 'a string', Object.assign(new Error('rejected'), { code: 'ERR_UPDATER_MANIFEST_SIGNATURE' }), undefined, { weird: true }]) {
            for (const origin of ['unhandledRejection', 'uncaughtException'] as const) {
                const r = rig();
                createMainErrorHandler(origin, r.deps)(thrown);
                expect(r.record, String(thrown)).toHaveBeenCalledWith(thrown, origin);
                expect(r.event).not.toHaveBeenCalled();
            }
        }
    });

    it('a network error does not reach the real crash decision; a TypeError does (end to end with crashRecordFor)', () => {
        const ctx = { now: Date.UTC(2026, 9, 17), appVersion: '1.0.22', scrubber: () => mainScrubber('/home/u', 'u') };
        const pending: unknown[] = [];
        const deps: MainErrorDeps = {
            record: (thrown, origin) => { pending.push(crashRecordFor({ source: 'main-exception', thrown, origin }, false, ctx)); },
            event: () => {}, log: () => {},
        };
        const handle = createMainErrorHandler('unhandledRejection', deps);
        handle(reported());
        expect(pending).toEqual([]);
        handle(new TypeError('real bug'));
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ kind: 'main_exception', reason: 'unhandled-rejection', error_name: 'TypeError', message: 'real bug' });
    });

    it('never throws, even when its own dependencies do (a crash handler must not crash)', () => {
        const boom = () => { throw new Error('dep failed'); };
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(() => createMainErrorHandler('unhandledRejection', { record: boom, event: boom, log: boom })(reported())).not.toThrow();
            expect(() => createMainErrorHandler('unhandledRejection', { record: boom, event: boom, log: boom })(new Error('x'))).not.toThrow();
        } finally { spy.mockRestore(); }
    });
});

describe('what the updater does with that error (existing policy, pinned for this error)', () => {
    it('classifies it transient on every platform and schedules the first backoff retry for an in-flight download', () => {
        for (const platform of ['win32', 'darwin', 'linux'] as const) {
            expect(classifyUpdateError(reported(), platform)).toBe('transient');
        }
        const downloading: UpdateState = { phase: 'downloading', version: '1.0.23', percent: 40 };
        const d = onUpdateError(downloading, { kind: 'transient', failures: 1, platform: 'win32', now: 1_000, buildDownloadUrl: () => null });
        expect(d.retryInMs).toBe(RETRY_DELAYS_MS[0]);
        expect(d.state).toMatchObject({ phase: 'retrying', version: '1.0.23', attempt: 1 });
    });

    it('while idle (a failed background check) it stays idle and quiet — the scheduler retries, no dialog state', () => {
        const d = onUpdateError({ phase: 'idle' }, { kind: 'transient', failures: 1, platform: 'win32', now: 1_000, buildDownloadUrl: () => null });
        expect(d.state).toEqual({ phase: 'idle' });
        expect(d.retryInMs).toBeNull();
    });
});
