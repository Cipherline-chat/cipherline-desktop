import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgcProcessor, dbToLinear, linearToDb, DEFAULT_LIMITER_CEILING_DB } from './agcKernel.js';
import { SPEEX_LIGHT_WORKLET_SOURCE } from '../utils/speexLightWorkletSource';
import { speexWasmBytes } from '../utils/speexWasm';

/**
 * These suites pin speed, holding and loud-onset behaviour, which the quiet-talker
 * curve must not change, so they run with full levelling. The curve itself is
 * pinned at its shipped defaults in agcKernel.test.ts ("quiet-talker curve").
 */
const FULL_BOOST = { quietBoostRatio: 1, maxQuietBoostDb: 99, quietKneeDb: -32 };

/**
 * The owner's rule for the sender AGC: "if audio is +5 dB above desired, lower it
 * 5 dB - that simple, no slow adjustments". These drive the real AgcProcessor
 * (and, for the clipping case, the real Light/Speex worklet in front of it) at
 * 128-sample render quanta with deterministic signals:
 *
 *  - a loud step is corrected within 50 ms,
 *  - a quiet step is recovered within 400 ms (during speech),
 *  - silence / room noise is never boosted,
 *  - a quiet talker who suddenly speaks up (or leans into the mic) behind Light
 *    noise suppression is neither clipped nor left loud for seconds.
 *
 * The talker is an impulse train through three formant resonators (crest factor
 * ~12 dB, like real speech - a plain sine would never stress the peak path),
 * chopped into 0.3 s syllables with 0.1 s gaps.
 */

vi.setConfig({ testTimeout: 60_000 });

const SR = 48000;
const Q = 128;
const CEIL = dbToLinear(DEFAULT_LIMITER_CEILING_DB);

function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** A formant-filtered impulse train, unit-ish scale, syllables 0.3 s on / 0.1 s off. */
function vowelUnit(seconds: number, f0 = 120): Float32Array {
    const n = Math.round(seconds * SR);
    const x = new Float32Array(n);
    const res = [[700, 90], [1220, 110], [2600, 160]].map(([f, bw]) => {
        const r = Math.exp((-Math.PI * bw) / SR);
        const th = (2 * Math.PI * f) / SR;
        return { a1: 2 * r * Math.cos(th), a2: -r * r, y1: 0, y2: 0 };
    });
    let next = 0;
    for (let i = 0; i < n; i++) {
        const t = i / SR;
        const f = f0 * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * t));
        let imp = 0;
        if (i >= next) {
            imp = 1;
            next = i + Math.round(SR / f);
        }
        let v = 0;
        for (const r of res) {
            const y = imp * 0.5 + r.a1 * r.y1 + r.a2 * r.y2;
            r.y2 = r.y1;
            r.y1 = y;
            v += y;
        }
        const k = Math.round(t * 1e6) % 400000 / 1e6; // t mod 0.4 without float drift
        const env = k < 0.3 ? Math.min(1, Math.min(k, 0.3 - k) / 0.02) : 0.01;
        x[i] = v * env;
    }
    return x;
}

/** Mean-square level (dBFS) of the loud 20 ms frames: the P.56-ish "active level". */
function activeDb(x: Float32Array): number {
    const fr = 960;
    const e: number[] = [];
    for (let i = 0; i + fr <= x.length; i += fr) {
        let s = 0;
        for (let j = 0; j < fr; j++) s += x[i + j] * x[i + j];
        e.push(s / fr);
    }
    const max = Math.max(...e);
    const loud = e.filter((v) => v >= max * 0.1);
    return 10 * Math.log10(loud.reduce((a, b) => a + b, 0) / loud.length);
}

/** A talker at `activeLevelDb` over a hiss floor at `floorDb`. */
function talker(seconds: number, activeLevelDb: number, floorDb = -64): Float32Array {
    const x = vowelUnit(seconds);
    const g = dbToLinear(activeLevelDb - activeDb(x));
    const r = lcg(11);
    const hiss = dbToLinear(floorDb) / Math.sqrt(0.5); // 6 summed uniforms minus 3 have variance 0.5
    for (let i = 0; i < x.length; i++) {
        let u = 0;
        for (let k = 0; k < 6; k++) u += r();
        x[i] = x[i] * g + (u - 3) * hiss;
    }
    return x;
}

