import { describe, it, expect, beforeEach } from 'vitest';
import {
    rollShiny, shinyThisLaunch, __setShinyLaunch, SHINY_ODDS,
    rareIdleDecision, RARE_IDLE_MIN_GAP_MS, RARE_IDLE_QUIET_MS, RARE_IDLE_CHECK_MS, RARE_IDLE_BITS,
    markRareIdle, rareIdleLastAt, __resetRareIdle,
} from './keysRare';

beforeEach(() => { __setShinyLaunch(null); __resetRareIdle(); });

describe('Shiny Keys', () => {
    it('one roll is deterministic for an injected RNG: under 1/500 is shiny, at or over is not', () => {
        expect(rollShiny(() => 0)).toBe(true);
        expect(rollShiny(() => 1 / SHINY_ODDS - 1e-9)).toBe(true);
        expect(rollShiny(() => 1 / SHINY_ODDS)).toBe(false);
        expect(rollShiny(() => 0.5)).toBe(false);
        expect(rollShiny(() => NaN)).toBe(false);
        expect(rollShiny(() => -0.1)).toBe(false);
    });

    it('about one in 500 over many seeded launches', () => {
        let seed = 12345;
        const rng = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
        let hits = 0;
        const N = 500_000;
        for (let i = 0; i < N; i++) if (rollShiny(rng)) hits++;
        expect(hits / N).toBeGreaterThan(0.8 / SHINY_ODDS);
        expect(hits / N).toBeLessThan(1.2 / SHINY_ODDS);
    });

    it('rolled once per launch: later calls (renders, remounts) never re-roll', () => {
        let calls = 0;
        const yes = () => { calls++; return 0; };
        expect(shinyThisLaunch(yes)).toBe(true);
        expect(shinyThisLaunch(() => 0.9)).toBe(true);
        expect(shinyThisLaunch(() => 0.9)).toBe(true);
        expect(calls).toBe(1);
        __setShinyLaunch(null); // a new launch
        expect(shinyThisLaunch(() => 0.9)).toBe(false);
        expect(shinyThisLaunch(() => 0)).toBe(false);
    });
});

describe('rare idle bits', () => {
    const free = (now: number, lastAt = -Infinity, lastClickAt = -Infinity) => ({ now, lastAt, lastClickAt, free: true });
    const always = () => 0;

    it('never while he is not free, nor within the quiet period after a click', () => {
        expect(rareIdleDecision({ ...free(10 * 3600e3), free: false }, always)).toBeNull();
        const now = 10 * 3600e3;
        expect(rareIdleDecision(free(now, -Infinity, now - RARE_IDLE_QUIET_MS + 1), always)).toBeNull();
        expect(rareIdleDecision(free(now, -Infinity, now - RARE_IDLE_QUIET_MS), always)).not.toBeNull();
    });

    it('at most one per hour, even with an RNG that always says yes', () => {
        let last = -Infinity;
        let plays = 0;
        const hours = 10;
        for (let t = 0; t <= hours * 3600e3; t += RARE_IDLE_CHECK_MS) {
            const bit = rareIdleDecision(free(t, last), always);
            if (bit) {
                expect(t - last).toBeGreaterThanOrEqual(RARE_IDLE_MIN_GAP_MS);
                last = t;
                plays++;
            }
        }
        expect(plays).toBeLessThanOrEqual(hours + 1);
        expect(plays).toBeGreaterThanOrEqual(hours);
    });

    it('rarer than that in practice: the roll has to say yes too', () => {
        let seed = 99;
        const rng = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
        let last = -Infinity;
        let plays = 0;
        for (let t = 0; t <= 100 * 3600e3; t += RARE_IDLE_CHECK_MS) {
            if (rareIdleDecision(free(t, last), rng)) { last = t; plays++; }
        }
        expect(plays).toBeGreaterThan(20);
        expect(plays).toBeLessThan(100);
    });

    it('a clock that went backwards plays nothing; both bits are reachable', () => {
        expect(rareIdleDecision(free(1000, 5000), always)).toBeNull();
        const seen = new Set<string>();
        for (const r of [0.01, 0.99]) {
            let k = 0;
            const rng = () => (k++ === 0 ? 0 : r);
            const bit = rareIdleDecision(free(1e9), rng);
            if (bit) seen.add(bit);
        }
        expect([...seen].sort()).toEqual([...RARE_IDLE_BITS].sort());
    });

    it('the launch-wide stamp survives a remount (module state)', () => {
        expect(rareIdleLastAt()).toBe(-Infinity);
        markRareIdle(1234);
        expect(rareIdleLastAt()).toBe(1234);
    });
});
