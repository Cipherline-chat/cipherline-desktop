import { describe, it, expect } from 'vitest';
import {
    AgcProcessor,
    VoiceDetector,
    dbToLinear,
    linearToDb,
    DEFAULT_TARGET_DB,
    DEFAULT_RISE_DB_PER_SEC,
    DEFAULT_BOOTSTRAP_RATE_MULT,
    DEFAULT_MIN_GAIN_DB,
    DEFAULT_MAX_GAIN_DB,
    DEFAULT_OUTPUT_NOISE_LIMIT_DB,
    DEFAULT_QUIET_BOOST_RATIO,
    DEFAULT_MAX_QUIET_BOOST_DB,
    DEFAULT_QUIET_KNEE_DB,
    DEFAULT_NO_BOOST_DB,
    DEFAULT_FAST_MARGIN_DB,
    DEFAULT_COMP_THRESHOLD_DB,
    DEFAULT_COMP_RATIO,
    DEFAULT_LIMITER_CEILING_DB,
    MIC_BOOST_TARGET_MAX_DB,
} from './agcKernel.js';

/**
 * These suites pin speed, holding and loud-onset behaviour, which the quiet-talker
 * curve must not change, so they run with full levelling. The curve itself is
 * pinned at its shipped defaults in agcKernel.test.ts ("quiet-talker curve").
 */
const FULL_BOOST = { quietBoostRatio: 1, maxQuietBoostDb: 99, quietKneeDb: -32 };

const QUANTUM = 128;
const SR = 48000;
const QUANTUM_SEC = QUANTUM / SR;

// ── Deterministic signals ────────────────────────────────────────────────────

function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** Low-passed white noise at a given RMS (dBFS): a room. */
function room(seconds: number, dbfs: number, seed = 1): Float32Array {
    const r = rng(seed);
    const n = Math.round(seconds * SR);
    const y = new Float32Array(n);
    let lp = 0;
    for (let i = 0; i < n; i++) {
        lp += 0.35 * ((r() * 2 - 1) - lp);
        y[i] = lp;
    }
    scaleRms(y, dbfs);
    return y;
}

function scaleRms(y: Float32Array, dbfs: number): void {
    let s = 0;
    for (let i = 0; i < y.length; i++) s += y[i] * y[i];
    const g = dbToLinear(dbfs) / Math.sqrt(Math.max(s / y.length, 1e-30));
    for (let i = 0; i < y.length; i++) y[i] *= g;
}

/** A breath: a half-second noise burst under a raised-cosine envelope. */
function breath(dbfs: number, seed = 5): Float32Array {
    const y = room(0.45, dbfs, seed);
    for (let i = 0; i < y.length; i++) y[i] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / y.length);
    return y;
}

/** A key click: 12 ms of decaying noise. Peak level `dbfs`. */
function click(dbfs: number, seed = 9): Float32Array {
    const r = rng(seed);
    const y = new Float32Array(Math.round(0.012 * SR));
    for (let i = 0; i < y.length; i++) y[i] = (r() * 2 - 1) * dbToLinear(dbfs) * Math.exp(-i / (0.0025 * SR));
    return y;
}

/**
 * Voiced "speech": a 25-harmonic glottal-like source (f0 ~ 125 Hz with vibrato)
 * chopped into 0.3 s syllables with 0.1 s gaps, scaled so its ACTIVE level (the
 * P.56-flavoured measure, over frames inside the syllables) is `activeDb`.
 */
const TABLE = 4096;
const GLOTTAL = (() => {
    const t = new Float32Array(TABLE);
    for (let i = 0; i < TABLE; i++) {
        let v = 0;
        for (let h = 1; h <= 25; h++) v += Math.sin((2 * Math.PI * h * i) / TABLE) / h;
        t[i] = v;
    }
    return t;
})();
const voiceCache = new Map<string, Float32Array>();

function voice(seconds: number, activeDb: number, f0 = 125): Float32Array {
    const key = `${seconds}|${activeDb}|${f0}`;
    const hit = voiceCache.get(key);
    if (hit) return hit; // never mutated by the helpers below (they copy)
    const n = Math.round(seconds * SR);
    const y = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
        const t = i / SR;
        const f = f0 * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * t));
        phase += f / SR;
        phase -= Math.floor(phase);
        const k = t % 0.4;
        y[i] = GLOTTAL[Math.floor(phase * TABLE) % TABLE] * (k < 0.3 ? Math.min(1, Math.min(k, 0.3 - k) / 0.02) : 0.01);
    }
    const g = dbToLinear(activeDb - activeLevelDb(y));
    for (let i = 0; i < n; i++) y[i] *= g;
    voiceCache.set(key, y);
    return y;
}

function concat(...parts: Float32Array[]): Float32Array {
    const y = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
        y.set(p, o);
        o += p.length;
    }
    return y;
}

function mix(...parts: Float32Array[]): Float32Array {
    const y = new Float32Array(Math.max(...parts.map((p) => p.length)));
    for (const p of parts) for (let i = 0; i < p.length; i++) y[i] += p[i];
    return y;
}

function addAt(dst: Float32Array, src: Float32Array, atSec: number): void {
    const at = Math.round(atSec * SR);
    for (let i = 0; i < src.length && at + i < dst.length; i++) dst[at + i] += src[i];
}