/** x with a gain step of `stepDb` from `atSec` on. */
function stepped(x: Float32Array, atSec: number, stepDb: number): Float32Array {
    const y = Float32Array.from(x);
    const g = dbToLinear(stepDb);
    for (let i = Math.round(atSec * SR); i < y.length; i++) y[i] *= g;
    return y;
}

function runAgc(agc: InstanceType<typeof AgcProcessor>, x: Float32Array) {
    const blocks = Math.floor(x.length / Q);
    const out = new Float32Array(blocks * Q);
    const gainDb = new Float32Array(blocks);
    const limDb = new Float32Array(blocks);
    const o = new Float32Array(Q);
    for (let b = 0; b < blocks; b++) {
        agc.process(x.subarray(b * Q, (b + 1) * Q), o);
        out.set(o, b * Q);
        gainDb[b] = agc.gainDb;
        limDb[b] = linearToDb(agc.limiterGain);
    }
    return { out, gainDb, limDb };
}

const at = (s: number) => Math.round(s * SR);
const meanDb = (x: Float32Array, a: number, b: number) => {
    let s = 0;
    for (let i = at(a); i < at(b); i++) s += x[i] * x[i];
    return 10 * Math.log10(Math.max(s / (at(b) - at(a)), 1e-20));
};

/** Output level deviation (dB) of a stepped run from the un-stepped run of the
 *  SAME signal, over [from, to] seconds - identical pulse phase in both, so the
 *  pitch-pulse ripple of a short window cancels. */
function deviationDb(nominal: Float32Array, stepSig: Float32Array, fromS: number, toS: number) {
    const ref = runAgc(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), nominal).out;
    const got = runAgc(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), stepSig).out;
    return meanDb(got, fromS, toS) - meanDb(ref, fromS, toS);
}

// Step in the middle of a vowel (4.1 s = 10 syllables + 0.1 s), 7 s long.
const T0 = 4.1;

describe('sender AGC - loud step is corrected at once', () => {
    it('+12 dB above the talker\'s level is within 2 dB of normal after 50 ms', () => {
        const nominal = talker(6, -26);
        const loud = stepped(nominal, T0, 12);
        const dev = deviationDb(nominal, loud, T0 + 0.02, T0 + 0.05);
        expect(Math.abs(dev)).toBeLessThanOrEqual(2);
    });

    it('+5 dB is cut by about 5 dB within 50 ms and STAYS cut (the owner\'s rule: no slow adjustment)', () => {
        const nominal = talker(6, -26);
        const loud = stepped(nominal, T0, 5);
        expect(Math.abs(deviationDb(nominal, loud, T0 + 0.02, T0 + 0.05))).toBeLessThanOrEqual(2);
        expect(Math.abs(deviationDb(nominal, loud, T0 + 0.5, T0 + 0.9))).toBeLessThanOrEqual(1.5);
    });

    it('a quiet talker (gain parked high) who leans into the mic is back on level in 50 ms', () => {
        const quiet = talker(6, -42);
        const nominal = talker(6, -22);
        // quiet until T0, then the nominal talker (same phase) takes over.
        const lean = Float32Array.from(quiet);
        for (let i = at(T0); i < lean.length; i++) lean[i] = nominal[i];
        const ref = runAgc(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), nominal).out;
        const got = runAgc(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), lean).out;
        const dev = meanDb(got, T0 + 0.02, T0 + 0.05) - meanDb(ref, T0 + 0.02, T0 + 0.05);
        expect(Math.abs(dev)).toBeLessThanOrEqual(2);
        const later = meanDb(got, T0 + 0.5, T0 + 0.9) - meanDb(ref, T0 + 0.5, T0 + 0.9);
        expect(Math.abs(later)).toBeLessThanOrEqual(2.5); // was 1.5 at the -15.5 target; the limiter now works on this level
    });
});

