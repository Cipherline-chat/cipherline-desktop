import { describe, it, expect } from 'vitest';
import {
    NsOutputRing,
    NsState,
    RNNOISE_FRAME,
    PREBUFFER_SAMPLES,
    CROSSFADE_SAMPLES,
    UNDERRUN_TRIP_COUNT,
    UNDERRUN_WINDOW_QUANTA,
    BYPASS_COOLDOWN_QUANTA,
    STATS_INTERVAL_QUANTA,
    MAX_INLINE_FRAMES_PER_QUANTUM,
    quantaFor,
} from './nsKernel.js';

const QUANTUM = 128;

function makeRaw(length: number, fill = 0.5): Float32Array {
    return new Float32Array(length).fill(fill);
}

function pushFrame(ring: NsOutputRing, value: number, count = RNNOISE_FRAME) {
    for (let i = 0; i < count; i++) ring.push(value);
}

describe('NsOutputRing — priming', () => {
    it('passes raw audio through while below the prebuffer target', () => {
        const ring = new NsOutputRing();
        const raw = makeRaw(QUANTUM, 0.42);
        const out = new Float32Array(QUANTUM);
        const result = ring.process(raw, out, {});
        expect(result.underrun).toBe(false);
        expect(Array.from(out)).toEqual(Array.from(raw));
        expect(ring.state).toBe(NsState.PRIMING);
    });

    it('switches to ACTIVE only once available samples reach PREBUFFER_SAMPLES', () => {
        const ring = new NsOutputRing();
        pushFrame(ring, 1.0, PREBUFFER_SAMPLES - 1);
        const raw = makeRaw(QUANTUM, 0.1);
        let out = new Float32Array(QUANTUM);
        ring.process(raw, out, {});
        expect(ring.state).toBe(NsState.PRIMING); // still one sample short

        ring.push(1.0); // now exactly at the threshold
        out = new Float32Array(QUANTUM);
        ring.process(raw, out, {});
        expect(ring.state).toBe(NsState.ACTIVE);
    });
});

describe('NsOutputRing — crossfade', () => {
    it('blends raw and processed audio over the crossfade window, no hard cut', () => {
        const ring = new NsOutputRing();
        pushFrame(ring, 1.0, PREBUFFER_SAMPLES + RNNOISE_FRAME); // plenty buffered
        const raw = makeRaw(QUANTUM, 0.0); // raw is silence, processed is 1.0
        const out = new Float32Array(QUANTUM);
        ring.process(raw, out, {});

        expect(ring.state).toBe(NsState.ACTIVE);
        // First sample of the crossfade should be close to raw (near 0), the
        // last sample of a full-quantum fade should be close to processed (near 1).
        expect(out[0]).toBeLessThan(out[out.length - 1]);
        expect(out[0]).toBeCloseTo(0, 1);
        // No discontinuity greater than one crossfade step between adjacent samples.
        for (let i = 1; i < out.length; i++) {
            expect(Math.abs(out[i] - out[i - 1])).toBeLessThan(1 / CROSSFADE_SAMPLES + 0.01);
        }
    });

    it('reaches full processed gain once the crossfade window has elapsed', () => {
        const ring = new NsOutputRing();
        pushFrame(ring, 1.0, PREBUFFER_SAMPLES + RNNOISE_FRAME * 4);
        const raw = makeRaw(QUANTUM, 0.0);

        // First quantum triggers the crossfade (128 samples == CROSSFADE_SAMPLES,
        // so it completes within this one call).
        let out = new Float32Array(QUANTUM);
        ring.process(raw, out, {});
        expect(ring.fadeRemaining).toBe(0);

        out = new Float32Array(QUANTUM);
        ring.process(raw, out, {});
        for (const sample of out) expect(sample).toBeCloseTo(1.0, 5);
    });
});

