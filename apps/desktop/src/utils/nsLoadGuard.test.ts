import { describe, it, expect } from 'vitest';
import {
    NsLoadGuard, UnderrunWindow, readPlaybackStats,
    NS_LOAD_BAD_UNDERRUN_MS, NS_LOAD_TRIP_BAD, NS_LOAD_WINDOW, type NsEngineRunning,
} from './nsLoadGuard';

/** A fake playbackStats whose counters advance one second per tick by `underrunMs`. */
function clock() {
    const s = { underrunDuration: 0, underrunEvents: 0, totalDuration: 0 };
    return (underrunMs = 0, events = underrunMs > 0 ? 3 : 0) => {
        s.totalDuration += 1;
        s.underrunDuration += underrunMs / 1000;
        s.underrunEvents += events;
        return { ...s };
    };
}

function run(seq: number[], engine: NsEngineRunning = 'strong') {
    const g = new NsLoadGuard();
    const next = clock();
    g.observe(next(), engine); // baseline
    return { g, results: seq.map(ms => g.observe(next(ms), engine)) };
}

describe('NsLoadGuard — when Strong falls back to Light', () => {
    it('the first reading is only a baseline; ticks report per-second deltas', () => {
        const g = new NsLoadGuard();
        const next = clock();
        expect(g.observe(next(), 'strong')).toEqual({ tick: null, trip: false });
        expect(g.observe(next(35, 4), 'strong').tick).toEqual({ underrunMs: 35, underrunEvents: 4, renderedMs: 1000 });
    });

    it(`${NS_LOAD_TRIP_BAD} bad seconds (≥ ${NS_LOAD_BAD_UNDERRUN_MS} ms underrun) within ${NS_LOAD_WINDOW} trip it, once`, () => {
        const { g, results } = run([25, 0, 0, 30, 0, 0, 0, 40, 50, 60]);
        expect(results.map(r => r.trip)).toEqual([false, false, false, false, false, false, false, true, false, false]);
        expect(g.hasTripped).toBe(true);
    });

    it('just under the bad threshold never trips, however long', () => {
        const { results } = run(Array(60).fill(NS_LOAD_BAD_UNDERRUN_MS - 1));
        expect(results.some(r => r.trip)).toBe(false);
    });

    it(`bad seconds further apart than the ${NS_LOAD_WINDOW}-tick window do not add up`, () => {
        const seq: number[] = [];
        for (let i = 0; i < 6; i++) seq.push(100, ...Array(NS_LOAD_WINDOW / 2).fill(0)); // 2 per window at most
        expect(run(seq).results.some(r => r.trip)).toBe(false);
    });

    it('only judges Strong: Light / off never trip (their underruns are not RNNoise\'s)', () => {
        expect(run(Array(20).fill(500), 'light').results.some(r => r.trip)).toBe(false);
        expect(run(Array(20).fill(500), 'off').results.some(r => r.trip)).toBe(false);
    });

    it('reset() (the user picked a mode) re-arms it', () => {
        const { g } = run([100, 100, 100]);
        expect(g.hasTripped).toBe(true);
        g.reset();
        expect(g.hasTripped).toBe(false);
        const next = clock();
        g.observe(next(), 'strong');
        // Armed again: three more bad seconds trip it a second time.
        expect([100, 100, 100].map(ms => g.observe(next(ms), 'strong').trip)).toEqual([false, false, true]);
    });

    it('no playbackStats (older Chromium, a non-AudioContext) → inert', () => {
        const g = new NsLoadGuard();
        expect(g.observe(null, 'strong')).toEqual({ tick: null, trip: false });
        expect(readPlaybackStats({})).toBeNull();
        expect(readPlaybackStats(null)).toBeNull();
        expect(readPlaybackStats({ playbackStats: { underrunDuration: 1, underrunEvents: 2, totalDuration: 3, averageLatency: 0 } }))
            .toEqual({ underrunDuration: 1, underrunEvents: 2, totalDuration: 3 });
        expect(readPlaybackStats({ get playbackStats() { throw new Error('gone'); } })).toBeNull();
    });

    it('a counter that goes backwards (stats reset) reads as 0, not negative', () => {
        const g = new NsLoadGuard();
        g.observe({ underrunDuration: 5, underrunEvents: 50, totalDuration: 100 }, 'strong');
        expect(g.observe({ underrunDuration: 0, underrunEvents: 0, totalDuration: 1 }, 'strong').tick).toEqual({ underrunMs: 0, underrunEvents: 0, renderedMs: 0 });
    });
});

describe('UnderrunWindow — the audio_render telemetry', () => {
    it('reports a 10 s window only when it had underrun, then resets', () => {
        const w = new UnderrunWindow();
        for (let i = 0; i < 9; i++) w.add({ underrunMs: i === 3 ? 12 : 0, underrunEvents: i === 3 ? 2 : 0, renderedMs: 1000 });
        expect(w.take(10)).toBeNull(); // not yet 10 ticks
        w.add({ underrunMs: 0, underrunEvents: 0, renderedMs: 1000 });
        expect(w.take(10)).toEqual({ underrunMs: 12, underrunEvents: 2, windowS: 10 });
        for (let i = 0; i < 10; i++) w.add({ underrunMs: 0, underrunEvents: 0, renderedMs: 1000 });
        expect(w.take(10)).toBeNull(); // a clean window says nothing
    });
});
