/**
 * Echo detector on synthetic SIGNALS, end to end: sample-rate audio -> the real
 * worklet source (run in a tiny AudioWorklet harness) -> 100 Hz envelopes ->
 * EchoDetector. So the envelope maths in the worklet and the correlation in the
 * detector are exercised together, on speech-like bursts rather than steady tones.
 */
import { describe, it, expect } from 'vitest';
import { ECHO_WORKLET_SOURCE, ECHO_BATCH } from './echoTap';
import { EchoDetector, evaluateEchoWindow, ECHO_FRAME_RATE, DEFAULT_ECHO_CONFIG } from './echoDetector';

const SR = 16000; // the worklet's hop is sampleRate/100, so any rate exercises the same code

function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** Speech-like: noise under bursts of ~4 Hz syllables with random loudness, separated by pauses. */
function speechLike(seconds: number, seed: number, amp: number): Float32Array {
    const r = rng(seed);
    const n = Math.floor(seconds * SR);
    const out = new Float32Array(n);
    let i = 0;
    while (i < n) {
        const wordLen = Math.floor((0.25 + r() * 0.9) * SR);
        const f = 3 + r() * 3, ph = r() * 6.28, level = 0.4 + r() * 0.6;
        for (let k = 0; k < wordLen && i < n; k++, i++) {
            const t = k / SR;
            const env = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * f * t + ph), 1.5);
            out[i] = amp * level * env * gauss(r) * 0.7;
        }
        i += Math.floor((0.2 + r() * 0.6) * SR); // pause
    }
    return out;
}

function noise(seconds: number, seed: number, amp: number): Float32Array {
    const r = rng(seed);
    const out = new Float32Array(Math.floor(seconds * SR));
    for (let i = 0; i < out.length; i++) out[i] = amp * gauss(r);
    return out;
}

function mix(...parts: Float32Array[]): Float32Array {
    const out = new Float32Array(Math.max(...parts.map(p => p.length)));
    for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
    return out;
}

function delayScaled(x: Float32Array, delaySec: number, gain: number): Float32Array {
    const d = Math.round(delaySec * SR);
    const out = new Float32Array(x.length);
    for (let i = d; i < x.length; i++) out[i] = gain * x[i - d];
    return out;
}

const dbToLin = (db: number) => Math.pow(10, db / 20);

/** Run the real worklet source over two signals, 128 samples at a time; returns the envelope frames it posts. */
function envelopes(far: Float32Array, near: Float32Array): { far: Float32Array; near: Float32Array } {
    let Proc: (new () => { process(inputs: Float32Array[][]): boolean; port: { postMessage(m: unknown): void } }) | null = null;
    const posted: { far: Float32Array; near: Float32Array }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- running the worklet source in a harness is the point of this test
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', ECHO_WORKLET_SOURCE)(
        class { port = { postMessage: (m: unknown) => posted.push(m as { far: Float32Array; near: Float32Array }) }; },
        (_name: string, c: typeof Proc) => { Proc = c; },
        SR,
    );
    const p = new Proc!();
    const n = Math.min(far.length, near.length);
    for (let o = 0; o + 128 <= n; o += 128) {
        p.process([[far.subarray(o, o + 128)], [near.subarray(o, o + 128)]]);
    }
    const total = posted.length * ECHO_BATCH;
    const f = new Float32Array(total), m = new Float32Array(total);
    posted.forEach((b, i) => { f.set(b.far, i * ECHO_BATCH); m.set(b.near, i * ECHO_BATCH); });
    return { far: f, near: m };
}

/** Feed the detector in 200 ms pushes, as the worklet would; returns the detection and the second it was made. */
function run(far: Float32Array, near: Float32Array, valid: (sec: number) => boolean = () => true) {
    const env = envelopes(far, near);
    const det = new EchoDetector();
    for (let i = 0; i + ECHO_BATCH <= env.far.length; i += ECHO_BATCH) {
        const sec = i / ECHO_FRAME_RATE;
        const found = det.push(env.far.subarray(i, i + ECHO_BATCH), env.near.subarray(i, i + ECHO_BATCH), valid(sec));
        if (found) return { found, atSec: sec };
    }
    return { found: null, atSec: -1 };
}

const SECONDS = 45;
const FLOOR = 0.0008; // the microphone's own noise