describe('NsOutputRing — underrun without discard', () => {
    it('fills only the deficit with raw audio and keeps the read pointer in place', () => {
        const ring = new NsOutputRing();
        // Prime, then leave exactly half a quantum of processed audio buffered.
        pushFrame(ring, 1.0, PREBUFFER_SAMPLES);
        let out = new Float32Array(QUANTUM);
        ring.process(makeRaw(QUANTUM, 0), out, {}); // consumes prebuffer, triggers ACTIVE

        // Drain the ring down to a partial quantum's worth.
        const remaining = QUANTUM / 2;
        ring.r = ring.w - remaining;

        const raw = makeRaw(QUANTUM, -1.0); // distinct value so we can see the splice
        out = new Float32Array(QUANTUM);
        const before = ring.r;
        const result = ring.process(raw, out, {});

        expect(result.underrun).toBe(true);
        // Only the deficit portion should be raw (-1.0); the rest processed.
        expect(out[out.length - 1]).toBeCloseTo(-1.0, 5);
        // Read pointer must have advanced by exactly what was available, not
        // been reset to w (that's the old discard-everything bug).
        expect(ring.r - before).toBe(remaining);
    });

    it('keeps accepting and correctly returning fresh audio after a string of small underruns', () => {
        const ring = new NsOutputRing();
        pushFrame(ring, 1.0, PREBUFFER_SAMPLES);
        let out = new Float32Array(QUANTUM);
        ring.process(makeRaw(QUANTUM, 0), out, {}); // reach ACTIVE, absorb the crossfade

        // A handful of small underruns — well under UNDERRUN_TRIP_COUNT, so the
        // ring should stay in ACTIVE and keep functioning, not degrade.
        for (let i = 0; i < 5; i++) {
            ring.r = ring.w - 10; // small deficit each time
            out = new Float32Array(QUANTUM);
            const result = ring.process(makeRaw(QUANTUM, 0), out, {});
            expect(result.underrun).toBe(true);
            expect(result.bypassTripped).toBe(false);
        }

        // Push a fresh, generous amount of audio and confirm it reads back
        // exactly — the old bug (`outR = outW` on every underrun) didn't
        // corrupt future reads either, but it did throw away everything
        // buffered; this confirms the ring is still a well-behaved FIFO after
        // repeated partial underruns, not just that it hasn't crashed.
        pushFrame(ring, 0.75, RNNOISE_FRAME * 3);
        out = new Float32Array(QUANTUM);
        const result = ring.process(makeRaw(QUANTUM, 0), out, {});
        expect(result.underrun).toBe(false);
        for (const sample of out) expect(sample).toBeCloseTo(0.75, 5);
    });
});

describe('NsOutputRing — compensation gain applies only to processed samples', () => {
    it('multiplies ring samples by compGain but leaves raw passthrough at unity', () => {
        const ring = new NsOutputRing({ compGain: 2.0 });
        // Get to ACTIVE with the crossfade already elapsed.
        pushFrame(ring, 0.25, PREBUFFER_SAMPLES + RNNOISE_FRAME * 4);
        let out = new Float32Array(QUANTUM);
        ring.process(makeRaw(QUANTUM, 0.25), out, {}); // absorbs the crossfade
        out = new Float32Array(QUANTUM);
        ring.process(makeRaw(QUANTUM, 0.25), out, {});
        for (const sample of out) expect(sample).toBeCloseTo(0.5, 5); // 0.25 * compGain(2.0)

        // Now force an underrun with a distinct raw value — that portion must
        // NOT carry the compGain multiplier.
        ring.r = ring.w - 10;
        const raw = makeRaw(QUANTUM, 0.3);
        out = new Float32Array(QUANTUM);
        ring.process(raw, out, {});
        expect(out[out.length - 1]).toBeCloseTo(0.3, 5); // not 0.6
    });
});

describe('NsOutputRing — bypassed flag', () => {
    it('passes raw straight through and records no underrun', () => {
        const ring = new NsOutputRing();
        const raw = makeRaw(QUANTUM, 0.7);
        const out = new Float32Array(QUANTUM);
        const result = ring.process(raw, out, { bypassed: true });
        expect(Array.from(out)).toEqual(Array.from(raw));
        expect(result.underrun).toBe(false);
        expect(ring.underrunLog.length).toBe(0);
    });
});