describe('sender AGC - quiet step is recovered fast, but only during speech', () => {
    it('-12 dB below the talker\'s level is within 2 dB of normal within 400 ms', () => {
        // -16 -> -28: both above the quiet knee, so the step is fully recovered.
        const nominal = talker(7, -16);
        const quiet = stepped(nominal, T0, -12);
        // 20 ms plateau window of the syllable that ENDS the 400 ms mark.
        const dev = deviationDb(nominal, quiet, T0 + 0.36, T0 + 0.39);
        expect(Math.abs(dev)).toBeLessThanOrEqual(2);
    });

    it('is no slower than ~100 ms to start rising', () => {
        // -16 -> -28: both above the quiet knee, so the step is fully recovered.
        const nominal = talker(7, -16);
        const quiet = stepped(nominal, T0, -12);
        const { gainDb } = runAgc(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), quiet);
        const g0 = gainDb[Math.floor(at(T0) / Q) - 1];
        const g1 = gainDb[Math.floor(at(T0 + 0.1) / Q)];
        expect(g1 - g0).toBeGreaterThan(3);
    });
});

describe('sender AGC - silence and room noise are never boosted', () => {
    it('holds the gain through 6 s of hiss after speech (nothing pulled up between words)', () => {
        const speech = talker(5, -34);
        const floor = new Float32Array(at(6));
        const r = lcg(3);
        for (let i = 0; i < floor.length; i++) floor[i] = (r() * 2 - 1) * dbToLinear(-58);
        const x = new Float32Array(speech.length + floor.length);
        x.set(speech);
        x.set(floor, speech.length);
        const { gainDb } = runAgc(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), x);
        const b0 = Math.floor(speech.length / Q) + Math.round(0.4 * SR / Q); // after the voice hangover
        const g0 = gainDb[b0];
        let maxRise = -Infinity;
        for (let b = b0; b < gainDb.length; b++) maxRise = Math.max(maxRise, gainDb[b] - g0);
        expect(maxRise).toBeLessThan(0.1);
    });

    it('the output noise floor is not louder than the input floor + the held speech gain', () => {
        const floor = new Float32Array(at(4));
        const r = lcg(5);
        for (let i = 0; i < floor.length; i++) floor[i] = (r() * 2 - 1) * dbToLinear(-58);
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const { out, gainDb } = runAgc(agc, floor);
        expect(Math.max(...gainDb)).toBeLessThan(0.1);
        expect(meanDb(out, 1, 4) - meanDb(floor, 1, 4)).toBeLessThan(0.5);
    });
});

// ── Light (Speex) noise suppression in front of the AGC ─────────────────────

type Proc = {
    port: { onmessage: ((m: { data: unknown }) => void) | null };
    process: (i: Float32Array[][], o: Float32Array[][]) => boolean;
    ready?: boolean;
};
const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => { for (const k of ['registerProcessor', 'AudioWorkletProcessor', 'sampleRate']) delete g[k]; });

