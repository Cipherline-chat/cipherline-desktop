import { describe, it, expect, vi, afterEach } from 'vitest';
import { PerSenderRateLimiter, DEFAULT_RATE, LeadingTrailingGate } from './annotationRate';

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

    it('defaults: a fast stroke on a 240 Hz display passes, a flood is capped at burst + refill', () => {
        expect(DEFAULT_RATE.perSecond).toBeGreaterThanOrEqual(240);
        expect(DEFAULT_RATE.burst).toBeGreaterThanOrEqual(DEFAULT_RATE.perSecond);
        // ordinary use, worst case: one packet per frame at 240 Hz, for 10 seconds, plus a control message each second
        const rl = new PerSenderRateLimiter();
        let dropped = 0;
        for (let ms = 0; ms < 10_000; ms += 1000 / 240) if (!rl.allow('bob', ms)) dropped++;
        for (let s = 0; s < 10; s++) if (!rl.allow('bob', s * 1000 + 1)) dropped++;
        expect(dropped).toBe(0);
        // old behaviour for contrast: the previous 60/s, burst 90 DID drop that stroke (the owner's annot_rx_drop)
        const old = new PerSenderRateLimiter({ perSecond: 60, burst: 90 });
        let oldDropped = 0;
        for (let ms = 0; ms < 10_000; ms += 1000 / 240) if (!old.allow('bob', ms)) oldDropped++;
        expect(oldDropped).toBeGreaterThan(1000);
    });

    it('a hostile flood stays bounded: 100k packets in one second admit at most burst + one second of refill', () => {
        const rl = new PerSenderRateLimiter();
        let ok = 0;
        for (let i = 0; i < 100_000; i++) if (rl.allow('mallory', i / 100)) ok++;      // spread over 1 s
        expect(ok).toBeLessThanOrEqual(DEFAULT_RATE.burst + DEFAULT_RATE.perSecond);
        expect(ok).toBeGreaterThanOrEqual(DEFAULT_RATE.burst);
        // and a flood from one sender never costs a quiet one
        expect(rl.allow('alice', 1000)).toBe(true);
    });

    it('flood across 1 s: the burst is spent immediately, not queued for later', () => {
        const rl = new PerSenderRateLimiter();
        for (let i = 0; i < 5000; i++) rl.allow('mallory', 0);
        expect(rl.allow('mallory', 0)).toBe(false);
        expect(rl.allow('mallory', 1)).toBe(false);          // 1 ms later: < 1 token (400/s)
    });
});

describe('LeadingTrailingGate (sender side: ~30 Hz stroke packets)', () => {
    const makeGate = (min = 33) => {
        let now = 0;
        const timers: Array<{ at: number; fn: () => void }> = [];
        vi.useFakeTimers();
        let runs = 0;
        const gate = new LeadingTrailingGate(min, () => { runs++; }, () => now);
        const advance = (ms: number) => { now += ms; vi.advanceTimersByTime(ms); };
        return { gate, advance, runs: () => runs, timers };
    };
    afterEach(() => { vi.useRealTimers(); });

    it('first request runs immediately; a 240 Hz burst inside one interval collapses to one trailing run', () => {
        const { gate, advance, runs } = makeGate();
        gate.request();
        expect(runs()).toBe(1);
        for (let i = 0; i < 7; i++) { advance(4); gate.request(); }     // 28 ms of 240 Hz moves
        expect(runs()).toBe(1);
        advance(10);
        expect(runs()).toBe(2);                                       // exactly one trailing run
    });

    it('240 Hz for one second sends about 30 packets, never 240', () => {
        const { gate, advance, runs } = makeGate();
        for (let i = 0; i < 240; i++) { gate.request(); advance(1000 / 240); }
        advance(40);
        expect(runs()).toBeGreaterThanOrEqual(25);
        expect(runs()).toBeLessThanOrEqual(35);
    });

    it('flush runs a pending trailing run now (teardown loses nothing); cancel drops it', () => {
        const a = makeGate();
        a.gate.request(); a.gate.request();
        expect(a.runs()).toBe(1);
        a.gate.flush();
        expect(a.runs()).toBe(2);
        a.advance(100);
        expect(a.runs()).toBe(2);                                      // no double run
        const b = makeGate();
        b.gate.request(); b.gate.request(); b.gate.cancel(); b.advance(100);
        expect(b.runs()).toBe(1);
    });
});
