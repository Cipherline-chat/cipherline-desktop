import { describe, it, expect } from 'vitest';
import {
    AgcProcessor,
    dbToLinear,
    linearToDb,
    DEFAULT_TARGET_DB,
    DEFAULT_RISE_DB_PER_SEC,
    DEFAULT_FALL_DB_PER_SEC,
    DEFAULT_MIN_GAIN_DB,
    DEFAULT_MAX_GAIN_DB,
    DEFAULT_OUTPUT_NOISE_LIMIT_DB,
    DEFAULT_COMP_THRESHOLD_DB,
    DEFAULT_COMP_RATIO,
} from './agcKernel.js';

const QUANTUM = 128;
const SR = 48000;
const QUANTUM_SEC = QUANTUM / SR;

/** Constant-amplitude block — the kernel only ever reads RMS (and abs peak), so
 *  a flat value gives an exact, easy-to-reason-about level without needing a
 *  real waveform. */
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

/** Deterministic white noise at a given RMS (dBFS). */
function noiseBlock(seedRef: { s: number }, dbfs: number): Float32Array {
    const amp = dbToLinear(dbfs) * Math.sqrt(3); // uniform [-1,1] has rms 1/sqrt(3)
    const b = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i++) {
        seedRef.s = (Math.imul(seedRef.s, 1664525) + 1013904223) >>> 0;
        b[i] = ((seedRef.s / 4294967296) * 2 - 1) * amp;
    }
    return b;
}

/**
 * An AGC that has heard a moment of silence first, like every real call: the
 * gate (or just a pause) has shown the noise-floor tracker where the floor is.
 * A flat synthetic tone with no quiet block ahead of it IS its own floor and is
 * (correctly) not treated as speech until a quieter block shows up.
 */
function primed(extra: Record<string, unknown> = {}) {
    const agc = new AgcProcessor({ sampleRate: SR, ...extra });
    runFor(agc, new Float32Array(QUANTUM), 0.3);
    return agc;
}

/** An AGC that has heard nothing yet (floor tracker at its start value). */
function fresh(extra: Record<string, unknown> = {}) {
    return new AgcProcessor({ sampleRate: SR, ...extra });
}

/** AGC with the evidence/bootstrap shaping removed, so slew bounds are exact. */
function plainAgc(extra: Record<string, unknown> = {}) {
    return primed({ bootstrapSec: 0, minEvidenceSec: 0, compressor: false, ...extra });
}

describe('AgcProcessor — per-quantum slew bound', () => {
    it('never rises faster than the configured dB/s rate in one quantum', () => {
        const agc = plainAgc();
        const quiet = tone(QUANTUM, dbToLinear(-45)); // above floor(-50), well below target
        let prevDb = linearToDb(agc.gain);
        const maxStep = DEFAULT_RISE_DB_PER_SEC * QUANTUM_SEC + 1e-9;
        let rose = 0;
        for (let i = 0; i < 500; i++) {
            const out = new Float32Array(QUANTUM);
            agc.process(quiet, out);
            const nextDb = linearToDb(agc.gain);
            expect(nextDb - prevDb).toBeLessThanOrEqual(maxStep);
            if (nextDb > prevDb) rose++;
            prevDb = nextDb;
        }
        expect(rose).toBeGreaterThan(400); // control: it really was rising
    });

    it('never falls faster than the configured dB/s rate when only the slow stage is binding', () => {
        // Burst guard out of the picture (huge margin) so the slow fall rate is the only limit.
        const agc = plainAgc({ burstMarginDb: 200 });
        agc.gain = dbToLinear(DEFAULT_MAX_GAIN_DB);
        const loud = tone(QUANTUM, dbToLinear(-6));
        let prevDb = linearToDb(agc.gain);
        const maxStep = DEFAULT_FALL_DB_PER_SEC * QUANTUM_SEC + 1e-9;
        let fell = 0;
        for (let i = 0; i < 500; i++) {
            const out = new Float32Array(QUANTUM);
            agc.process(loud, out);
            const nextDb = linearToDb(agc.gain);
            expect(prevDb - nextDb).toBeLessThanOrEqual(maxStep);
            if (nextDb < prevDb) fell++;
            prevDb = nextDb;
        }
        expect(fell).toBeGreaterThan(400);
    });
});