describe('NsOutputRing — auto-bypass hysteresis', () => {
    it('trips into BYPASS after enough underruns within the rolling window', () => {
        const ring = new NsOutputRing();
        pushFrame(ring, 1.0, PREBUFFER_SAMPLES);
        let out = new Float32Array(QUANTUM);
        ring.process(makeRaw(QUANTUM, 0), out, {}); // reach ACTIVE

        let tripped = false;
        for (let i = 0; i < UNDERRUN_TRIP_COUNT; i++) {
            // Starve the ring completely before each quantum so every call underruns.
            ring.r = ring.w;
            out = new Float32Array(QUANTUM);
            const result = ring.process(makeRaw(QUANTUM, 0.9), out, {});
            if (result.bypassTripped) tripped = true;
        }
        expect(tripped).toBe(true);
        expect(ring.state).toBe(NsState.BYPASS);
    });

    it('stays in BYPASS (raw passthrough) until the cooldown window elapses', () => {
        const ring = new NsOutputRing();
        // Force straight into BYPASS by driving the trip condition directly.
        ring.state = NsState.BYPASS;
        ring.bypassUntilQuanta = ring.quanta + 5;

        for (let i = 0; i < 4; i++) {
            const out = new Float32Array(QUANTUM);
            const raw = makeRaw(QUANTUM, 0.55);
            const result = ring.process(raw, out, {});
            expect(Array.from(out)).toEqual(Array.from(raw));
            expect(result.bypassRecovered).toBe(false);
        }

        // One more tick crosses bypassUntilQuanta — should recover into PRIMING.
        const out = new Float32Array(QUANTUM);
        const result = ring.process(makeRaw(QUANTUM, 0.55), out, {});
        expect(result.bypassRecovered).toBe(true);
        expect(ring.state).toBe(NsState.PRIMING);
    });

    it('does not trip on underruns spread outside the rolling window', () => {
        const ring = new NsOutputRing();
        ring.state = NsState.ACTIVE; // isolate the hysteresis logic from priming

        for (let round = 0; round < 3; round++) {
            ring.r = ring.w; // fully drained — guarantees this call underruns
            const out = new Float32Array(QUANTUM);
            const result = ring.process(makeRaw(QUANTUM, 0.5), out, {});
            expect(result.underrun).toBe(true);
            expect(result.bypassTripped).toBe(false);

            // Fast-forward the quanta clock well past the rolling window before
            // the next underrun — this is what "spread outside the window"
            // means; jumping the counter directly keeps the test fast and exact
            // instead of physically driving ~1100 process() calls per round.
            ring.quanta += UNDERRUN_WINDOW_QUANTA + 10;
        }
        expect(ring.state).not.toBe(NsState.BYPASS);
    });

    it('backs off to a longer cooldown on a fast repeat trip', () => {
        const ring = new NsOutputRing();
        pushFrame(ring, 1.0, PREBUFFER_SAMPLES);
        let out = new Float32Array(QUANTUM);
        ring.process(makeRaw(QUANTUM, 0), out, {});

        // Trip once.
        for (let i = 0; i < UNDERRUN_TRIP_COUNT; i++) {
            ring.r = ring.w;
            out = new Float32Array(QUANTUM);
            ring.process(makeRaw(QUANTUM, 0.9), out, {});
        }
        expect(ring.state).toBe(NsState.BYPASS);
        const firstCooldown = ring.bypassUntilQuanta - ring.quanta;

        // Fast-forward past cooldown, recover, then immediately re-trip.
        ring.quanta = ring.bypassUntilQuanta;
        out = new Float32Array(QUANTUM);
        ring.process(makeRaw(QUANTUM, 0.9), out, {}); // recovers to PRIMING
        pushFrame(ring, 1.0, PREBUFFER_SAMPLES);
        out = new Float32Array(QUANTUM);
        ring.process(makeRaw(QUANTUM, 0), out, {}); // reach ACTIVE again

        for (let i = 0; i < UNDERRUN_TRIP_COUNT; i++) {
            ring.r = ring.w;
            out = new Float32Array(QUANTUM);
            ring.process(makeRaw(QUANTUM, 0.9), out, {});
        }
        expect(ring.state).toBe(NsState.BYPASS);
        const secondCooldown = ring.bypassUntilQuanta - ring.quanta;
        expect(secondCooldown).toBeGreaterThan(firstCooldown);
        expect(secondCooldown).toBe(BYPASS_COOLDOWN_QUANTA * 6); // BACKOFF / COOLDOWN ratio, see nsKernel.js
    });
});