/** Active-speech level (mean power of the 20 ms frames within ~16 dB of the active level). */
function activeLevelDb(x: Float32Array, from = 0, to = x.length): number {
    const fr = Math.round(SR * 0.02);
    const e: number[] = [];
    for (let i = from; i + fr <= to; i += fr) {
        let s = 0;
        for (let j = 0; j < fr; j++) s += x[i + j] * x[i + j];
        e.push(s / fr);
    }
    if (!e.length) return -120;
    let lvl = 10 * Math.log10(Math.max(e.reduce((a, b) => a + b, 0) / e.length, 1e-20));
    for (let k = 0; k < 6; k++) {
        const thr = Math.pow(10, (lvl - 15.9) / 10);
        let s = 0;
        let c = 0;
        for (const v of e) if (v >= thr) { s += v; c++; }
        if (!c) break;
        lvl = 10 * Math.log10(s / c);
    }
    return lvl;
}

function peakDb(x: Float32Array, from = 0, to = x.length): number {
    let p = 0;
    for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]));
    return linearToDb(p);
}

/** Highest short-term (20 ms) RMS in a window, dBFS. */
function maxShortTermDb(x: Float32Array, from: number, to: number): number {
    const w = Math.round(0.02 * SR);
    let m = -200;
    for (let i = from; i + w <= to; i += w / 2) {
        let s = 0;
        for (let j = 0; j < w; j++) s += x[i + j] * x[i + j];
        m = Math.max(m, 10 * Math.log10(Math.max(s / w, 1e-20)));
    }
    return m;
}

interface Trace {
    out: Float32Array;
    gainDb: Float32Array; // slow gain per block
    totalDb: Float32Array; // slow + cut per block
    speech: Uint8Array;
}

function run(agc: AgcProcessor, x: Float32Array): Trace {
    const blocks = Math.floor(x.length / QUANTUM);
    const out = new Float32Array(blocks * QUANTUM);
    const gainDb = new Float32Array(blocks);
    const totalDb = new Float32Array(blocks);
    const speech = new Uint8Array(blocks);
    const o = new Float32Array(QUANTUM);
    for (let b = 0; b < blocks; b++) {
        const r = agc.process(x.subarray(b * QUANTUM, (b + 1) * QUANTUM), o);
        out.set(o, b * QUANTUM);
        gainDb[b] = agc.gainDb;
        totalDb[b] = r.gainDb;
        speech[b] = r.voiceActive ? 1 : 0;
    }
    return { out, gainDb, totalDb, speech };
}

const at = (sec: number) => Math.round(sec * SR);
const blk = (sec: number) => Math.round(sec / QUANTUM_SEC);
const TARGET = DEFAULT_TARGET_DB;
const CEIL = DEFAULT_LIMITER_CEILING_DB;

// ── VoiceDetector ────────────────────────────────────────────────────────────

function voicedFraction(x: Float32Array, minRmsDb = -52): number {
    const d = new VoiceDetector(SR);
    let frames = 0;
    let voiced = 0;
    for (let b = 0; (b + 1) * QUANTUM <= x.length; b++) {
        if (d.push(x.subarray(b * QUANTUM, (b + 1) * QUANTUM))) {
            let s = 0;
            const from = Math.max(0, (b + 1) * QUANTUM - 1024);
            for (let i = from; i < (b + 1) * QUANTUM; i++) s += x[i] * x[i];
            if (10 * Math.log10(s / ((b + 1) * QUANTUM - from) + 1e-20) < minRmsDb) continue;
            frames++;
            if (d.score >= 0.5) voiced++;
        }
    }
    return frames ? voiced / frames : 0;
}

describe('VoiceDetector - voiced speech yes, everything else no', () => {
    it('hears a voiced signal at any level a mic produces', () => {
        for (const db of [-50, -30, -10]) expect(voicedFraction(voice(4, db))).toBeGreaterThan(0.6);
    });

    it('hears a high and a low voice', () => {
        expect(voicedFraction(voice(4, -25, 95))).toBeGreaterThan(0.6);
        expect(voicedFraction(voice(4, -25, 240))).toBeGreaterThan(0.6);
    });

    it('does not hear room noise, breaths, key clicks or typing', () => {
        expect(voicedFraction(room(5, -45))).toBeLessThan(0.02);
        const br = new Float32Array(at(6));
        for (let t = 0.2; t < 5; t += 1.1) addAt(br, breath(-35), t);
        expect(voicedFraction(br)).toBeLessThan(0.02);
        const cl = new Float32Array(at(6));
        for (let t = 0.1; t < 5.5; t += 0.21) addAt(cl, click(-25), t);
        expect(voicedFraction(cl)).toBeLessThan(0.05);
    });

    it('does not hear a slow rumble, however strong', () => {
        const r = room(6, -30, 3);
        let lp = 0;
        for (let i = 0; i < r.length; i++) {
            lp += 0.02 * (r[i] - lp);
            r[i] = lp * 6;
        }
        expect(voicedFraction(r)).toBeLessThan(0.1);
    });
});

// ── 1. Gain holds in silence and noise ───────────────────────────────────────

