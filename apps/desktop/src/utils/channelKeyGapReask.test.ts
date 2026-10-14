import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    decideGapReask,
    gapReaskDelayMs,
    GAP_REASK_BASE_MS,
    GAP_REASK_MAX_MS,
    type GapAsk,
} from './channelKeyDistribution';

/**
 * The repair sweep's history-gap re-ask (2026-10-14 new-member report): a
 * joiner kept re-asking, every 75 s, about channels whose missing epoch NO
 * online holder has — and each ask made all six holders re-send everything
 * (~2,000 envelopes in ten minutes). An unchanged gap is now re-asked on a
 * back-off; a gap that grows is asked about at once.
 */

const T0 = 1_800_000_000_000;
const MIN = 60_000;

describe('decideGapReask', () => {
    it('first sight of a gap asks, and remembers it', () => {
        const d = decideGapReask([17], undefined, T0);
        expect(d.ask).toBe(true);
        expect(d.next).toEqual({ epochs: [17], askedAt: T0, count: 1 });
    });

    it('no gap: nothing to ask, and the channel is forgotten', () => {
        const prev: GapAsk = { epochs: [17], askedAt: T0, count: 2 };
        expect(decideGapReask([], prev, T0 + 1)).toEqual({ ask: false, next: undefined });
    });

    it('the SAME gap is not re-asked on the next 75 s sweep — nor until the base delay has passed', () => {
        const prev = decideGapReask([17], undefined, T0).next!;
        for (const dt of [75_000, 150_000, GAP_REASK_BASE_MS - 1]) {
            const d = decideGapReask([17], prev, T0 + dt);
            expect(d.ask).toBe(false);
            expect(d.next).toEqual(prev);                       // the clock is not advanced by a skipped sweep
        }
        expect(decideGapReask([17], prev, T0 + GAP_REASK_BASE_MS).ask).toBe(true);
    });

    it('the back-off doubles per unchanged ask and is capped', () => {
        expect(gapReaskDelayMs(1)).toBe(GAP_REASK_BASE_MS);
        expect(gapReaskDelayMs(2)).toBe(2 * GAP_REASK_BASE_MS);
        expect(gapReaskDelayMs(3)).toBe(4 * GAP_REASK_BASE_MS);
        expect(gapReaskDelayMs(50)).toBe(GAP_REASK_MAX_MS);
        let prev: GapAsk | undefined;
        let now = T0;
        const askTimes: number[] = [];
        // Sweep every 75 s for six hours against a gap that never closes.
        for (; now < T0 + 6 * 60 * MIN; now += 75_000) {
            const d = decideGapReask([8], prev, now);
            prev = d.next;
            if (d.ask) askTimes.push(now);
        }
        const gaps = askTimes.slice(1).map((t, i) => t - askTimes[i]);
        expect(gaps.every((g, i) => i === 0 || g >= gaps[i - 1])).toBe(true);   // never speeds up
        expect(Math.max(...gaps)).toBeLessThanOrEqual(GAP_REASK_MAX_MS + 75_000);
        expect(askTimes.length).toBeLessThanOrEqual(8);                          // vs 288 sweeps
    });

    it('a gap that GROWS (a new epoch we do not hold) is asked about at once, with the clock restarted', () => {
        const prev: GapAsk = { epochs: [17], askedAt: T0, count: 4 };
        const d = decideGapReask([17, 21], prev, T0 + 75_000);
        expect(d.ask).toBe(true);
        expect(d.next).toEqual({ epochs: [17, 21], askedAt: T0 + 75_000, count: 1 });
    });

    it('a gap that SHRINKS (being served) is not re-asked sooner, but restarts the back-off at its base', () => {
        const prev: GapAsk = { epochs: [3, 4, 17], askedAt: T0, count: 4 };
        const d = decideGapReask([17], prev, T0 + 75_000);
        expect(d.ask).toBe(false);
        expect(d.next).toEqual({ epochs: [17], askedAt: T0, count: 1 });
        // …so the remainder is asked about one base delay after the ORIGINAL ask.
        expect(decideGapReask([17], d.next, T0 + GAP_REASK_BASE_MS).ask).toBe(true);
    });

    it('tolerates duplicate / unsorted input', () => {
        const d = decideGapReask([17, 8, 17], undefined, T0);
        expect(d.next!.epochs).toEqual([8, 17]);
        expect(decideGapReask([8, 17], d.next, T0 + 1).ask).toBe(false);
    });
});

describe('the reported storm, replayed (14 channels with one orphan epoch, a sweep every 75 s for 10 min)', () => {
    it('asks each channel about its unchanged gap a handful of times, not on every sweep', () => {
        const channels = Array.from({ length: 14 }, (_, i) => `ch${i}`);
        const state = new Map<string, GapAsk>();
        // The 60 s per-channel dedup the caller keeps, modelled here too.
        const lastFiled = new Map<string, number>();
        let oldAsks = 0;
        let newAsks = 0;
        for (let now = T0; now <= T0 + 10 * MIN; now += 75_000) {
            for (const ch of channels) {
                // OLD: every sweep, subject only to the 60 s dedup.
                if (now - (lastFiled.get(`old${ch}`) ?? 0) >= 60_000) { lastFiled.set(`old${ch}`, now); oldAsks++; }
                // NEW
                const d = decideGapReask([17], state.get(ch), now);
                if (d.next) state.set(ch, d.next); else state.delete(ch);
                if (d.ask && now - (lastFiled.get(`new${ch}`) ?? 0) >= 60_000) { lastFiled.set(`new${ch}`, now); newAsks++; }
            }
        }
        expect(oldAsks).toBeGreaterThanOrEqual(14 * 8);          // what the report shows: ~7 per channel
        expect(newAsks).toBeLessThanOrEqual(14 * 2);             // the first ask + one after the base delay
        expect(newAsks).toBeGreaterThanOrEqual(14);              // the first ask is never suppressed
    });
});

describe('wiring: the repair sweep goes through decideGapReask', () => {
    const src = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
    it('the sweep no longer files on bare `missingEpochs.length`', () => {
        expect(src).not.toMatch(/if \(missingEpochs\.length\) \{\s*const last = keyRequestDedupRef/);
        expect(src).toMatch(/decideGapReask\(missingEpochs, gapAskRef\.current\.get\(c\.channel_id\)/);
    });
    it('the per-channel record is dropped on account change', () => {
        expect(src).toMatch(/keyReaskTargets\.clear\(\); gapAskRef\.current\.clear\(\);/);
    });
});