describe('NsOutputRing — ring wraparound', () => {
    it('reads back exactly what was pushed across multiple buffer wraps', () => {
        const ringSize = RNNOISE_FRAME * 2; // small — 960 samples, wraps every ~7.5 quanta
        const ring = new NsOutputRing({ ringSize });
        ring.state = NsState.ACTIVE; // skip priming/crossfade — this test is about index math

        const totalQuanta = 30; // 30*128 = 3840 samples ≈ 4 full wraps of the 960-sample ring
        for (let q = 0; q < totalQuanta; q++) {
            // Push exactly one quantum's worth ahead of what this call will
            // consume, so the ring never underruns and every read-back is a
            // direct check of the modulo index math surviving multiple wraps.
            for (let i = 0; i < QUANTUM; i++) ring.push(q + i / 1000);
            const raw = makeRaw(QUANTUM, -99); // sentinel — must never surface
            const out = new Float32Array(QUANTUM);
            const result = ring.process(raw, out, {});
            expect(result.underrun).toBe(false);
            for (let i = 0; i < QUANTUM; i++) {
                expect(out[i]).toBeCloseTo(q + i / 1000, 5);
            }
        }
    });
});

describe('quantaFor', () => {
    it('converts milliseconds to render-quantum counts at 48kHz/128-sample quanta', () => {
        expect(quantaFor(1000)).toBeGreaterThan(0);
        // 1000ms / (128/48000*1000) ≈ 375 quanta
        expect(quantaFor(1000)).toBe(375);
    });
});

describe('STATS_INTERVAL_QUANTA', () => {
    it('is a defined, positive, ~1-second quanta count', () => {
        // Regression guard for the bug this constant fixes: rnnoiseWorkletSource.ts
        // referenced STATS_INTERVAL_QUANTA as a bare identifier that was never
        // defined anywhere in the concatenated worklet source, throwing a
        // ReferenceError on every single process() call (i.e. noise suppression
        // was very likely completely broken). This just pins it to a sane value —
        // the worklet-source-level bug itself is untestable via Vitest.
        expect(STATS_INTERVAL_QUANTA).toBe(375);
        expect(MAX_INLINE_FRAMES_PER_QUANTUM).toBeGreaterThan(0);
    });
});

describe('NsOutputRing — no per-quantum allocation on the audio thread', () => {
    it('returns the same result object every call, with its flags reset each time', () => {
        const ring = new NsOutputRing();
        const out = new Float32Array(QUANTUM);
        pushFrame(ring, 0.1, PREBUFFER_SAMPLES);
        ring.process(makeRaw(QUANTUM, 0), out, {}); // reach ACTIVE
        ring.r = ring.w; // drain: the next ACTIVE quantum underruns
        const first = ring.process(makeRaw(QUANTUM, 0), out, {});
        expect(first.underrun).toBe(true);
        // A following bypassed call reports a clean result — from the same object.
        const second = ring.process(makeRaw(QUANTUM, 0), out, { bypassed: true });
        expect(second).toBe(first);
        expect(second).toEqual({ underrun: false, bypassTripped: false, bypassRecovered: false });
        // opts may be omitted entirely.
        expect(ring.process(makeRaw(QUANTUM, 0), out)).toBe(first);
    });
});