describe('AgcProcessor — gain clamp and noise cap', () => {
    it('never exceeds the configured max gain for a very quiet, long-sustained input', () => {
        const agc = plainAgc();
        runFor(agc, tone(QUANTUM, dbToLinear(-49)), 60);
        expect(linearToDb(agc.gain)).toBeLessThanOrEqual(DEFAULT_MAX_GAIN_DB + 0.01);
        expect(linearToDb(agc.gain)).toBeGreaterThan(5); // control: it did boost
    });

    it('caps the boost so the tracked noise floor never comes out above the output-noise limit', () => {
        // Speech-like blocks at -34 dBFS over a steady -62 dBFS floor. Unlimited, the
        // AGC would want +15 dB; the floor (-62) + gain must stay <= the limit (-48 => +14).
        const agc = fresh({ outputNoiseLimitDb: -58, compressor: false, bootstrapSec: 0, minEvidenceSec: 0 });
        const seed = { s: 7 };
        for (let i = 0; i < 6000; i++) {
            const speech = (Math.floor(i / 100) % 2) === 0; // 100-block (0.27 s) bursts
            agc.process(noiseBlock(seed, speech ? -34 : -62), new Float32Array(QUANTUM));
        }
        const gainDb = linearToDb(agc.gain);
        const capDb = -58 - agc.noiseFloorDb;
        expect(agc.noiseFloorDb).toBeLessThan(-55);
        expect(gainDb).toBeLessThanOrEqual(Math.max(0, capDb) + 0.05);
        // control: without the limit the same input is boosted well past that cap
        const free = fresh({ outputNoiseLimitDb: 0, compressor: false, bootstrapSec: 0, minEvidenceSec: 0 });
        const seed2 = { s: 7 };
        for (let i = 0; i < 6000; i++) {
            const speech = (Math.floor(i / 100) % 2) === 0;
            free.process(noiseBlock(seed2, speech ? -34 : -62), new Float32Array(QUANTUM));
        }
        expect(linearToDb(free.gain)).toBeGreaterThan(gainDb + 3);
    });

    it('never goes below the min gain even for a very loud, long-sustained input', () => {
        const agc = plainAgc();
        runFor(agc, tone(QUANTUM, dbToLinear(0)), 40);
        expect(linearToDb(agc.gain)).toBeGreaterThanOrEqual(DEFAULT_MIN_GAIN_DB - 0.01);
    });

    it('ships a default noise limit of -45 dBFS and a +-24 dB range', () => {
        expect(DEFAULT_OUTPUT_NOISE_LIMIT_DB).toBe(-45);
        expect(DEFAULT_MIN_GAIN_DB).toBe(-24);
        expect(DEFAULT_MAX_GAIN_DB).toBe(24);
    });
});

describe('AgcProcessor — silence and noise are not speech', () => {
    it('freezes gain and level estimate once the input is silent', () => {
        const agc = primed();
        runFor(agc, tone(QUANTUM, dbToLinear(-40)), 5);
        expect(agc.gain).not.toBe(1); // control: it really adapted first
        // Let the 12 ms activity smoother fall through the transition.
        runFor(agc, tone(QUANTUM, dbToLinear(-80)), 0.1);
        const gainBefore = agc.gain;
        const levelBefore = agc.levelPower;
        runFor(agc, tone(QUANTUM, dbToLinear(-80)), 5);
        expect(agc.gain).toBe(gainBefore);
        expect(agc.levelPower).toBe(levelBefore);
    });

    it('reports voiceActive=false for digital silence and true for speech-level input', () => {
        const agc = primed();
        const speech = tone(QUANTUM, dbToLinear(-30));
        let r = agc.process(new Float32Array(QUANTUM), new Float32Array(QUANTUM));
        expect(r.voiceActive).toBe(false);
        for (let i = 0; i < 40; i++) r = agc.process(speech, new Float32Array(QUANTUM));
        expect(r.voiceActive).toBe(true);
    });

    it('does not amplify steady room noise that has no speech in it (the v1 floor check did)', () => {
        const agc = fresh();
        const seed = { s: 1 };
        for (let i = 0; i < Math.round(30 / QUANTUM_SEC); i++) {
            agc.process(noiseBlock(seed, -45), new Float32Array(QUANTUM));
        }
        // v1: a block above -50 dBFS was "speech", so -45 dBFS noise got +12 dB of boost.
        expect(linearToDb(agc.gain)).toBeLessThan(2);
    });

    it('does not move the gain for the first fraction of a second of speech (no evidence yet)', () => {
        const agc = primed();
        runFor(agc, tone(QUANTUM, dbToLinear(-45)), 0.2);
        expect(agc.gain).toBe(1);
    });
});

