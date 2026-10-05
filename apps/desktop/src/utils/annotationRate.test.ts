import { describe, it, expect } from 'vitest';
import { PerSenderRateLimiter, DEFAULT_RATE } from './annotationRate';

describe('PerSenderRateLimiter', () => {
    it('allows a burst, then drops until tokens refill', () => {
        const rl = new PerSenderRateLimiter({ perSecond: 10, burst: 5 });
        const t = 1_000_000;
        expect([0, 1, 2, 3, 4].map(() => rl.allow('bob', t))).toEqual([true, true, true, true, true]);
        expect(rl.allow('bob', t)).toBe(false);          // bucket empty
        expect(rl.allow('bob', t + 50)).toBe(false);     // 0.5 token refilled - still < 1
        expect(rl.allow('bob', t + 100)).toBe(true);     // 1 token refilled
        expect(rl.allow('bob', t + 100)).toBe(false);
    });

    it('refill never exceeds the burst capacity', () => {
        const rl = new PerSenderRateLimiter({ perSecond: 10, burst: 3 });
        const t = 0;
        rl.allow('bob', t);
        // a long quiet spell does not bank more than `burst`
        expect([1, 2, 3].map(() => rl.allow('bob', t + 100_000))).toEqual([true, true, true]);
        expect(rl.allow('bob', t + 100_000)).toBe(false);
    });

    it('senders are independent', () => {
        const rl = new PerSenderRateLimiter({ perSecond: 1, burst: 1 });
        expect(rl.allow('bob', 0)).toBe(true);
        expect(rl.allow('bob', 0)).toBe(false);
        expect(rl.allow('carol', 0)).toBe(true);
    });

    it('forget resets a sender', () => {
        const rl = new PerSenderRateLimiter({ perSecond: 1, burst: 1 });
        rl.allow('bob', 0);
        expect(rl.allow('bob', 0)).toBe(false);
        rl.forget('bob');
        expect(rl.allow('bob', 0)).toBe(true);
    });

    it('a clock that goes backwards does not mint tokens', () => {
        const rl = new PerSenderRateLimiter({ perSecond: 10, burst: 1 });
        expect(rl.allow('bob', 1000)).toBe(true);
        expect(rl.allow('bob', 500)).toBe(false);
    });

    it('defaults match the design doc: 60/s sustained with burst headroom', () => {
        expect(DEFAULT_RATE.perSecond).toBe(60);
        expect(DEFAULT_RATE.burst).toBeGreaterThanOrEqual(60);
        const rl = new PerSenderRateLimiter();
        let ok = 0;
        for (let i = 0; i < 200; i++) if (rl.allow('bob', 0)) ok++;
        expect(ok).toBe(DEFAULT_RATE.burst);
    });
});
