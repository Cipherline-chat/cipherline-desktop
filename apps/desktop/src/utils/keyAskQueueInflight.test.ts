import { describe, it, expect } from 'vitest';
import { KeyAskQueue, KeyAskLimiter, KEY_ASK_MAX_IN_FLIGHT, type QueuedAsk, type KeyAskOutcome } from './channelKeyPrefetch';

/**
 * 2026-10-20, harness (ten joiners at once): with the API answering a key
 * request in ~0.8 s, a joiner sending its asks one at a time needed 16 s just
 * to FILE asks for 20 channels — the last channel's keys could not even be
 * asked for before then. Up to KEY_ASK_MAX_IN_FLIGHT now go at once.
 */
describe('KeyAskQueue — bounded concurrency', () => {
    it('keeps up to KEY_ASK_MAX_IN_FLIGHT sends in flight, never more, and drains everything', async () => {
        let inFlight = 0;
        let peak = 0;
        const done: string[] = [];
        const releases: (() => void)[] = [];
        const q = new KeyAskQueue({
            limiter: { waitMs: () => 0, record: () => {}, isBlocked: () => false } as unknown as KeyAskLimiter,
            send: async (a: QueuedAsk): Promise<KeyAskOutcome> => {
                inFlight++; peak = Math.max(peak, inFlight);
                await new Promise<void>(r => releases.push(r));
                inFlight--; done.push(a.channelId);
                return 'sent';
            },
            now: () => 0,
            sleep: async () => {},
        });
        for (let i = 0; i < 10; i++) q.enqueue({ serverId: 's', channelId: `c${i}`, priority: 'keyless' });
        // let the worker start everything it may
        for (let k = 0; k < 500; k++) await Promise.resolve();
        expect(inFlight).toBe(KEY_ASK_MAX_IN_FLIGHT);
        // release them as they come
        while (done.length < 10) {
            releases.shift()?.();
            for (let k = 0; k < 500; k++) await Promise.resolve();
        }
        await q.whenIdle();
        expect(peak).toBe(KEY_ASK_MAX_IN_FLIGHT);
        expect(done.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `c${i}`).sort());
    });

    it('a throttled send still goes back in the queue (and is retried)', async () => {
        let n = 0;
        const sent: string[] = [];
        const q = new KeyAskQueue({
            limiter: { waitMs: () => 0, record: () => {}, isBlocked: () => false } as unknown as KeyAskLimiter,
            send: async (a: QueuedAsk): Promise<KeyAskOutcome> => { sent.push(a.channelId); return n++ === 0 ? 'throttled' : 'sent'; },
            now: () => 0,
            sleep: async () => {},
        });
        q.enqueue({ serverId: 's', channelId: 'c', priority: 'keyless' });
        await q.whenIdle();
        expect(sent).toEqual(['c', 'c']);
    });
});
