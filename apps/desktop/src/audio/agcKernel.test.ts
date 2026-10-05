import { describe, it, expect } from 'vitest';
import {
    AgcProcessor,
    dbToLinear,
    linearToDb,
    DEFAULT_RISE_DB_PER_SEC,
    DEFAULT_FALL_DB_PER_SEC,
    DEFAULT_MIN_GAIN_DB,
    DEFAULT_MAX_GAIN_DB,
} from './agcKernel.js';

const QUANTUM = 128;
const SR = 48000;
const QUANTUM_SEC = QUANTUM / SR;

/** Constant-amplitude block — the kernel only ever reads RMS, so a flat
 *  value gives an exact, easy-to-reason-about RMS without needing a real
 *  waveform. */
function tone(length: number, amplitude: number): Float32Array {
    return new Float32Array(length).fill(amplitude);
}

function outputRms(out: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
    return Math.sqrt(sum / out.length);
}

function runFor(agc: AgcProcessor, input: Float32Array, seconds: number): Float32Array {
    const quanta = Math.round(seconds / QUANTUM_SEC);
    let out = new Float32Array(QUANTUM);
    for (let i = 0; i < quanta; i++) {
        out = new Float32Array(QUANTUM);
        agc.process(input, out);
    }
    return out;
}

describe('AgcProcessor — per-quantum slew bound', () => {
    it('never rises faster than the configured dB/s rate in one quantum', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const quiet = tone(QUANTUM, dbToLinear(-45)); // above floor(-50), well below target(-28)
        let prevDb = linearToDb(agc.gain);
        const maxStep = DEFAULT_RISE_DB_PER_SEC * QUANTUM_SEC + 1e-9;
        for (let i = 0; i < 500; i++) {
            const out = new Float32Array(QUANTUM);
            agc.process(quiet, out);
            const nextDb = linearToDb(agc.gain);
            expect(nextDb - prevDb).toBeLessThanOrEqual(maxStep);
            prevDb = nextDb;
        }
    });

    it('never falls faster than the configured (larger) dB/s rate in one quantum', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        // Force a large gap so every quantum is slew-limited on the way down,
        // not naturally settled already.
        agc.gain = dbToLinear(DEFAULT_MAX_GAIN_DB);
        const loud = tone(QUANTUM, dbToLinear(-6)); // well above target — desired gain << current
        let prevDb = linearToDb(agc.gain);
        const maxStep = DEFAULT_FALL_DB_PER_SEC * QUANTUM_SEC + 1e-9;
        for (let i = 0; i < 500; i++) {
            const out = new Float32Array(QUANTUM);
            agc.process(loud, out);
            const nextDb = linearToDb(agc.gain);
            expect(prevDb - nextDb).toBeLessThanOrEqual(maxStep);
            prevDb = nextDb;
        }
    });
});

describe('AgcProcessor — gain clamp', () => {
    it('never exceeds the configured max gain (+12 dB) even for a very quiet, long-sustained input', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        // -49 dBFS: just above the -50 dBFS floor (so it still counts as
        // "speech" and the gain keeps adapting toward it), but quiet enough
        // to drive the gain all the way to its ceiling.
        const input = tone(QUANTUM, dbToLinear(-49));
        runFor(agc, input, 40); // long enough to fully saturate the gain ceiling
        expect(linearToDb(agc.gain)).toBeLessThanOrEqual(DEFAULT_MAX_GAIN_DB + 0.01);
    });

    it('never goes below -18 dB even for a very loud, long-sustained input', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const input = tone(QUANTUM, dbToLinear(0)); // as loud as a float sample can be
        runFor(agc, input, 40);
        expect(linearToDb(agc.gain)).toBeGreaterThanOrEqual(DEFAULT_MIN_GAIN_DB - 0.01);
    });
});

describe('AgcProcessor — silence freezes gain', () => {
    it('does not adapt gain or the level estimate while input is below the floor', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        // Establish a non-trivial gain first so "frozen" is a meaningful check
        // (not just "started at 1.0 and stayed at 1.0").
        runFor(agc, tone(QUANTUM, dbToLinear(-40)), 5);
        const gainBefore = agc.gain;
        const levelBefore = agc.levelEstimate;

        const silence = tone(QUANTUM, dbToLinear(-70)); // well below floor(-50)
        for (let i = 0; i < 1000; i++) {
            const out = new Float32Array(QUANTUM);
            agc.process(silence, out);
        }
        expect(agc.gain).toBe(gainBefore);
        expect(agc.levelEstimate).toBe(levelBefore);
    });

    it('reports voiceActive=false during silence and true during speech', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const silent = new Float32Array(QUANTUM); // all zero
        const speech = tone(QUANTUM, dbToLinear(-30));
        expect(agc.process(silent, new Float32Array(QUANTUM)).voiceActive).toBe(false);
        expect(agc.process(speech, new Float32Array(QUANTUM)).voiceActive).toBe(true);
    });
});