describe('echo detector - synthetic signals', () => {
    it('pure echo at 180 ms, -15 dB -> detected, at about 180 ms', () => {
        const far = speechLike(SECONDS, 11, 0.06);
        const near = mix(delayScaled(far, 0.18, dbToLin(-15)), noise(SECONDS, 12, FLOOR));
        const { found, atSec } = run(far, near);
        expect(found).not.toBeNull();
        expect(Math.abs(found!.delayMs - 180)).toBeLessThanOrEqual(30);
        expect(found!.corr).toBeGreaterThan(DEFAULT_ECHO_CONFIG.minCorr);
        expect(found!.speechSec).toBeGreaterThanOrEqual(5);
        expect(found!.windows).toBeGreaterThanOrEqual(DEFAULT_ECHO_CONFIG.requiredStreak);
        // sustained evidence, not instant: needs the history floor (10 s) and three windows
        expect(atSec).toBeGreaterThan(10);
        expect(atSec).toBeLessThan(40);
    });

    it('finds other delays too (60 ms and 400 ms), and a weaker -25 dB echo', () => {
        for (const [delay, db, seed] of [[0.06, -15, 21], [0.4, -15, 22], [0.25, -25, 23]] as const) {
            const far = speechLike(SECONDS, seed, 0.06);
            const near = mix(delayScaled(far, delay, dbToLin(db)), noise(SECONDS, seed + 100, FLOOR));
            const { found } = run(far, near);
            expect(found, `delay ${delay} s at ${db} dB`).not.toBeNull();
            expect(Math.abs(found!.delayMs - delay * 1000)).toBeLessThanOrEqual(30);
        }
    });

    it('uncorrelated noise at the microphone -> no detection', () => {
        for (const seed of [31, 32, 33]) {
            const far = speechLike(SECONDS, seed, 0.06);
            expect(run(far, noise(SECONDS, seed + 100, 0.01)).found, `steady noise, seed ${seed}`).toBeNull();
            // ...and an independent talker in the room (someone else's speech-like envelope)
            expect(run(far, mix(speechLike(SECONDS, seed + 200, 0.03), noise(SECONDS, seed + 300, FLOOR))).found, `independent speech, seed ${seed}`).toBeNull();
        }
    });

    it('double-talk (loud local speech over a faint echo) -> no detection', () => {
        for (const seed of [41, 42, 43]) {
            const far = speechLike(SECONDS, seed, 0.06);
            const local = speechLike(SECONDS, seed + 500, 0.06);
            const near = mix(delayScaled(far, 0.18, dbToLin(-15)), local, noise(SECONDS, seed + 600, FLOOR));
            expect(run(far, near).found, `seed ${seed}`).toBeNull();
        }
    });

    it('far end silent -> no detection, whatever the microphone does', () => {
        const silentFar = noise(SECONDS, 51, 0.0002);
        expect(run(silentFar, mix(speechLike(SECONDS, 52, 0.05), noise(SECONDS, 53, FLOOR))).found).toBeNull();
        expect(run(silentFar, noise(SECONDS, 54, 0.01)).found).toBeNull();
        expect(run(new Float32Array(SECONDS * SR), new Float32Array(SECONDS * SR)).found).toBeNull();
    });

    it('frames marked invalid (muted / deafened / echo cancellation on) never count', () => {
        const far = speechLike(SECONDS, 61, 0.06);
        const near = mix(delayScaled(far, 0.18, dbToLin(-15)), noise(SECONDS, 62, FLOOR));
        expect(run(far, near, () => false).found).toBeNull();
        // positive control: the same signals, valid, ARE detected
        expect(run(far, near, () => true).found).not.toBeNull();
        // muted for the first 20 s only: still detected once the mic opens and evidence builds
        const late = run(far, near, sec => sec >= 20);
        expect(late.found).not.toBeNull();
        expect(late.atSec).toBeGreaterThan(20);
    });

    it('the echo stops (user turns echo cancellation on) -> a reset detector starts clean', () => {
        const far = speechLike(SECONDS, 71, 0.06);
        const near = mix(delayScaled(far, 0.18, dbToLin(-15)), noise(SECONDS, 72, FLOOR));
        const env = envelopes(far, near);
        const det = new EchoDetector();
        let got = false;
        for (let i = 0; i + ECHO_BATCH <= env.far.length && !got; i += ECHO_BATCH) got = !!det.push(env.far.subarray(i, i + ECHO_BATCH), env.near.subarray(i, i + ECHO_BATCH));
        expect(got).toBe(true);
        expect(det.detection).not.toBeNull();
        det.reset();
        expect(det.detection).toBeNull();
        // after the reset, with an echo-free mic, nothing fires
        const clean = envelopes(far, noise(SECONDS, 73, FLOOR));
        for (let i = 0; i + ECHO_BATCH <= clean.far.length; i += ECHO_BATCH) {
            expect(det.push(clean.far.subarray(i, i + ECHO_BATCH), clean.near.subarray(i, i + ECHO_BATCH))).toBeNull();
        }
    });
});

describe('evaluateEchoWindow', () => {
    it('refuses a window that is too short to mean anything', () => {
        const x = new Float32Array(50), v = new Uint8Array(50).fill(1);
        expect(evaluateEchoWindow(x, x, v)).toBeNull();
    });

    it('the worklet posts 100 envelope frames per second per input (hop = 10 ms)', () => {
        const env = envelopes(noise(2, 1, 0.1), noise(2, 2, 0.1));
        expect(env.far.length).toBeGreaterThanOrEqual(190);
        expect(env.far.length).toBeLessThanOrEqual(200);
        // RMS of unit-scale noise at 0.1 is about 0.1
        const mean = env.far.reduce((a, b) => a + b, 0) / env.far.length;
        expect(mean).toBeGreaterThan(0.08);
        expect(mean).toBeLessThan(0.12);
    });
});
