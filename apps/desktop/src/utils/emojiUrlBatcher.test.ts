import { describe, it, expect, vi, afterEach } from 'vitest';
import { createUrlBatcher } from './emojiUrlBatcher';

/**
 * The emoji picker rebuilds emoji-mart's whole grid whenever its custom
 * category changes, so how often the URL map is PUBLISHED is the number of
 * picker rebuilds. Before the batcher: one publish per resolved emoji.
 */
afterEach(() => { vi.useRealTimers(); });

describe('createUrlBatcher', () => {
    it('100 emojis resolving 10 ms apart publish a handful of times, not 100', () => {
        vi.useFakeTimers();
        const ids = Array.from({ length: 100 }, (_, i) => `e${i}`);
        const publishes: number[] = [];
        const b = createUrlBatcher(ids, 150, snap => publishes.push(Object.keys(snap).length));
        ids.forEach((id, i) => setTimeout(() => b.resolve(id, `blob:${id}`), i * 10));
        vi.advanceTimersByTime(2_000);
        // ~1 s of trickle at one publish per 150 ms, plus the final one.
        expect(publishes.length).toBeLessThanOrEqual(8);
        expect(publishes[publishes.length - 1]).toBe(100);
    });

    it('publishes immediately once every expected emoji has settled', () => {
        vi.useFakeTimers();
        const publishes: Array<Record<string, string>> = [];
        const b = createUrlBatcher(['a', 'b'], 10_000, snap => publishes.push(snap));
        b.resolve('a', 'blob:a');
        expect(publishes).toHaveLength(0); // waiting for b (timer is 10 s)
        b.fail('b');                        // settled, not resolved
        expect(publishes).toEqual([{ a: 'blob:a' }]);
    });

    it('all-cached: a single synchronous publish', () => {
        const publishes: number[] = [];
        const b = createUrlBatcher(['a', 'b', 'c'], 150, snap => publishes.push(Object.keys(snap).length));
        b.resolve('a', '1'); b.resolve('b', '2'); b.resolve('c', '3');
        expect(publishes).toEqual([3]);
    });

    it('publishes nothing after dispose', () => {
        vi.useFakeTimers();
        const publish = vi.fn();
        const b = createUrlBatcher(['a', 'b'], 50, publish);
        b.resolve('a', '1');
        b.dispose();
        vi.advanceTimersByTime(1_000);
        b.resolve('b', '2');
        expect(publish).not.toHaveBeenCalled();
    });
});