describe('AgcProcessor — convergence', () => {
    it('brings a quiet, sustained voice signal up toward the target level', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const input = tone(QUANTUM, dbToLinear(-40)); // 12 dB below the -28 dBFS target
        const out = runFor(agc, input, 30);
        const outDb = linearToDb(outputRms(out));
        // Generous band — this is a two-pole system (level-estimate smoothing
        // cascaded with slew-limited gain), not a simple first-order settle;
        // the point of this test is "converges toward target", not pinning an
        // exact settle time.
        expect(outDb).toBeGreaterThan(-31);
        expect(outDb).toBeLessThan(-25);
    });

    it('brings a loud, sustained voice signal down toward the target level', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const input = tone(QUANTUM, dbToLinear(-10)); // 18 dB above the -28 dBFS target
        const out = runFor(agc, input, 30);
        const outDb = linearToDb(outputRms(out));
        expect(outDb).toBeGreaterThan(-31);
        expect(outDb).toBeLessThan(-25);
    });

    it('leaves an already-on-target signal close to unity gain', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const input = tone(QUANTUM, dbToLinear(-28)); // already at target
        runFor(agc, input, 20);
        expect(linearToDb(agc.gain)).toBeGreaterThan(-2);
        expect(linearToDb(agc.gain)).toBeLessThan(2);
    });
});

describe('AgcProcessor — limiter', () => {
    it('keeps output at or below the configured ceiling once it settles, even with gain pinned high', () => {
        const agc = new AgcProcessor({ sampleRate: SR, limiterCeiling: dbToLinear(-1) });
        agc.enabled = false; // isolate the limiter from the slow AGC stage
        agc.gain = dbToLinear(DEFAULT_MAX_GAIN_DB); // pin near-max boost (+12 dB)
        const hot = tone(QUANTUM, 0.5); // 0.5 * ~3.98x gain ≈ 1.99 — way over ceiling
        let out = new Float32Array(QUANTUM);
        // Let the limiter's release/attack follower settle over many quanta.
        for (let i = 0; i < 200; i++) {
            out = new Float32Array(QUANTUM);
            agc.process(hot, out);
        }
        for (const sample of out) {
            expect(Math.abs(sample)).toBeLessThanOrEqual(dbToLinear(-1) + 1e-6);
        }
    });

    it('does not engage (stays near unity) for a signal already under the ceiling', () => {
        const agc = new AgcProcessor({ sampleRate: SR, limiterCeiling: dbToLinear(-1) });
        agc.enabled = false;
        agc.gain = 1.0;
        const quiet = tone(QUANTUM, dbToLinear(-20)); // well under -1 dBFS
        let out = new Float32Array(QUANTUM);
        for (let i = 0; i < 50; i++) {
            out = new Float32Array(QUANTUM);
            agc.process(quiet, out);
        }
        expect(agc.limiterGain).toBeCloseTo(1.0, 3);
    });
});

describe('AgcProcessor — enable/disable', () => {
    it('pins gain to unity and stops adapting when disabled', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        runFor(agc, tone(QUANTUM, dbToLinear(-40)), 5);
        expect(agc.gain).not.toBeCloseTo(1.0, 2); // confirm it actually adapted first

        agc.setEnabled(false);
        expect(agc.gain).toBe(1.0);

        const out = new Float32Array(QUANTUM);
        const quiet = tone(QUANTUM, dbToLinear(-40));
        const result = agc.process(quiet, out);
        expect(result.gain).toBe(1.0);
        expect(agc.gain).toBe(1.0);
        // Output should be the (limiter-processed, but at unity gain and well
        // under the ceiling) input essentially unchanged.
        expect(outputRms(out)).toBeCloseTo(dbToLinear(-40), 5);
    });
});

describe('AgcProcessor — numerical safety', () => {
    it('produces no NaN/Infinity for sustained digital silence', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const silence = new Float32Array(QUANTUM); // exact zero
        let out = new Float32Array(QUANTUM);
        // 1000 quanta of processing, but only assert per-sample finiteness on
        // a sampling of quanta — asserting every one of 128,000 individual
        // samples through Vitest's expect() is what was timing out, not the
        // AGC math itself (the loop below runs in well under a second).
        for (let i = 0; i < 1000; i++) {
            out = new Float32Array(QUANTUM);
            agc.process(silence, out);
            if (i % 100 === 0) {
                for (const sample of out) expect(Number.isFinite(sample)).toBe(true);
            }
        }
        for (const sample of out) expect(Number.isFinite(sample)).toBe(true);
        expect(Number.isFinite(agc.gain)).toBe(true);
        expect(Number.isFinite(agc.levelEstimate)).toBe(true);
        expect(Number.isFinite(agc.limiterGain)).toBe(true);
    });

    it('produces no NaN/Infinity for denormal-range (near-zero, non-zero) input', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const denormal = tone(QUANTUM, 1e-40);
        let out = new Float32Array(QUANTUM);
        for (let i = 0; i < 200; i++) {
            out = new Float32Array(QUANTUM);
            agc.process(denormal, out);
            if (i % 50 === 0) {
                for (const sample of out) expect(Number.isFinite(sample)).toBe(true);
            }
        }
        for (const sample of out) expect(Number.isFinite(sample)).toBe(true);
        expect(Number.isFinite(agc.gain)).toBe(true);
    });

    it('handles a null input block without throwing (upstream node with no input connected)', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const out = new Float32Array(QUANTUM);
        expect(() => agc.process(null, out)).not.toThrow();
        for (const sample of out) expect(sample).toBe(0);
    });
});
