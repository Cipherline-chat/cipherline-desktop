import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoalescedWriter } from './coalescedWriter';

/**
 * CoalescedWriter exists to stop message persistence from costing
 * O(entire history) per arriving message. The properties that matter:
 * a burst collapses to ONE write, the value written is the LAST one, and a
 * pending write is never silently dropped — the local cache is the only copy
 * of a delivered message once the server drops the ACKed envelope.
 */
describe('CoalescedWriter', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('collapses a burst into a single write carrying the LAST value', () => {
        const write = vi.fn();
        const w = new CoalescedWriter<number>(write, 100);

        w.schedule('k', 1);
        w.schedule('k', 2);
        w.schedule('k', 3);
        expect(write).not.toHaveBeenCalled();   // nothing written mid-burst

        vi.advanceTimersByTime(100);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('k', 3);
    });

    it('does not serialize or write anything until the burst goes quiet', () => {
        const write = vi.fn();
        const w = new CoalescedWriter<number>(write, 100);
        w.schedule('k', 1);
        vi.advanceTimersByTime(99);
        expect(write).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('each new value restarts the window rather than writing on a fixed cadence', () => {
        const write = vi.fn();
        const w = new CoalescedWriter<number>(write, 100);
        w.schedule('k', 1);
        vi.advanceTimersByTime(80);
        w.schedule('k', 2);          // resets the 100ms window
        vi.advanceTimersByTime(80);  // 160ms total, but only 80 since last
        expect(write).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(write).toHaveBeenCalledWith('k', 2);
    });

    it('flush() writes the pending value immediately — the quit/unmount path', () => {
        const write = vi.fn();
        const w = new CoalescedWriter<number>(write, 100);
        w.schedule('k', 7);
        w.flush();
        expect(write).toHaveBeenCalledWith('k', 7);
        // ...and the timer must not fire a duplicate afterwards.
        vi.advanceTimersByTime(500);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('flush() with nothing pending is a no-op', () => {
        const write = vi.fn();
        const w = new CoalescedWriter<number>(write, 100);
        w.flush();
        expect(write).not.toHaveBeenCalled();
    });

    it('does not re-write the same value twice across flush + timer', () => {
        const write = vi.fn();
        const w = new CoalescedWriter<number>(write, 100);
        w.schedule('k', 1);
        vi.advanceTimersByTime(100);   // timer writes
        w.flush();                     // nothing left pending
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('cancel() drops the pending value without writing it', () => {
        const write = vi.fn();
        const w = new CoalescedWriter<number>(write, 100);
        w.schedule('k', 1);
        w.cancel();
        vi.advanceTimersByTime(500);
        expect(write).not.toHaveBeenCalled();
    });

    it('tracks whether a write is outstanding', () => {
        const w = new CoalescedWriter<number>(() => {}, 100);
        expect(w.hasPending).toBe(false);
        w.schedule('k', 1);
        expect(w.hasPending).toBe(true);
        w.flush();
        expect(w.hasPending).toBe(false);
    });

    it('a later key replaces an earlier pending one (single-slot by design)', () => {
        // The hook only ever drives one logical key per instance; asserting the
        // behaviour so a future multi-key caller doesn't assume queueing.
        const write = vi.fn();
        const w = new CoalescedWriter<number>(write, 100);
        w.schedule('a', 1);
        w.schedule('b', 2);
        vi.advanceTimersByTime(100);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('b', 2);
    });
});