describe('AgcProcessor — convergence', () => {
    it('brings a quiet, sustained voice signal up to the target level', () => {
        const agc = primed({ outputNoiseLimitDb: 0 }); // a flat tone has no pauses to learn a noise floor from
        const out = runFor(agc, tone(QUANTUM, dbToLinear(-40)), 30);
        expect(linearToDb(outputRms(out))).toBeGreaterThan(DEFAULT_TARGET_DB - 1);
        expect(linearToDb(outputRms(out))).toBeLessThan(DEFAULT_TARGET_DB + 1);
    });

    it('brings a loud, sustained voice signal down to the target level', () => {
        const agc = primed();
        const out = runFor(agc, tone(QUANTUM, dbToLinear(-8)), 30);
        expect(linearToDb(outputRms(out))).toBeGreaterThan(DEFAULT_TARGET_DB - 1);
        expect(linearToDb(outputRms(out))).toBeLessThan(DEFAULT_TARGET_DB + 1);
    });

    it('is already close after 4 s of speech (v1 needed 10+ s: estimate seeded at the target, 3 dB/s)', () => {
        for (const inDb of [-40, -12]) {
            const agc = primed();
            const out = runFor(agc, tone(QUANTUM, dbToLinear(inDb)), 4);
            const err = Math.abs(linearToDb(outputRms(out)) - DEFAULT_TARGET_DB);
            expect(err).toBeLessThan(2.5);
        }
    });

    it('leaves an already-on-target signal close to unity gain', () => {
        const agc = primed();
        runFor(agc, tone(QUANTUM, dbToLinear(DEFAULT_TARGET_DB)), 20);
        expect(Math.abs(linearToDb(agc.gain))).toBeLessThan(1);
    });

    it('lands quiet and loud talkers within 1 dB of each other', () => {
        const a = primed({ outputNoiseLimitDb: 0 });
        const b = primed({ outputNoiseLimitDb: 0 });
        const qa = linearToDb(outputRms(runFor(a, tone(QUANTUM, dbToLinear(-42)), 40)));
        const qb = linearToDb(outputRms(runFor(b, tone(QUANTUM, dbToLinear(-9)), 40)));
        expect(Math.abs(qa - qb)).toBeLessThan(1);
    });
});

describe('AgcProcessor — burst guard', () => {
    it('pulls the gain down faster than the slow stage could when a talker suddenly shouts', () => {
        const agc = primed();
        runFor(agc, tone(QUANTUM, dbToLinear(-25)), 20); // settled, a bit boosted
        const before = linearToDb(agc.gain);
        runFor(agc, tone(QUANTUM, dbToLinear(-5)), 0.5); // +20 dB shout
        const drop = before - linearToDb(agc.gain);
        // Slow stage alone: 12 dB/s * 0.5 s = 6 dB max.
        expect(drop).toBeGreaterThan(DEFAULT_FALL_DB_PER_SEC * 0.5 + 2);
    });

    it('does not undo a deliberate boost for a talker who is merely a bit above target', () => {
        const agc = primed();
        runFor(agc, tone(QUANTUM, dbToLinear(-38)), 20);
        const before = linearToDb(agc.gain);
        runFor(agc, tone(QUANTUM, dbToLinear(-37)), 0.5); // +1 dB: inside the margin
        expect(before - linearToDb(agc.gain)).toBeLessThan(1);
    });
});

