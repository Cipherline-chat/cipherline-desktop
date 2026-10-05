import { describe, it, expect } from 'vitest';
import { PrioritySemaphore, TokenBucket } from './avatarWarmQueue';

/** A promise plus the handle to settle it — lets a test hold a slot open. */
function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Let every already-scheduled microtask drain. */
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('PrioritySemaphore', () => {
    it('never lets more than `max` holders run at once', async () => {
        const sem = new PrioritySemaphore(2);
        const gates = [deferred(), deferred(), deferred(), deferred()];
        let started = 0;
        let peak = 0;
        let running = 0;

        const runs = gates.map((g, i) => sem.run(false, async () => {
            started++;
            running++;
            peak = Math.max(peak, running);
            await g.promise;
            running--;
            return i;
        }));

        await flush();
        expect(started).toBe(2);          // the other two are queued, not running
        expect(sem.activeCount).toBe(2);
        expect(sem.waitingCount).toBe(2);

        gates[0].resolve();
        await flush();
        expect(started).toBe(3);          // exactly one more admitted per release

        gates[1].resolve(); gates[2].resolve(); gates[3].resolve();
        expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
        expect(peak).toBe(2);
        expect(sem.activeCount).toBe(0);
    });

    it('a foreground waiter is admitted before background waiters that queued first', async () => {
        const sem = new PrioritySemaphore(1);
        const hold = deferred();
        const order: string[] = [];

        const first = sem.run(false, async () => { order.push('holder'); await hold.promise; });
        await flush();

        // Two background waiters queue, THEN a foreground one.
        const bgA = sem.run(true, async () => { order.push('bgA'); });
        const bgB = sem.run(true, async () => { order.push('bgB'); });
        await flush();
        const fg = sem.run(false, async () => { order.push('fg'); });
        await flush();

        hold.resolve();
        await Promise.all([first, bgA, bgB, fg]);

        expect(order).toEqual(['holder', 'fg', 'bgA', 'bgB']);
    });

    it('foreground waiters stay FIFO among themselves', async () => {
        const sem = new PrioritySemaphore(1);
        const hold = deferred();
        const order: string[] = [];

        const first = sem.run(false, async () => { await hold.promise; });
        await flush();
        const a = sem.run(false, async () => { order.push('a'); });
        const b = sem.run(false, async () => { order.push('b'); });
        const c = sem.run(false, async () => { order.push('c'); });
        await flush();

        hold.resolve();
        await Promise.all([first, a, b, c]);
        expect(order).toEqual(['a', 'b', 'c']);
    });

    it('releases the slot when the body throws', async () => {
        const sem = new PrioritySemaphore(1);
        await expect(sem.run(false, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(sem.activeCount).toBe(0);
        // And the semaphore is still usable.
        await expect(sem.run(false, async () => 'ok')).resolves.toBe('ok');
    });

    it('rejects a nonsensical capacity rather than silently serialising everything', () => {
        expect(() => new PrioritySemaphore(0)).toThrow();
    });
});

describe('TokenBucket', () => {
    /** A clock the test moves by hand — no sleeping, no flake. */
    const fixedClock = () => {
        let t = 1_000;
        return { now: () => t, advance: (ms: number) => { t += ms; } };
    };

    it('hands out a full burst immediately, then refuses', () => {
        const clock = fixedClock();
        const bucket = new TokenBucket(3, 100, { now: clock.now });
        expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true]);
        expect(bucket.tryTake()).toBe(false);
    });

    it('refills exactly one token per interval', () => {
        const clock = fixedClock();
        const bucket = new TokenBucket(3, 100, { now: clock.now });
        bucket.tryTake(); bucket.tryTake(); bucket.tryTake();

        clock.advance(99);
        expect(bucket.tryTake()).toBe(false);     // a hair short of one interval
        clock.advance(1);
        expect(bucket.tryTake()).toBe(true);      // exactly one interval
        expect(bucket.tryTake()).toBe(false);     // and only one
        clock.advance(250);
        expect(bucket.available).toBe(2);         // two whole intervals, not 2.5
    });

    it('never accumulates more than `capacity` while idle', () => {
        const clock = fixedClock();
        const bucket = new TokenBucket(3, 100, { now: clock.now });
        clock.advance(100_000);
        expect(bucket.available).toBe(3);
    });

    it('draining a bucket that just saturated does not carry hidden credit', () => {
        // The bug this pins: advancing the refill clock by gained*refillMs
        // while the token count CLAMPS at capacity leaves the clock
        // `elapsed % refillMs` in the past, and the caller collects that
        // remainder as a token they never waited for.
        //
        // The idle stretch below is deliberately NOT a whole multiple of the
        // interval — at 10_000 the two behaviours coincide exactly and the test
        // passes either way, which is how it first shipped.
        const clock = fixedClock();
        const bucket = new TokenBucket(3, 100, { now: clock.now });
        clock.advance(10_050);                    // 100 intervals + 50 ms of remainder
        expect(bucket.tryTake()).toBe(true);
        expect(bucket.tryTake()).toBe(true);
        expect(bucket.tryTake()).toBe(true);
        expect(bucket.tryTake()).toBe(false);     // drained, capacity never exceeded

        clock.advance(60);                        // 60 ms < one interval since the drain
        expect(bucket.tryTake()).toBe(false);     // the stale 50 ms must not top this up
        clock.advance(40);                        // now a full interval has passed
        expect(bucket.tryTake()).toBe(true);
    });

    it('take() waits for the next refill instead of overspending', async () => {
        const clock = fixedClock();
        const sleeps: number[] = [];
        const bucket = new TokenBucket(1, 100, {
            now: clock.now,
            sleep: async (ms) => { sleeps.push(ms); clock.advance(ms); },
        });
        await bucket.take();                      // the burst token
        await bucket.take();                      // must have waited
        expect(sleeps).toEqual([100]);
    });

    it('rejects a nonsensical refill interval rather than becoming unlimited', () => {
        expect(() => new TokenBucket(1, 0)).toThrow();
    });
});
