import { describe, it, expect } from 'vitest';
import { BURST_CLICKS, BURST_COOLDOWN_MS, BURST_WINDOW_MS, createClickBurst } from './clickBurst';

/** Clicks at the given times; returns the index of the click that fired, or -1. */
const run = (b: ReturnType<typeof createClickBurst>, times: number[]) => times.findIndex(t => b.hit(t));

describe('createClickBurst', () => {
    it('fires on the tenth click when all ten land within four seconds', () => {
        expect([BURST_CLICKS, BURST_WINDOW_MS]).toEqual([10, 4000]);
        const b = createClickBurst();
        const times = Array.from({ length: 10 }, (_, i) => i * 300);
        expect(run(b, times)).toBe(9);
    });

    it('fires at exactly four seconds, not a millisecond later', () => {
        expect(run(createClickBurst(), [0, 100, 200, 300, 400, 500, 600, 700, 800, 4000])).toBe(9);
        expect(run(createClickBurst(), [0, 100, 200, 300, 400, 500, 600, 700, 800, 4001])).toBe(-1);
    });

    it('does not fire on nine clicks, or ten spread over too long', () => {
        expect(run(createClickBurst(), Array.from({ length: 9 }, (_, i) => i * 100))).toBe(-1);
        expect(run(createClickBurst(), Array.from({ length: 10 }, (_, i) => i * 700))).toBe(-1);
    });

    it('is a sliding window: a slow start then a fast finish still counts', () => {
        const b = createClickBurst();
        // two stragglers, then a quick run of ten
        const times = [0, 5000, 20000, ...Array.from({ length: 9 }, (_, i) => 20100 + i * 200)];
        expect(run(b, times)).toBe(times.length - 1);
    });

    it('clears after firing, then ignores clicks for the cool-down', () => {
        const b = createClickBurst();
        const first = Array.from({ length: 10 }, (_, i) => i * 100);
        expect(run(b, first)).toBe(9);
        expect(b.pending).toBe(0);
        // an immediate second round of ten, inside the cool-down, does nothing
        const during = Array.from({ length: 10 }, (_, i) => 1000 + i * 100);
        expect(run(b, during)).toBe(-1);
        // after the cool-down a fresh ten fires again
        const after = Array.from({ length: 10 }, (_, i) => 900 + BURST_COOLDOWN_MS + i * 100);
        expect(run(b, after)).toBe(9);
    });

    it('cannot be kept firing by an auto-clicker', () => {
        const b = createClickBurst();
        let fires = 0;
        for (let t = 0; t < 60_000; t += 50) if (b.hit(t)) fires++;
        // 60 s at 20 clicks/s: at most one burst per (cool-down + the ten clicks it needs)
        expect(fires).toBeLessThanOrEqual(Math.ceil(60_000 / BURST_COOLDOWN_MS));
        expect(fires).toBeGreaterThan(0);
    });

    it('survives a clock that steps backwards', () => {
        const b = createClickBurst();
        b.hit(10_000); b.hit(10_100);
        expect(b.hit(5_000)).toBe(false);
        expect(b.pending).toBe(1);
    });

    it('takes a custom count and window', () => {
        const b = createClickBurst(3, 1000, 0);
        expect(run(b, [0, 400, 800])).toBe(2);
        expect(run(createClickBurst(3, 1000, 0), [0, 600, 1200])).toBe(-1);
    });
});