describe('AgcProcessor — peak compressor (no make-up gain)', () => {
    // Pin the slow stage to unity so only the compressor + limiter act.
    const pinned = () => new AgcProcessor({ sampleRate: SR, minGain: 1, maxGain: 1 });

    it('is exactly unity below the threshold — no hidden make-up (the Web Audio node added +9 dB here)', () => {
        const agc = pinned();
        const out = runFor(agc, tone(QUANTUM, dbToLinear(-30)), 1);
        expect(linearToDb(outputRms(out))).toBeCloseTo(-30, 1);
    });

    it('reduces a signal above the threshold by the static curve (ratio 3:1)', () => {
        const agc = pinned();
        const inDb = -4; // 10 dB over the -14 threshold
        const out = runFor(agc, tone(QUANTUM, dbToLinear(inDb)), 2);
        const over = inDb - DEFAULT_COMP_THRESHOLD_DB;
        const expected = inDb + (1 / DEFAULT_COMP_RATIO - 1) * over; // -4 - 6.67
        expect(linearToDb(outputRms(out))).toBeCloseTo(expected, 0);
    });

    it('is off when disabled in the options (gain + limiter only)', () => {
        const agc = new AgcProcessor({ sampleRate: SR, minGain: 1, maxGain: 1, compressor: false });
        const out = runFor(agc, tone(QUANTUM, dbToLinear(-4)), 1);
        expect(linearToDb(outputRms(out))).toBeCloseTo(-4, 1);
    });
});

describe('AgcProcessor — look-ahead limiter', () => {
    it('holds every sample at or below the ceiling, including the very first loud block', () => {
        const agc = new AgcProcessor({ sampleRate: SR, limiterCeiling: dbToLinear(-1), compressor: false });
        agc.enabled = false; // isolate the limiter from the slow AGC stage
        agc.gain = 1;
        runFor(agc, tone(QUANTUM, dbToLinear(-20)), 0.2);
        // Sudden +24 dB over-ceiling step (a cough into the mic): no ramp, no warning.
        let worst = 0;
        for (let i = 0; i < 40; i++) {
            const out = new Float32Array(QUANTUM);
            agc.process(tone(QUANTUM, 1.8), out);
            for (const s of out) worst = Math.max(worst, Math.abs(s));
        }
        expect(worst).toBeLessThanOrEqual(dbToLinear(-1) + 1e-6);
    });

    it('is already turning down before the peak reaches the output (look-ahead), unlike a feedback-only limiter', () => {
        const agc = new AgcProcessor({ sampleRate: SR, limiterCeiling: dbToLinear(-1), compressor: false });
        agc.enabled = false;
        const quiet = tone(QUANTUM, 0.05);
        runFor(agc, quiet, 0.2);
        // One quantum: quiet, then a 1.5-amplitude burst in the last 8 samples.
        const block = tone(QUANTUM, 0.05);
        for (let i = QUANTUM - 8; i < QUANTUM; i++) block[i] = 1.5;
        const out1 = new Float32Array(QUANTUM);
        agc.process(block, out1);
        // The burst is still inside the delay line, but the limiter has already started
        // ducking the quiet samples that leave first (their gain < 1).
        expect(agc.limiterGain).toBeLessThan(0.9);
        const out2 = new Float32Array(QUANTUM);
        agc.process(tone(QUANTUM, 0.05), out2);
        for (const s of out2) expect(Math.abs(s)).toBeLessThanOrEqual(dbToLinear(-1) + 1e-6);
    });

    it('delays the signal by exactly the look-ahead (1 ms = 48 samples at 48 kHz)', () => {
        const agc = primed({ compressor: false });
        agc.enabled = false;
        const impulse = new Float32Array(QUANTUM);
        impulse[0] = 0.5;
        const out = new Float32Array(QUANTUM);
        agc.process(impulse, out);
        const first = out.findIndex(v => Math.abs(v) > 0.4);
        expect(first).toBe(48);
    });

    it('does not engage (stays at unity) for a signal already under the ceiling', () => {
        const agc = new AgcProcessor({ sampleRate: SR, limiterCeiling: dbToLinear(-1), compressor: false });
        agc.enabled = false;
        runFor(agc, tone(QUANTUM, dbToLinear(-20)), 0.5);
        expect(agc.limiterGain).toBeCloseTo(1.0, 3);
    });
});