describe('AgcProcessor - the gain adapts ONLY while voiced speech is heard', () => {
    function deskNoise(seconds: number): Float32Array {
        // What a real desk sounds like between sentences: room, breaths, typing -
        // all of it above the -50 dBFS activity floor and the gate threshold.
        const x = room(seconds, -50, 11);
        for (let t = 1; t < seconds - 1; t += 1.7) addAt(x, breath(-34), t);
        for (let t = 0.5; t < seconds - 1; t += 0.33) addAt(x, click(-24), t);
        return x;
    }

    it('holds the slow gain and the level estimate for 30 s of breaths, clicks and room noise', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        run(agc, concat(room(0.5, -62), voice(5, -30), room(0.5, -62, 6))); // (+ the 150 ms hangover has run out)
        const gainBefore = agc.gainDb;
        const levelBefore = agc.levelPower;
        expect(gainBefore).toBeGreaterThan(8); // control: it really had a boost to hold
        const t = run(agc, deskNoise(30));
        expect(agc.gainDb).toBe(gainBefore);
        expect(agc.levelPower).toBe(levelBefore);
        expect(t.speech.reduce((a, b) => a + b, 0)).toBe(0); // none of it was taken for speech
    });

    it('CONTROL: the same gain moves as soon as a person talks (so the hold above is the detector, not a stuck gain)', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        run(agc, concat(room(0.5, -62), voice(5, -30)));
        const before = agc.gainDb;
        run(agc, concat(deskNoise(10), voice(4, -12)));
        expect(agc.gainDb).toBeLessThan(before - 8);
    });

    it('does not creep towards the maximum gain in a noisy room with nobody talking', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        run(agc, concat(room(0.5, -62), voice(3, -26)));
        const settled = agc.gainDb;
        run(agc, deskNoise(25));
        expect(Math.abs(agc.gainDb - settled)).toBeLessThan(1e-9);
        expect(agc.gainDb).toBeLessThan(DEFAULT_MAX_GAIN_DB - 10);
    });

    it('holds across a mid-sentence pause (silence between two voiced stretches loses no calibration)', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        run(agc, concat(room(0.5, -62), voice(4, -30)));
        const g = agc.gainDb;
        run(agc, room(5, -62));
        expect(agc.gainDb).toBe(g);
    });

    it('reports voiceActive for speech and not for silence', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const quiet = run(agc, room(1, -70));
        expect(Math.max(...quiet.speech)).toBe(0);
        const talk = run(agc, voice(2, -26));
        const share = talk.speech.reduce((a, b) => a + b, 0) / talk.speech.length;
        expect(share).toBeGreaterThan(0.6);
    });
});

// ── 2. Quiet speech comes up fast, bounded ───────────────────────────────────

describe('AgcProcessor - quiet speech is brought up fast, within bounds', () => {
    it('a -30 dBFS talker is within 3 dB of the target after 0.8 s of speech', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const t = run(agc, concat(room(0.4, -62), voice(3, -30)));
        const need = TARGET - -30; // ~ +11.5 dB
        expect(t.gainDb[blk(0.4 + 0.8)]).toBeGreaterThan(need - 3);
    });

    it('a -32 dBFS talker (the quiet knee) is within 3 dB of the target after 1.2 s of speech', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const t = run(agc, concat(room(0.4, -66), voice(3, -32)));
        expect(t.gainDb[blk(0.4 + 1.2)]).toBeGreaterThan(TARGET - -32 - 3);
    });

    it('a -40 dBFS talker gets the quiet curve\'s smaller boost (~12 dB with a knee at -32), not the full 24.5 dB', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const t = run(agc, concat(room(0.4, -66), voice(3, -40)));
        const g = t.gainDb[blk(0.4 + 1.2)];
        expect(g).toBeGreaterThan(10);
        expect(g).toBeLessThan(16);
    });

    it('the output of a -30 dBFS talker is on target (+-2.5 dB) in the second after the first second', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const t = run(agc, concat(room(0.4, -62), voice(4, -30)));
        const lvl = activeLevelDb(t.out, at(1.5), at(4.4));
        expect(Math.abs(lvl - (TARGET - 1.5))).toBeLessThan(2.5);
    });

    it('never rises faster than the configured rate (x bootstrap multiplier)', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const t = run(agc, concat(room(0.4, -62), voice(3, -45)));
        const limit = DEFAULT_RISE_DB_PER_SEC * DEFAULT_BOOTSTRAP_RATE_MULT * QUANTUM_SEC;
        for (let b = 1; b < t.gainDb.length; b++) expect(t.gainDb[b] - t.gainDb[b - 1]).toBeLessThanOrEqual(limit + 1e-5);
    });

    it('never exceeds the maximum gain, however quiet the talker', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const t = run(agc, concat(room(0.4, -80), voice(8, -62)));
        expect(Math.max(...t.gainDb)).toBeLessThanOrEqual(DEFAULT_MAX_GAIN_DB + 1e-9);
        expect(Math.min(...t.gainDb)).toBeGreaterThanOrEqual(DEFAULT_MIN_GAIN_DB - 1e-9);
    });

    it('caps the boost so the tracked noise floor never comes out above the output-noise limit', () => {
        // (Pins the plain limit rule: minSnrDb Infinity switches the 2026-11-11 SNR exemption off.)
        const agc = new AgcProcessor({ ...FULL_BOOST, minSnrDb: Infinity, sampleRate: SR });
        // Steady room at -54 dBFS under a -30 talker (above the quiet knee, so
        // it wants ~11.5 dB): the floor tracker settles near -54, so the boost
        // may not exceed (limit - floor) = ~9 dB.
        const x = mix(room(10, -54, 4), concat(new Float32Array(at(0.5)), voice(9.5, -30)));
        run(agc, x);
        const cap = Math.max(0, DEFAULT_OUTPUT_NOISE_LIMIT_DB - agc.noiseFloorDb);
        expect(agc.gainDb).toBeLessThanOrEqual(Math.min(DEFAULT_MAX_GAIN_DB, cap) + 1e-6);
        expect(agc.gainDb).toBeGreaterThan(5); // it did boost (the cap is a ceiling, not a switch)
    });

    it('does not pump: a steady talker holds a steady gain (sd < 0.5 dB, range < 3 dB over 7 s)', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const t = run(agc, concat(room(0.4, -62), voice(12, -26)));
        const g = Array.from(t.gainDb.subarray(blk(4), blk(11)));
        const m = g.reduce((a, b) => a + b, 0) / g.length;
        const sd = Math.sqrt(g.reduce((a, b) => a + (b - m) * (b - m), 0) / g.length);
        expect(sd).toBeLessThan(0.5);
        expect(Math.max(...g) - Math.min(...g)).toBeLessThan(3);
    });
});

