import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTaskQueue, whenIdle } from './idleTasks';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
};

describe('createTaskQueue (paced reconnect resync)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('never runs more than `concurrency` jobs at once', async () => {
        const q = createTaskQueue({ concurrency: 3 });
        let inFlight = 0, peak = 0;
        const gates = Array.from({ length: 10 }, deferred);
        gates.forEach(g => q.add(async () => {
            inFlight++; peak = Math.max(peak, inFlight);
            await g.promise;
            inFlight--;
        }));
        await vi.advanceTimersByTimeAsync(0);
        expect(q.running).toBe(3);
        expect(q.pending).toBe(7);
        for (const g of gates) { g.resolve(); await vi.advanceTimersByTimeAsync(0); }
        await q.idle();
        expect(peak).toBe(3);
    });

    it('starts lower priority numbers first, FIFO within a priority', async () => {
        const q = createTaskQueue({ concurrency: 1 });
        const order: string[] = [];
        const block = deferred();
        q.add(() => block.promise, 0);           // occupies the only slot
        q.add(() => { order.push('rest-a'); }, 4);
        q.add(() => { order.push('badges'); }, 2);
        q.add(() => { order.push('visible'); }, 0);
        q.add(() => { order.push('rest-b'); }, 4);
        block.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await q.idle();
        expect(order).toEqual(['visible', 'badges', 'rest-a', 'rest-b']);
    });

    it('cancelPending drops everything not yet started (a newer wake supersedes)', async () => {
        const q = createTaskQueue({ concurrency: 1 });
        const ran: number[] = [];
        const block = deferred();
        q.add(async () => { await block.promise; ran.push(0); });
        for (let i = 1; i <= 5; i++) q.add(() => { ran.push(i); });
        q.cancelPending();
        q.add(() => { ran.push(99); });
        block.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await q.idle();
        expect(ran).toEqual([0, 99]);
    });

    it('a throwing job does not wedge the queue', async () => {
        const q = createTaskQueue({ concurrency: 1 });
        const ran: string[] = [];
        q.add(() => { throw new Error('boom'); });
        q.add(async () => { throw new Error('async boom'); });
        q.add(() => { ran.push('after'); });
        await vi.advanceTimersByTimeAsync(0);
        await q.idle();
        expect(ran).toEqual(['after']);
    });

    it('jitter delays each start by at most jitterMs', async () => {
        const q = createTaskQueue({ concurrency: 5, jitterMs: 100, random: () => 0.99 });
        const job = vi.fn();
        q.add(job);
        await vi.advanceTimersByTimeAsync(98);
        expect(job).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(job).toHaveBeenCalledTimes(1);
    });
});

describe('whenIdle', () => {
    it('falls back to a timer when requestIdleCallback is missing, and can be cancelled', async () => {
        vi.useFakeTimers();
        const g = globalThis as { requestIdleCallback?: unknown };
        const saved = g.requestIdleCallback;
        delete g.requestIdleCallback;
        try {
            const a = vi.fn(), b = vi.fn();
            whenIdle(a, 2000);
            const cancel = whenIdle(b, 2000);
            cancel();
            await vi.advanceTimersByTimeAsync(2000);
            expect(a).toHaveBeenCalledTimes(1);
            expect(b).not.toHaveBeenCalled();
        } finally {
            if (saved) g.requestIdleCallback = saved;
            vi.useRealTimers();
        }
    });
});