describe('AgcProcessor — enable/disable', () => {
    it('pins gain to unity and stops adapting when disabled', () => {
        const agc = primed();
        runFor(agc, tone(QUANTUM, dbToLinear(-40)), 5);
        expect(agc.gain).not.toBeCloseTo(1.0, 2);

        agc.setEnabled(false);
        expect(agc.gain).toBe(1.0);

        const quiet = tone(QUANTUM, dbToLinear(-40));
        let result = { gain: 0, voiceActive: true };
        let out = new Float32Array(QUANTUM);
        for (let i = 0; i < 10; i++) {
            out = new Float32Array(QUANTUM);
            result = agc.process(quiet, out);
        }
        expect(result.gain).toBe(1.0);
        expect(agc.gain).toBe(1.0);
        // Bypass is a pure (delayed) copy: no compressor, no gain.
        expect(outputRms(out)).toBeCloseTo(dbToLinear(-40), 5);
    });

    it('relearns the talker from scratch (fast) when re-enabled', () => {
        const agc = primed();
        runFor(agc, tone(QUANTUM, dbToLinear(-40)), 10);
        agc.setEnabled(false);
        agc.setEnabled(true);
        expect(agc.levelPower).toBe(0);
        expect(agc.activeSec).toBe(0);
        const out = runFor(agc, tone(QUANTUM, dbToLinear(-12)), 4);
        expect(Math.abs(linearToDb(outputRms(out)) - DEFAULT_TARGET_DB)).toBeLessThan(2.5);
    });
});

describe('AgcProcessor — numerical safety', () => {
    it('produces no NaN/Infinity for sustained digital silence', () => {
        const agc = primed();
        const silence = new Float32Array(QUANTUM);
        let out = new Float32Array(QUANTUM);
        for (let i = 0; i < 1000; i++) {
            out = new Float32Array(QUANTUM);
            agc.process(silence, out);
            if (i % 100 === 0) expect(out.every(Number.isFinite)).toBe(true);
        }
        expect(out.every(Number.isFinite)).toBe(true);
        for (const v of [agc.gain, agc.levelPower, agc.limiterGain, agc.noiseFloorDb, agc.compEnv]) {
            expect(Number.isFinite(v)).toBe(true);
        }
    });

    it('produces no NaN/Infinity for denormal-range (near-zero, non-zero) input', () => {
        const agc = primed();
        let out = new Float32Array(QUANTUM);
        for (let i = 0; i < 200; i++) {
            out = new Float32Array(QUANTUM);
            agc.process(tone(QUANTUM, 1e-40), out);
        }
        expect(out.every(Number.isFinite)).toBe(true);
        expect(Number.isFinite(agc.gain)).toBe(true);
    });

    it('handles a null input block without throwing (upstream node with no input connected)', () => {
        const agc = primed();
        const out = new Float32Array(QUANTUM);
        expect(() => agc.process(null, out)).not.toThrow();
        for (const sample of out) expect(sample).toBe(0);
    });

    it('survives a full-scale square wave without NaN and without exceeding the ceiling', () => {
        const agc = primed();
        const sq = new Float32Array(QUANTUM);
        for (let i = 0; i < QUANTUM; i++) sq[i] = i % 2 ? 1 : -1;
        let worst = 0;
        for (let i = 0; i < 2000; i++) {
            const out = new Float32Array(QUANTUM);
            agc.process(sq, out);
            for (const s of out) worst = Math.max(worst, Math.abs(s));
        }
        expect(Number.isFinite(agc.gain)).toBe(true);
        expect(worst).toBeLessThanOrEqual(dbToLinear(-1) + 1e-6);
    });
});