// ── 3. Loud onsets are caught immediately ────────────────────────────────────

describe('AgcProcessor - a loud onset is caught in the block it arrives in', () => {
    // The owner's report: quiet for a while, then I talk loudly and I am super loud.
    function quietThenLoud(opts: Record<string, unknown> = {}) {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR, ...opts });
        const x = concat(room(0.4, -62), voice(5, -30), room(20, -62, 8), voice(4, -6));
        const t = run(agc, x);
        const onset = at(0.4 + 5 + 20);
        return { agc, t, onset };
    }

    it('holds a boosted gain through the silence, so the loud word meets the worst case', () => {
        const { t, onset } = quietThenLoud();
        expect(t.gainDb[Math.round(onset / QUANTUM) - 1]).toBeGreaterThan(8);
    });

    it('cuts within 0.5 s, with the very first loud syllable capped near the ceiling the law promises', () => {
        const { t, onset } = quietThenLoud();
        const fastCeil = TARGET + DEFAULT_FAST_MARGIN_DB;
        // 20 ms RMS anywhere in the first 150 ms of the loud word
        expect(maxShortTermDb(t.out, onset, onset + at(0.15))).toBeLessThan(fastCeil + 4);
        // and the settled level is back to the target within half a second
        expect(Math.abs(activeLevelDb(t.out, onset + at(1.0), onset + at(3.5)) - (TARGET - 1.5))).toBeLessThan(3);
    });

    it('CONTROL: without the guard the same word comes out much louder (so the guard is what holds it)', () => {
        const guarded = quietThenLoud();
        const unguarded = quietThenLoud({ fastMarginDb: 99, fastFallDbPerSec: 0.001, fallDbPerSec: 12, bootstrapRateMult: 1 });
        const g = maxShortTermDb(guarded.t.out, guarded.onset, guarded.onset + at(0.15));
        const u = maxShortTermDb(unguarded.t.out, unguarded.onset, unguarded.onset + at(0.15));
        expect(u).toBeGreaterThan(g + 3); // was +4 at the -15.5 target; the louder target leaves less headroom under the limiter
    });

    it('never lets a sample past the limiter ceiling, even with a boosted gain and a hot onset', () => {
        const { t } = quietThenLoud();
        expect(peakDb(t.out)).toBeLessThanOrEqual(CEIL + 1e-6);
    });

    it('also catches a loud NON-speech sound (a cough, a slammed door) - the guard is not speech-gated', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const bang = room(0.3, -6, 12); // a slammed door: loud, noise-like, decaying
        for (let i = 0; i < bang.length; i++) bang[i] *= Math.exp(-i / (0.08 * SR));
        const x = concat(room(0.4, -62), voice(5, -30), room(3, -62, 2), bang, room(1, -62, 3));
        const t = run(agc, x);
        const a = at(0.4 + 5 + 3);
        expect(maxShortTermDb(t.out, a, a + at(0.2))).toBeLessThan(TARGET + DEFAULT_FAST_MARGIN_DB + 4);
        // and it did not move the slow gain (a bang is not a talker)
        expect(Math.abs(t.gainDb[Math.round(a / QUANTUM) + 200] - t.gainDb[Math.round(a / QUANTUM) - 5])).toBeLessThan(1e-9);
    });
});

// ── 4. A new joiner starts at a sensible level ───────────────────────────────

describe('AgcProcessor - joining a call', () => {
    function firstSecond(opts: Record<string, unknown> = {}) {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR, ...opts });
        const t = run(agc, concat(room(0.4, -62), voice(8, -6)));
        return {
            first: activeLevelDb(t.out, at(0.4), at(1.4)),
            first300: maxShortTermDb(t.out, at(0.4), at(0.7)),
            steady: activeLevelDb(t.out, at(4), at(8.4)),
        };
    }

    it('a hot mic (-6 dBFS) is clamped from the first block: the first second is within 4 dB of the steady level', () => {
        const j = firstSecond();
        expect(j.first - j.steady).toBeLessThan(4);
        expect(j.first300).toBeLessThan(TARGET + DEFAULT_FAST_MARGIN_DB + 5);
    });

    it('CONTROL: with the guard off, the same joiner is far louder in the first second', () => {
        const j = firstSecond({ fastMarginDb: 99, fastFallDbPerSec: 0.001, fallDbPerSec: 12, bootstrapRateMult: 1, minEvidenceSec: 0.25 });
        const g = firstSecond();
        expect(j.first).toBeGreaterThan(g.first + 2); // was +3 at the -15.5 target (less headroom under the limiter now)
    });

    it('starts at unity unless told otherwise, and honours a stored per-device level', () => {
        expect(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }).gainDb).toBe(0);
        const stored = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR, initialGainDb: 9 });
        expect(stored.gainDb).toBe(9);
        const t = run(stored, concat(room(0.4, -62), voice(2, -30)));
        // starting at the right gain, the first second is already on target
        expect(Math.abs(activeLevelDb(t.out, at(0.4), at(1.4)) - (TARGET - 1.5))).toBeLessThan(3.5);
    });
});

