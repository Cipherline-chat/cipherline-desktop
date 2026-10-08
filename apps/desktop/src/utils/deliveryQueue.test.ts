import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDeliveryQueue, withRateLimitRetry } from './deliveryQueue';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** A promise you settle by hand. */
function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

afterEach(() => { vi.useRealTimers(); });

describe('createDeliveryQueue', () => {
    it('POSTs strictly in queue order even when a later message finishes preparing first', async () => {
        const q = createDeliveryQueue();
        const posted: string[] = [];
        const p1 = deferred<string>();
        const p2 = deferred<string>();
        q.enqueue('c', { prepare: () => p1.promise, post: async v => { posted.push(v); }, fail: () => {} });
        q.enqueue('c', { prepare: () => p2.promise, post: async v => { posted.push(v); }, fail: () => {} });
        p2.resolve('m2');          // message 2 is ready first
        await tick();
        expect(posted).toEqual([]); // ...but must not overtake message 1
        p1.resolve('m1');
        await q.idle('c');
        expect(posted).toEqual(['m1', 'm2']);
    });

    it("message N+1's prepare overlaps message N's POST (the pipelining)", async () => {
        const q = createDeliveryQueue();
        const events: string[] = [];
        const post1 = deferred();
        q.enqueue('c', { prepare: async () => { events.push('prep1'); return 1; }, post: async () => { events.push('post1:start'); await post1.promise; events.push('post1:end'); }, fail: () => {} });
        q.enqueue('c', { prepare: async () => { events.push('prep2'); return 2; }, post: async () => { events.push('post2'); }, fail: () => {} });
        await tick();
        // prep2 ran while post1 was still in flight; post2 has not started.
        expect(events).toEqual(['prep1', 'prep2', 'post1:start']);
        post1.resolve();
        await q.idle('c');
        expect(events).toEqual(['prep1', 'prep2', 'post1:start', 'post1:end', 'post2']);
    });

    it('a failure is reported on its own message and never blocks the next', async () => {
        const q = createDeliveryQueue();
        const failed: unknown[] = [];
        const posted: number[] = [];
        q.enqueue('c', { prepare: async () => 1, post: async () => { throw new Error('boom'); }, fail: e => failed.push(e) });
        q.enqueue('c', { prepare: async () => { throw new Error('no key'); }, post: async () => { posted.push(2); }, fail: e => failed.push(e) });
        q.enqueue('c', { prepare: async () => 3, post: async v => { posted.push(v); }, fail: e => failed.push(e) });
        await q.idle('c');
        expect((failed as Error[]).map(e => e.message)).toEqual(['boom', 'no key']);
        expect(posted).toEqual([3]);
    });

    it('a fail() that throws does not wedge the queue', async () => {
        const q = createDeliveryQueue();
        const posted: number[] = [];
        q.enqueue('c', { prepare: async () => { throw new Error('x'); }, post: async () => {}, fail: () => { throw new Error('handler bug'); } });
        q.enqueue('c', { prepare: async () => 2, post: async v => { posted.push(v); }, fail: () => {} });
        await q.idle('c');
        expect(posted).toEqual([2]);
    });

    it('a synchronously throwing prepare is a failure, not a crash', async () => {
        const q = createDeliveryQueue();
        const fail = vi.fn();
        q.enqueue('c', { prepare: () => { throw new Error('sync'); }, post: async () => {}, fail });
        await q.idle('c');
        expect(fail).toHaveBeenCalledOnce();
    });

    it('conversations never wait on each other', async () => {
        const q = createDeliveryQueue();
        const stuck = deferred();
        const posted: string[] = [];
        q.enqueue('slow', { prepare: async () => 0, post: () => stuck.promise, fail: () => {} });
        q.enqueue('fast', { prepare: async () => 0, post: async () => { posted.push('fast'); }, fail: () => {} });
        await q.idle('fast');
        expect(posted).toEqual(['fast']);
        stuck.resolve();
    });

    it('idle() resolves only after everything queued so far, and immediately when empty', async () => {
        const q = createDeliveryQueue();
        await q.idle('nothing');
        const gate = deferred();
        let done = false;
        q.enqueue('c', { prepare: async () => 0, post: () => gate.promise, fail: () => {} });
        const idle = q.idle('c').then(() => { done = true; });
        await tick();
        expect(done).toBe(false);
        gate.resolve();
        await idle;
        expect(done).toBe(true);
    });
});

describe('withRateLimitRetry', () => {
    const tooFast = (headers: Record<string, string> = {}) => Object.assign(new Error('429'), { response: { status: 429, headers } });

    it('waits out a 429 and retries, keeping the result', async () => {
        const sleeps: number[] = [];
        const fn = vi.fn().mockRejectedValueOnce(tooFast()).mockResolvedValueOnce('ok');
        await expect(withRateLimitRetry(fn, { sleep: async ms => { sleeps.push(ms); } })).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(sleeps).toEqual([3000]); // the message bucket's fixed 3 s window
    });

    it('uses the per-bucket Retry-After header when it is readable, capped', async () => {
        const sleeps: number[] = [];
        const fn = vi.fn()
            .mockRejectedValueOnce(tooFast({ 'retry-after-message': '2' }))
            .mockRejectedValueOnce(tooFast({ 'retry-after': '60' }))
            .mockResolvedValueOnce('ok');
        await withRateLimitRetry(fn, { sleep: async ms => { sleeps.push(ms); } });
        expect(sleeps).toEqual([2000, 10_000]);
    });

    it('gives up after maxRetries and throws the 429', async () => {
        const fn = vi.fn().mockRejectedValue(tooFast());
        await expect(withRateLimitRetry(fn, { maxRetries: 2, sleep: async () => {} })).rejects.toThrow('429');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('never retries anything that is not a 429', async () => {
        const err = Object.assign(new Error('403'), { response: { status: 403 } });
        const fn = vi.fn().mockRejectedValue(err);
        await expect(withRateLimitRetry(fn, { sleep: async () => {} })).rejects.toBe(err);
        expect(fn).toHaveBeenCalledOnce();
    });
});