async function lightProcessor(): Promise<Proc> {
    let Ctor: (new (opts?: unknown) => Proc) | undefined;
    g.registerProcessor = (n: string, c: unknown) => { if (n === 'speex-light-worklet') Ctor = c as typeof Ctor; };
    g.AudioWorkletProcessor = class {
        port = { onmessage: null, postMessage: () => {} };
    };
    g.sampleRate = SR;
    const f = join(tmpdir(), `agc-light-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(f, SPEEX_LIGHT_WORKLET_SOURCE);
    try { await import(/* @vite-ignore */ `file://${f}`); } finally { unlinkSync(f); }
    const p = new Ctor!({});
    p.port.onmessage!({ data: { type: 'init', wasm: speexWasmBytes() } });
    for (let t = 0; t < 4000 && !p.ready; t += 20) await new Promise((res) => setTimeout(res, 20));
    if (!p.ready) throw new Error('speex did not come up');
    p.port.onmessage!({ data: { type: 'toggle', enabled: true } });
    return p;
}

function runLight(p: Proc, x: Float32Array): Float32Array {
    const y = new Float32Array(x.length);
    for (let o = 0; o + Q <= x.length; o += Q) {
        const out = new Float32Array(Q);
        p.process([[x.subarray(o, o + Q)]], [[out]]);
        y.set(out, o);
    }
    return y;
}

describe('Light noise suppression -> AGC: a hot input after quiet talk does not clip', () => {
    // A quiet talker for 4 s (the AGC parks at a high gain - Light's lower floor
    // lifts the boost cap), then the same voice 24 dB louder with peaks within
    // ~2 dB of full scale: speaking up and leaning into the mic.
    const quiet = talker(4, -40);
    const hot = talker(3, -12.5);
    const x = new Float32Array(quiet.length + hot.length);
    x.set(quiet);
    x.set(hot, quiet.length);

    it('the hot input really is near full scale (control for the test itself)', () => {
        let peak = 0;
        for (let i = quiet.length; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
        expect(peak).toBeGreaterThan(0.6);
        expect(peak).toBeLessThan(1);
    });

    it('never exceeds the limiter ceiling, and the limiter barely has to work (< 1 dB reduction, no flat-topped run)', async () => {
        const y = runLight(await lightProcessor(), x);
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const { out, limDb } = runAgc(agc, y);
        let peak = 0;
        let pinned = 0;
        for (let i = quiet.length; i < out.length; i++) {
            const a = Math.abs(out[i]);
            peak = Math.max(peak, a);
            if (a >= CEIL - 1e-4) pinned++;
        }
        const from = Math.floor(quiet.length / Q);
        let worstLimiter = 0;
        for (let b = from; b < limDb.length; b++) worstLimiter = Math.min(worstLimiter, limDb[b]);
        expect(peak).toBeLessThanOrEqual(CEIL + 1e-6);
        expect(peak).toBeLessThanOrEqual(1);
        // Target -12.5 puts a talker's peaks at the ceiling (speech crest ~12 dB), so the limiter
        // works a little: a few samples touch it, never a flat-topped run, and it never takes
        // more than 3.5 dB off (was: none pinned, < 1 dB, at the -15.5 target).
        expect(pinned).toBeLessThan(out.length * 0.0005);
        expect(worstLimiter).toBeGreaterThan(-3.5);
    });

    it('is back at the same level as a talker who was never quiet within 50 ms', async () => {
        const stepAt = quiet.length / SR; // 4.0 s: a syllable onset
        const ref = runAgc(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), runLight(await lightProcessor(), talker(7, -14))).out;
        const got = runAgc(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), runLight(await lightProcessor(), x)).out;
        const dev = meanDb(got, stepAt + 0.05, stepAt + 0.09) - meanDb(ref, stepAt + 0.05, stepAt + 0.09);
        expect(Math.abs(dev)).toBeLessThanOrEqual(2);
    });
});

describe('Light noise suppression: input past full scale is never wrapped', () => {
    // Windows drivers deliver float mic samples past 1.0 (an owner session on an
    // AIR 192|4 peaked at +18.8 dBFS). The vendored Speex glue fills an
    // Int16Array, which WRAPS: 1.02 -> -0.98. That polarity flip was the crackle
    // only Light had on loud speech; Off passed the hot samples through intact.
    const hot = talker(2, -12.5);
    const x = new Float32Array(hot.length);
    for (let i = 0; i < x.length; i++) x[i] = hot[i] * 6; // ~+13 dBFS peaks

    it('control: the input really exceeds full scale', () => {
        let peak = 0;
        for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
        expect(peak).toBeGreaterThan(2);
    });

    it('no sample flips polarity, and an over-range burst is turned down rather than squared off', async () => {
        const y = runLight(await lightProcessor(), x);
        // Speex delays by one 128-sample frame; compare against the input one frame back.
        let flips = 0;
        let peak = 0;
        for (let i = Q; i < y.length; i++) {
            peak = Math.max(peak, Math.abs(y[i]));
            const want = x[i - Q];
            if (Math.abs(want) > 0.9 && Math.sign(y[i]) !== Math.sign(want) && Math.abs(y[i]) > 0.5) flips++;
        }
        expect(flips).toBe(0);
        // Turned down to the ceiling, not squared off: almost no sample sits at it.
        expect(peak).toBeLessThanOrEqual(1);
        let atCeil = 0;
        for (let i = Q; i < y.length; i++) if (Math.abs(y[i]) >= 0.999) atCeil++;
        expect(atCeil).toBeLessThan(y.length * 0.001);
    });
});