// ── 5. Light and Strong land at the same loudness, with the same protection ──

describe('AgcProcessor - the gain law does not depend on the noise suppressor upstream', () => {
    const speech = (db: number) => voice(8, db);

    it('Strong\'s +3.5 dB make-up gain (and its absence in Light) is levelled away: same output level +-1 dB', () => {
        for (const db of [-30, -12]) {
            const light = run(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), concat(room(0.4, -62), speech(db)));
            const strong = run(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), concat(room(0.4, -62), speech(db + 3.5)));
            const a = activeLevelDb(light.out, at(4), at(8));
            const b = activeLevelDb(strong.out, at(4), at(8));
            expect(Math.abs(a - b)).toBeLessThan(1);
        }
    });

    it('Light\'s leftovers (typing and breaths between words) do not change the speech level or the gain', () => {
        const strongLike = concat(room(0.4, -62), speech(-26));
        const lightLike = strongLike.slice();
        // add what Speex cannot remove: clicks and breaths over the whole signal
        for (let t = 0.5; t < 8; t += 0.33) addAt(lightLike, click(-30), t);
        for (let t = 1; t < 8; t += 1.7) addAt(lightLike, breath(-36), t);
        const s = run(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), strongLike);
        const l = run(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), lightLike);
        expect(Math.abs(activeLevelDb(s.out, at(4), at(8)) - activeLevelDb(l.out, at(4), at(8)))).toBeLessThan(1.5);
        expect(Math.abs(s.gainDb[blk(8)] - l.gainDb[blk(8)])).toBeLessThan(1.5);
    });

    it('both are held under the same ceiling on loud speech (no clipping on either)', () => {
        for (const offs of [0, 3.5]) {
            const t = run(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), concat(room(0.4, -62), voice(8, -4 + offs)));
            expect(peakDb(t.out)).toBeLessThanOrEqual(CEIL + 1e-6);
            let clipped = 0;
            for (let i = 0; i < t.out.length; i++) if (Math.abs(t.out[i]) >= 0.9999) clipped++;
            expect(clipped).toBe(0);
        }
    });

    it('lands every talker from the quiet knee (-32) to -6 dBFS within 2 dB of the same output level once settled', () => {
        const levels = [-32, -30, -26, -18, -6].map((db) => {
            const t = run(new AgcProcessor({ ...FULL_BOOST, sampleRate: SR }), concat(room(0.4, -66), speech(db)));
            return activeLevelDb(t.out, at(4), at(8));
        });
        expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(2);
        expect(Math.abs(levels[2] - (TARGET - 1.5))).toBeLessThan(2.5);
    });
});

// ── Peak compressor (no make-up gain) ────────────────────────────────────────

describe('AgcProcessor - peak compressor (no make-up gain)', () => {
    /** Gain 1 (nothing detected as speech), guard disabled: the compressor alone. */
    function compOnly(amp: number, extra: Record<string, unknown> = {}) {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR, fastMarginDb: 99, limiterCeiling: 4, ...extra });
        const input = new Float32Array(QUANTUM).fill(amp);
        const out = new Float32Array(QUANTUM);
        for (let i = 0; i < Math.round(0.6 / QUANTUM_SEC); i++) agc.process(input, out);
        return out[QUANTUM - 1];
    }

    it('is exactly unity below the threshold - no hidden make-up (the Web Audio node added +9 dB here)', () => {
        const amp = dbToLinear(DEFAULT_COMP_THRESHOLD_DB - 20);
        expect(compOnly(amp)).toBeCloseTo(amp, 6);
    });

    it('reduces a signal above the threshold by the static curve (ratio 3:1)', () => {
        const over = 12;
        const amp = dbToLinear(DEFAULT_COMP_THRESHOLD_DB + over);
        const expectedDb = DEFAULT_COMP_THRESHOLD_DB + over / DEFAULT_COMP_RATIO;
        expect(linearToDb(compOnly(amp))).toBeCloseTo(expectedDb, 0);
    });

    it('is off when disabled in the options (gain + limiter only)', () => {
        const amp = dbToLinear(DEFAULT_COMP_THRESHOLD_DB + 12);
        expect(compOnly(amp, { compressor: false })).toBeCloseTo(amp, 6);
    });
});

// ── Look-ahead limiter ───────────────────────────────────────────────────────

describe('AgcProcessor - look-ahead limiter', () => {
    it('holds every sample at or below the ceiling, including the very first loud block', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const ceiling = dbToLinear(CEIL);
        const loud = new Float32Array(QUANTUM);
        for (let i = 0; i < QUANTUM; i++) loud[i] = (i % 2 ? 1 : -1) * 1.0;
        const out = new Float32Array(QUANTUM);
        for (let b = 0; b < 200; b++) {
            agc.process(loud, out);
            for (let i = 0; i < QUANTUM; i++) expect(Math.abs(out[i])).toBeLessThanOrEqual(ceiling + 1e-7);
        }
    });

    it('delays the signal by exactly the look-ahead (1 ms = 48 samples at 48 kHz)', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR, compressor: false, fastMarginDb: 99 });
        expect(agc.lookahead).toBe(48);
        const inp = new Float32Array(QUANTUM);
        inp[10] = 0.1;
        const out = new Float32Array(QUANTUM);
        agc.process(inp, out);
        const next = new Float32Array(QUANTUM);
        agc.process(new Float32Array(QUANTUM), next);
        const all = Array.from(out).concat(Array.from(next));
        expect(all.indexOf(Math.max(...all))).toBe(10 + 48);
    });

    it('does not engage (stays at unity) for a signal already under the ceiling', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR, compressor: false, fastMarginDb: 99 });
        const inp = new Float32Array(QUANTUM).fill(0.1);
        const out = new Float32Array(QUANTUM);
        for (let b = 0; b < 100; b++) agc.process(inp, out);
        expect(agc.limiterGain).toBeCloseTo(1, 6);
        expect(out[QUANTUM - 1]).toBeCloseTo(0.1, 6);
    });
});

