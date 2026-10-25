import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    beginActivity, trackActivity, activityDuring, recordLongTask, fetchFreezeLog, clearFreezeLog,
    formatFreezeReport, LONG_TASK_MS, __resetFreezeLogForTests, setFreezeLogView,
    setFreezeTap, noteIdleBoundary, WAKE_SETTLE_MS,
} from './freezeLog';

describe('freezeLog (renderer half of the freeze diagnostic)', () => {
    beforeEach(() => { __resetFreezeLogForTests(); });
    afterEach(() => { vi.useRealTimers(); });

    it('attributes a long task to the activities that overlapped it', async () => {
        const end = beginActivity('startup:hydrate');
        const t0 = performance.now();
        recordLongTask(t0, LONG_TASK_MS + 50);
        end();
        const rows = await fetchFreezeLog();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ source: 'renderer', ms: LONG_TASK_MS + 50, activity: 'startup:hydrate' });
    });

    it('ignores tasks shorter than the threshold', async () => {
        recordLongTask(performance.now(), LONG_TASK_MS - 1);
        expect(await fetchFreezeLog()).toHaveLength(0);
    });

    it('trackActivity keeps the label open until the promise settles', async () => {
        let release!: () => void;
        const p = trackActivity('dm:pull', () => new Promise<void>(r => { release = r; }));
        const mid = performance.now();
        expect(activityDuring(mid, mid)).toBe('dm:pull');
        release();
        await p;
        await Promise.resolve();
        const after = performance.now() + 1000;
        expect(activityDuring(after, after)).toBe('idle');
    });

    it('adds the current top-level view as context, and rejects a non-static view name', async () => {
        setFreezeLogView('server');
        recordLongTask(performance.now(), 300);
        setFreezeLogView('Alice and Bob');
        recordLongTask(performance.now(), 300);
        const rows = await fetchFreezeLog();
        expect(rows.map(r => r.activity)).toEqual(['idle', 'view:server']);
    });

    it('never stores a data-derived label verbatim', () => {
        const end = beginActivity('conversation with Bob about the party');
        const t = performance.now();
        expect(activityDuring(t, t)).toBe('unlabelled');
        end();
    });

    it('sends rows to main in one batch, a beat after the freeze', async () => {
        vi.useFakeTimers();
        const perfRecord = vi.fn().mockResolvedValue(2);
        (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = { perfRecord };
        try {
            recordLongTask(performance.now(), 300);
            recordLongTask(performance.now(), 400);
            expect(perfRecord).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1000);
            expect(perfRecord).toHaveBeenCalledTimes(1);
            expect(perfRecord.mock.calls[0][0]).toHaveLength(2);
        } finally {
            delete (globalThis as unknown as { window: { electronAPI?: unknown } }).window.electronAPI;
        }
    });

    it('clear empties the local log', async () => {
        recordLongTask(performance.now(), 500);
        await clearFreezeLog();
        expect(await fetchFreezeLog()).toHaveLength(0);
    });

    it('formats a copyable report with times, sources, durations and labels only', () => {
        const report = formatFreezeReport(
            [{ at: Date.UTC(2026, 8, 29, 10, 0, 0), source: 'main', ms: 1234, activity: 'ipc:securekv:open' }],
            { version: '1.0.17', platform: 'Win32', commit: 'abc1234' },
        );
        expect(report).toContain('1.0.17 (abc1234) on Win32');
        expect(report).toContain('2026-09-29T10:00:00.000Z  main        1234 ms  ipc:securekv:open');
        expect(formatFreezeReport([], { version: '1', platform: 'x' })).toContain('No freezes recorded.');
    });

    it('prints window/power events and resource rows alongside stalls, counting only stalls as freezes', () => {
        const report = formatFreezeReport([
            { at: Date.UTC(2026, 9, 3, 10, 0, 2), source: 'event', ms: 840, activity: 'window:first-frame restore to next painted frame' },
            { at: Date.UTC(2026, 9, 3, 10, 0, 1), source: 'metrics', ms: 0, activity: 'restore: browser 1.0% 140MB | total 900MB' },
            { at: Date.UTC(2026, 9, 3, 10, 0, 0), source: 'event', ms: 0, activity: 'window:minimize' },
        ], { version: '1', platform: 'Win32' });
        expect(report).toContain('0 entries. Plus 3 window/power/process event and resource rows.');
        expect(report).toContain('No freezes recorded.');
        expect(report).toContain('event        840 ms  window:first-frame restore to next painted frame');
        expect(report).toMatch(/metrics\s+restore: browser 1\.0% 140MB/);
        expect(report).not.toMatch(/window:minimize.*0 ms|0 ms\s+window:minimize/);
    });

    describe('beta tap: sleep and hidden-window guard', () => {
        afterEach(() => { setFreezeTap(null); });

        it('reports a real freeze once the wake-settle window passes with no idle boundary', () => {
            vi.useFakeTimers();
            const tap = vi.fn();
            setFreezeTap(tap);
            recordLongTask(performance.now(), 2_300);
            expect(tap).not.toHaveBeenCalled();
            vi.advanceTimersByTime(WAKE_SETTLE_MS);
            expect(tap).toHaveBeenCalledWith(2_300, expect.any(String));
        });

        it('drops a freeze when an OS resume / visibility change lands after it started', () => {
            vi.useFakeTimers();
            const tap = vi.fn();
            setFreezeTap(tap);
            const t0 = performance.now();
            recordLongTask(t0, 120_000);
            noteIdleBoundary(t0 + 120_000 + 50); // dispatched after the stalled task ends
            vi.advanceTimersByTime(WAKE_SETTLE_MS);
            expect(tap).not.toHaveBeenCalled();
        });

        it('ignores an idle boundary from before the freeze started', () => {
            vi.useFakeTimers();
            const tap = vi.fn();
            setFreezeTap(tap);
            const t0 = performance.now();
            noteIdleBoundary(t0 - 1);
            recordLongTask(t0, 1_500);
            vi.advanceTimersByTime(WAKE_SETTLE_MS);
            expect(tap).toHaveBeenCalledTimes(1);
        });

        it('never reports an implausible multi-minute "freeze" (16,889 s from the field)', () => {
            vi.useFakeTimers();
            const tap = vi.fn();
            setFreezeTap(tap);
            recordLongTask(performance.now(), 16_889_795);
            vi.advanceTimersByTime(WAKE_SETTLE_MS);
            expect(tap).not.toHaveBeenCalled();
        });

        it('drops a freeze when the window is hidden at decision time, and still logs it locally', async () => {
            vi.useFakeTimers();
            const tap = vi.fn();
            setFreezeTap(tap);
            const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
            recordLongTask(performance.now(), 3_000);
            vi.advanceTimersByTime(WAKE_SETTLE_MS);
            vis.mockRestore();
            expect(tap).not.toHaveBeenCalled();
            vi.useRealTimers();
            expect((await fetchFreezeLog()).some(r => r.ms === 3_000)).toBe(true);
        });
    });
});
