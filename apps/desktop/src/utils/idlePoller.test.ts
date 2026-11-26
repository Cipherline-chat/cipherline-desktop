import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createIdlePoller, IDLE_READ_TIMEOUT_MS, IDLE_WATCHDOG_STALL_MS, type IdlePoller } from './idlePoller';
import { computeIsAttentive, nextIdlePollDelayMs } from './attentionState';

let poller: IdlePoller | null = null;
const make = (read: (() => Promise<number> | number) | undefined, extra: Partial<Parameters<typeof createIdlePoller>[0]> = {}) => {
    const onVerdictChange = vi.fn();
    const p = createIdlePoller({
        read,
        isAttentive: () => computeIsAttentive(true, p.idleSeconds(), 300),
        onVerdictChange,
        nextDelayMs: secs => nextIdlePollDelayMs(secs, 300),
        ...extra,
    });
    poller = p;
    return { p, onVerdictChange };
};
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000_000); });
afterEach(() => { poller?.dispose(); poller = null; vi.useRealTimers(); });

describe('idle poller hardening', () => {
    it('a good reading is used, and the loop keeps polling', async () => {
        const read = vi.fn().mockResolvedValue(3);
        const { p } = make(read);
        p.pollNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(p.idleSeconds()).toBe(3);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('a SYNCHRONOUS throw is unknown (not attentive) and the loop still reschedules', async () => {
        let n = 0;
        const read = vi.fn(() => { n++; if (n === 1) return Promise.resolve(2); throw new Error('preload method missing'); });
        const { p, onVerdictChange } = make(read);
        p.pollNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(p.idleSeconds()).toBe(2);
        await vi.advanceTimersByTimeAsync(31_000); // next poll throws synchronously
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(p.idleSeconds()).toBe(Infinity);
        expect(onVerdictChange).toHaveBeenLastCalledWith(false);
        await vi.advanceTimersByTimeAsync(20_000); // and it kept going
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('a REJECTED promise is unknown and the loop continues', async () => {
        let n = 0;
        const read = vi.fn(() => (++n === 1 ? Promise.resolve(1) : Promise.reject(new Error('ipc'))));
        const { p } = make(read);
        p.pollNow();
        await vi.advanceTimersByTimeAsync(31_000);
        expect(p.idleSeconds()).toBe(Infinity);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('a promise that NEVER settles times out to unknown instead of freezing the old value', async () => {
        let n = 0;
        const read = vi.fn(() => (++n === 1 ? Promise.resolve(1) : new Promise<number>(() => {})));
        const { p, onVerdictChange } = make(read);
        p.pollNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(p.idleSeconds()).toBe(1);
        await vi.advanceTimersByTimeAsync(30_000 + IDLE_READ_TIMEOUT_MS + 100);
        expect(p.idleSeconds()).toBe(Infinity);
        expect(onVerdictChange).toHaveBeenLastCalledWith(false);
        await vi.advanceTimersByTimeAsync(40_000);
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(3); // still polling
    });

    it('a stale reading reads as unknown even if nothing else ever runs (no stale low value)', async () => {
        const { p } = make(() => Promise.resolve(0));
        p.pollNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(p.idleSeconds()).toBe(0);
        vi.setSystemTime(Date.now() + 61_000);
        expect(p.idleSeconds()).toBe(Infinity);
        expect(computeIsAttentive(true, p.idleSeconds(), 300)).toBe(false);
    });

    it('a missing API is permanently "unknown" (never attentive), without throwing', async () => {
        const { p } = make(undefined);
        p.pollNow();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(p.idleSeconds()).toBe(Infinity);
    });

    it('the watchdog restarts a loop whose timer was lost', async () => {
        const read = vi.fn().mockResolvedValue(4);
        // nextDelayMs pushes the next poll absurdly far: simulates a loop that is effectively dead
        const { p } = make(read, { nextDelayMs: () => 10 * 60_000 });
        p.pollNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(IDLE_WATCHDOG_STALL_MS + 16_000);
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('invalidate() drops the reading at once (unlock / resume)', async () => {
        const { p } = make(() => Promise.resolve(0));
        p.pollNow();
        await vi.advanceTimersByTimeAsync(0);
        p.invalidate();
        expect(p.idleSeconds()).toBe(Infinity);
    });

    it('a superseded in-flight read cannot overwrite a newer one', async () => {
        const resolvers: Array<(n: number) => void> = [];
        const read = vi.fn(() => new Promise<number>(r => resolvers.push(r)));
        const { p } = make(read);
        p.pollNow(); p.pollNow();
        resolvers[1](50);
        await vi.advanceTimersByTimeAsync(0);
        resolvers[0](0);
        await vi.advanceTimersByTimeAsync(0);
        expect(p.idleSeconds()).toBe(50);
    });
});