// ── Enable / disable ─────────────────────────────────────────────────────────

describe('AgcProcessor - enable/disable', () => {
    it('pins gain to unity and stops adapting when disabled', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        run(agc, concat(room(0.4, -62), voice(4, -30)));
        expect(agc.gainDb).toBeGreaterThan(5);
        agc.setEnabled(false);
        expect(agc.gain).toBe(1);
        const t = run(agc, voice(3, -30));
        expect(agc.gain).toBe(1);
        expect(Math.max(...t.totalDb)).toBe(0);
        // the limiter is still a safety net in bypass
        const hot = new Float32Array(QUANTUM).fill(1);
        const out = new Float32Array(QUANTUM);
        for (let b = 0; b < 50; b++) agc.process(hot, out);
        expect(Math.abs(out[QUANTUM - 1])).toBeLessThanOrEqual(dbToLinear(CEIL) + 1e-7);
    });

    it('relearns the talker from scratch (fast) when re-enabled', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        run(agc, concat(room(0.4, -62), voice(4, -30)));
        agc.setEnabled(false);
        agc.setEnabled(true);
        expect(agc.levelPower).toBe(0);
        const t = run(agc, concat(room(0.2, -62), voice(3, -30)));
        expect(t.gainDb[blk(0.2 + 1.0)]).toBeGreaterThan(TARGET - -30 - 3);
    });
});

// ── Numerical safety ─────────────────────────────────────────────────────────

describe('AgcProcessor - numerical safety', () => {
    it('produces no NaN/Infinity for sustained digital silence', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const t = run(agc, new Float32Array(at(20)));
        expect(Array.from(t.totalDb).every(Number.isFinite)).toBe(true);
        expect(Array.from(t.out).every(Number.isFinite)).toBe(true);
    });

    it('produces no NaN/Infinity for denormal-range input', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const x = new Float32Array(at(5)).fill(1e-30);
        const t = run(agc, x);
        expect(Array.from(t.out).every(Number.isFinite)).toBe(true);
    });

    it('handles a null input block without throwing', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const out = new Float32Array(QUANTUM);
        expect(() => { for (let i = 0; i < 100; i++) agc.process(null, out); }).not.toThrow();
        expect(out.every((v) => v === 0)).toBe(true);
    });

    it('survives a full-scale square wave without NaN and without exceeding the ceiling', () => {
        const agc = new AgcProcessor({ ...FULL_BOOST, sampleRate: SR });
        const x = new Float32Array(at(3));
        for (let i = 0; i < x.length; i++) x[i] = Math.floor(i / 48) % 2 ? 1 : -1;
        const t = run(agc, x);
        expect(Array.from(t.out).every(Number.isFinite)).toBe(true);
        expect(peakDb(t.out)).toBeLessThanOrEqual(CEIL + 1e-6);
    });
});

