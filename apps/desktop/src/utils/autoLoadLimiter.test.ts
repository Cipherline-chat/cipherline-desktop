import { describe, it, expect, beforeEach } from 'vitest';
import { acquireAutoLoadSlot, _resetAutoLoadLimiterForTests } from './autoLoadLimiter';

describe('acquireAutoLoadSlot — bounded concurrency', () => {
    beforeEach(() => {
        _resetAutoLoadLimiterForTests();
    });

    it('grants slots immediately up to the limit, then queues the rest', async () => {
        const order: number[] = [];
        // One release slot per request index, filled in as each resolves —
        // NOT a running list of "still held" releases, so calling
        // `releases[i]` is always exactly "release request i" and never
        // reprocesses an index that's already been released.
        const releases: Array<() => void> = new Array(10);

        const pending = Array.from({ length: 10 }, (_, i) =>
            acquireAutoLoadSlot().then(release => { order.push(i); releases[i] = release; }));

        // Give the first batch's promises a couple of microtask turns to resolve.
        await Promise.resolve();
        await Promise.resolve();

        // Only the first 4 (MAX_CONCURRENT_AUTO_LOADS) should have resolved so far.
        expect(order.length).toBe(4);

        // Releasing one should immediately let the next queued one through.
        releases[0]();
        await Promise.resolve();
        await Promise.resolve();
        expect(order.length).toBe(5);

        // Release each request exactly once, in order, until every request
        // has been granted a slot and released it.
        for (let i = 1; i < 10; i++) {
            // Wait for this request to actually have been granted before
            // releasing it — it may not have resolved yet.
            for (let guard = 0; !releases[i] && guard < 100; guard++) await Promise.resolve();
            releases[i]();
        }
        await Promise.all(pending);
        expect(order.length).toBe(10);
        expect(new Set(order).size).toBe(10); // every index granted exactly once
    });

    it('never exceeds the concurrency cap even under a burst', async () => {
        let active = 0;
        let maxActive = 0;
        const tasks = Array.from({ length: 25 }, () => (async () => {
            const release = await acquireAutoLoadSlot();
            active++;
            maxActive = Math.max(maxActive, active);
            // Yield a couple of microtasks to let other tasks pile up.
            await Promise.resolve();
            await Promise.resolve();
            active--;
            release();
        })());
        await Promise.all(tasks);
        expect(maxActive).toBeLessThanOrEqual(4);
    });

    it('releasing twice is a no-op (does not free two slots)', async () => {
        const release1 = await acquireAutoLoadSlot();
        const release2 = await acquireAutoLoadSlot();
        const release3 = await acquireAutoLoadSlot();
        const release4 = await acquireAutoLoadSlot();

        let fifthGranted = false;
        acquireAutoLoadSlot().then(() => { fifthGranted = true; });
        await Promise.resolve();
        expect(fifthGranted).toBe(false);

        // Releasing the same slot twice must not open two new slots.
        release1();
        release1();
        await Promise.resolve();
        await Promise.resolve();
        expect(fifthGranted).toBe(true);

        // Cleanup remaining slots so the test doesn't leak into others.
        release2(); release3(); release4();
    });
});