describe('AgcProcessor - quiet-talker curve (soft speech stays a little softer, loud side untouched)', () => {
    const settle = (db: number, opts: Record<string, unknown> = {}) => {
        const agc = new AgcProcessor({ sampleRate: SR, ...opts });
        const t = run(agc, concat(room(0.4, -70), voice(8, db)));
        return { out: activeLevelDb(t.out, at(4), at(8)), gain: agc.gainDb };
    };

    it('the shipped numbers: full compensation, 45 dB at most, down to -55 dBFS, none at -62 (2026-11-11)', () => {
        expect(DEFAULT_QUIET_BOOST_RATIO).toBe(1);
        expect(DEFAULT_MAX_QUIET_BOOST_DB).toBe(45);
        expect(DEFAULT_QUIET_KNEE_DB).toBe(-55);
        expect(DEFAULT_NO_BOOST_DB).toBe(-62);
    });

    it('the cap: never limits a cut; partial above the knee; a straight line to 0 dB below it', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        expect(agc.quietBoostCapDb(-10, TARGET)).toBe(Infinity);
        expect(agc.quietBoostCapDb(TARGET, TARGET)).toBe(Infinity);
        expect(agc.quietBoostCapDb(TARGET - 10, TARGET)).toBeCloseTo(10, 6);
        // At the knee the whole distance (41 dB at the -14 target) is under the 45 dB limit.
        const atKnee = Math.min((TARGET - DEFAULT_QUIET_KNEE_DB) * DEFAULT_QUIET_BOOST_RATIO, DEFAULT_MAX_QUIET_BOOST_DB);
        expect(atKnee).toBeCloseTo(41, 6);
        expect(agc.quietBoostCapDb(DEFAULT_QUIET_KNEE_DB, TARGET)).toBeCloseTo(atKnee, 6);
        // Halfway between the knee and the no-boost level: half of it.
        expect(agc.quietBoostCapDb((DEFAULT_QUIET_KNEE_DB + DEFAULT_NO_BOOST_DB) / 2, TARGET)).toBeCloseTo(atKnee / 2, 6);
        expect(agc.quietBoostCapDb(DEFAULT_NO_BOOST_DB, TARGET)).toBe(0);
        expect(agc.quietBoostCapDb(-70, TARGET)).toBe(0);
    });

    it('never boosts past the cap, however long a soft talker keeps talking', () => {
        for (const db of [-24, -30, -36, -42]) expect(settle(db).gain).toBeLessThanOrEqual(DEFAULT_MAX_QUIET_BOOST_DB + 1e-6);
    });

    it('every clean talker from -22 to -50 dBFS lands within 2 dB of the same output (full compensation); below the knee it tapers off', () => {
        const outs = [-22, -30, -40, -45, -50].map((db) => settle(db).out);
        for (const o of outs) expect(Math.abs(o - outs[0])).toBeLessThan(2);
        expect(settle(-58).out).toBeLessThan(settle(-50).out - 3); // the taper: -58 is under the knee
        expect(settle(-61).gain).toBeLessThan(settle(-58).gain);
    });

    it('CONTROL: the previous curve (75 %, 30 dB, knee -50) left a -45 dBFS talker ~6 dB lower', () => {
        const old = { quietBoostRatio: 0.75, maxQuietBoostDb: 30, quietKneeDb: -50 };
        expect(settle(-45).out).toBeGreaterThan(settle(-45, old).out + 4);
    });

    it('ordinary and low-gain mics land near the target instead of far below it (2026-11-08)', () => {
        for (const db of [-30, -34, -38]) expect(settle(db).out).toBeGreaterThan(-25);
    });

    it('it is still lifted, not left alone, until the floor', () => {
        for (const db of [-28, -34, -40]) expect(settle(db).gain).toBeGreaterThan(0.5);
        // A mic quieter than -62 dBFS speech is muted or broken: nothing is lifted.
        for (const db of [-66, -70]) expect(settle(db).gain).toBeLessThanOrEqual(0.01);
    });

    it('a very hot mic is cut all the way: +12 dBFS speech lands where -6 dBFS does', () => {
        expect(-DEFAULT_MIN_GAIN_DB).toBeGreaterThanOrEqual(36);
        expect(Math.abs(settle(12).out - settle(-6).out)).toBeLessThan(0.5);
    });

    it('the loud side is unchanged: over the target, the curve and full levelling agree', () => {
        for (const db of [-14, -10, -6]) {
            expect(Math.abs(settle(db).out - settle(db, FULL_BOOST).out)).toBeLessThan(0.5);
        }
    });

    it('a loud word after soft talk is still cut at once', () => {
        const x = concat(room(0.4, -70), voice(3, -36), voice(2, -8));
        const t = run(new AgcProcessor({ sampleRate: SR }), x);
        expect(activeLevelDb(t.out, at(3.45), at(3.9))).toBeLessThan(TARGET + 6);
    });
});

describe('AgcProcessor - the level estimate lets go after one loud moment (owner report 8d425682)', () => {
    // Speech in 3 s utterances with 1.5 s of digital silence (what the voice gate leaves).
    const talk = (db: number, n: number) =>
        concat(...Array.from({ length: n }, () => concat(voice(3, db), new Float32Array(at(1.5)))));
    // The owner's pattern: ordinary talk at -45 dBFS, one loud voiced moment (-24), then -45 again.
    const scenario = () => concat(talk(-45, 2), voice(1, -24), talk(-45, 6));
    const settledGain = (opts = {}) => {
        const agc = new AgcProcessor({ sampleRate: SR, ...opts });
        const t = run(agc, scenario());
        return { agc, t, end: t.gainDb[t.gainDb.length - 1] };
    };

    it('CONTROL: with the release switched off, one loud word pins the gain ~15 dB too low for the rest of the call', () => {
        const { agc, end } = settledGain({ levelStaleSec: Infinity });
        expect(10 * Math.log10(agc.levelPower)).toBeGreaterThan(-30); // estimate still stuck at the loud moment
        expect(end).toBeLessThan(12);
    });

    it('the gain is back near where -45 dBFS speech belongs (~23 dB) within ~3 s of ordinary talk', () => {
        const { agc, t } = settledGain();
        const loudEnd = at(2 * 4.5 + 1);
        const b = Math.floor((loudEnd + at(3 * 4.5)) / QUANTUM); // 3 utterances later
        expect(t.gainDb[b]).toBeGreaterThan(20);
        expect(10 * Math.log10(agc.levelPower)).toBeLessThan(-40);
    });

    it('does not move the estimate for steady speech (nothing is stale while blocks are admitted)', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        run(agc, talk(-40, 4));
        const lvl = 10 * Math.log10(agc.levelPower);
        expect(lvl).toBeGreaterThan(-41.5);
        expect(lvl).toBeLessThan(-38);
    });
});

describe('AgcProcessor - mic-volume slider in FRONT of the AGC (2026-11-11), full quiet compensation, SNR rule', () => {
    // Speech with plosive/click transients (real speech has a 12 dB+ crest), talk with gate-like silence between.
    const spiky = (db: number, crest = 12) => {
        const x = Float32Array.from(concat(...Array.from({ length: 8 }, () => concat(voice(3, db), new Float32Array(at(1.0))))));
        for (let t = 0.3; t < x.length / SR - 0.1; t += 0.37) addAt(x, click(db + crest, 3), t);
        return x;
    };
    // oldPlacement: the pre-2026-11-11 chain, boost AFTER the AGC with the limiter ceiling lowered by it.
    const measure = (x: Float32Array, micDb: number, oldPlacement = false, uncappedBoost = false) => {
        const agc = new AgcProcessor({ sampleRate: SR });
        if (oldPlacement) agc.limiterCeiling = dbToLinear(DEFAULT_LIMITER_CEILING_DB - micDb);
        else agc.setMicGainDb(micDb);
        if (uncappedBoost) { agc.targetRms = dbToLinear(DEFAULT_TARGET_DB + 5); agc.compThresholdDb = DEFAULT_COMP_THRESHOLD_DB + 5; } // the previous 0.67 x 7.5 dB
        const pre = oldPlacement ? 1 : dbToLinear(micDb);
        const post = oldPlacement ? dbToLinear(micDb) : 1;
        const o = new Float32Array(QUANTUM);
        const inp = new Float32Array(QUANTUM);
        let voiced = 0, held = 0, outS = 0, peak = 0;
        for (let b = 0; (b + 1) * QUANTUM <= x.length; b++) {
            for (let i = 0; i < QUANTUM; i++) inp[i] = x[b * QUANTUM + i] * pre;
            const r = agc.process(inp, o);
            if (b * QUANTUM > at(9) && r.voiceActive) {
                voiced++;
                if (agc.limiterGain < 0.891 || agc.compReductionDb < -1) held++;
                let s = 0;
                for (let i = 0; i < QUANTUM; i++) { const v = o[i] * post; s += v * v; peak = Math.max(peak, Math.abs(v)); }
                outS += s / QUANTUM;
            }
        }
        return { heldPct: (100 * held) / voiced, outDb: 10 * Math.log10(outS / voiced), peakDb: linearToDb(peak), gainDb: agc.gainDb };
    };

    it('100 %: wire speech about -16 dBFS with the limiter/compressor barely working (0 % at -45 / -30 / -18)', () => {
        for (const db of [-45, -30, -18]) {
            const r = measure(spiky(db), 0);
            expect(r.heldPct).toBeLessThan(20);
            expect(r.outDb).toBeGreaterThan(-18);
            expect(r.outDb).toBeLessThan(-14);
        }
    });

    it('CONTROL: the old placement at 200 % had the limiter on ~every peak (-8.5 dBFS ceiling)', () => {
        expect(measure(spiky(-43), 7.5, true).heldPct).toBeGreaterThan(55);
    });

    it('200 %: the slider never pushes into the limiter - lim_pct <= 20 %, no louder than ~1 dB over 100 %, never over -1 dBFS', () => {
        expect(MIC_BOOST_TARGET_MAX_DB).toBe(1);
        for (const db of [-45, -30, -18]) {
            const a = measure(spiky(db), 0);
            const b = measure(spiky(db), 7.5);
            expect(b.peakDb).toBeLessThanOrEqual(DEFAULT_LIMITER_CEILING_DB + 0.01);
            expect(b.heldPct).toBeLessThan(25);
            expect(b.outDb).toBeLessThan(a.outDb + 1.5);
            expect(b.outDb).toBeGreaterThan(a.outDb - 0.5);
        }
    });

    it('CONTROL: without the cap (target +5 dB at 200 %, the previous behaviour) the limiter is on most peaks', () => {
        expect(measure(spiky(-30), 7.5, false, true).heldPct).toBeGreaterThan(60);
    });

    it('a very quiet mic (-58 dBFS, in the taper) IS lifted by the slider: its pre-gain moves it into the compensated range', () => {
        const a = measure(spiky(-58), 0);
        const b = measure(spiky(-58), 7.5);
        expect(b.outDb).toBeGreaterThan(a.outDb + 3);
    });

    it('a slider CUT still turns the voice down (the AGC does not level it away)', () => {
        const a = measure(spiky(-30), 0);
        const c = measure(spiky(-30), -6);
        expect(c.outDb).toBeLessThan(a.outDb - 4);
    });

    it('anything the boost pushes past full scale is held at the -1 dBFS ceiling', () => {
        const r = measure(Float32Array.from(voice(6, -8)), 7.5);
        expect(r.peakDb).toBeLessThanOrEqual(DEFAULT_LIMITER_CEILING_DB + 0.01);
    });

    it('quiet clean speech (-45 dBFS over a -52 dBFS floor) reaches the same wire level as -30 dBFS speech', () => {
        const quiet = mix(room(36, -52, 4), spiky(-45));
        const normal = spiky(-30);
        const q = measure(quiet, 0), n = measure(normal, 0);
        expect(q.gainDb).toBeGreaterThan(28);
        expect(Math.abs(q.outDb - n.outDb)).toBeLessThan(2.5);
    });

    it('SNR rule: -30 dBFS speech over a -50 dBFS floor is not held to a plain output-noise limit (-45 dBFS, the limit before 2026-11-11, cost ~6 dB)', () => {
        const x = mix(room(14, -50, 4), concat(new Float32Array(at(0.5)), voice(13.5, -30)));
        const gain = (opts: Record<string, unknown>) => { const agc = new AgcProcessor({ sampleRate: SR, ...opts }); run(agc, x); return agc.gainDb; };
        const limitOnly = gain({ minSnrDb: Infinity, outputNoiseLimitDb: -45 });
        expect(limitOnly).toBeLessThan(11); // CONTROL: the plain limit binds (the floor tracker sits at speech - 25 = -55, so cap = 10 dB)
        expect(gain({})).toBeGreaterThan(limitOnly + 4);
    });

    it('noise alone is never lifted: with nobody talking the gain stays at unity (output = input)', () => {
        const agc = new AgcProcessor({ sampleRate: SR });
        const t = run(agc, room(20, -50, 4));
        expect(agc.gainDb).toBe(0);
        expect(Math.abs(activeLevelDb(t.out, at(5), at(20)) - -50)).toBeLessThan(3);
    });
});
