/**
 * Offline replay helpers for the voice gate (the `GATE_WORKLET_SOURCE` worklet in voiceProcessor.ts): load the REAL
 * worklet source with the messages init() sends (`loadGate`), and synthetic speech-over-noise signals with labelled
 * nuclei / consonants / breath and key-click events (`synth`). Built by the 2026-11-16 gate-data-tune round for the
 * automatic gate; since that gate was removed (2026-11-17) only these generic parts remain, used by the call-audio audit
 * harness (src/audio/audit/).
 *
 * The speech model is a MODEL (syllable level N(0, 3.5 dB) clipped to +-9 dB, consonants ~14 dB under the nucleus,
 * word-final syllables 4-8 dB lower, 3 dB declination per phrase), not measured speech.
 *
 * Test-only: nothing in the app imports this file.
 */

export const SR = 48000;
export const Q = 128;

export type GateNode = {
    port: { onmessage: ((e: { data: unknown }) => void) | null };
    process(i: Float32Array[][], o: Float32Array[][]): boolean;
    [k: string]: unknown;
};

export interface LoadedGate {
    node: GateNode;
    posted: Array<Record<string, unknown>>;
    /** Run a signal through the gate (multiple of 128 samples), return the output. */
    run(x: Float32Array): Float32Array;
}

/** Build a gate from worklet source. `overrides` set own properties after construction (e.g. holdTotal, releaseRate). */
export function loadGate(source: string, msgs: Array<Record<string, unknown>>, overrides: Record<string, number> = {}): LoadedGate {
    let Ctor: (new () => GateNode) | undefined;
    const posted: Array<Record<string, unknown>> = [];
    class Base { port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: Record<string, unknown>) => { posted.push(m); } }; }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(Base, (_n: string, c: new () => GateNode) => { Ctor = c; }, SR);
    const node = new Ctor!();
    for (const m of msgs) node.port.onmessage!({ data: m });
    for (const [k, v] of Object.entries(overrides)) node[k] = v;
    const o = new Float32Array(Q);
    const run = (x: Float32Array): Float32Array => {
        const out = new Float32Array(x.length - (x.length % Q));
        for (let b = 0; (b + 1) * Q <= x.length; b++) {
            node.process([[x.subarray(b * Q, (b + 1) * Q)]], [[o]]);
            out.set(o, b * Q);
        }
        return out;
    };
    return { node, posted, run };
}

// ── Deterministic randomness ────────────────────────────────────────────────
export function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function gauss(r: () => number): number {
    const u = Math.max(1e-9, r()), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

/** Steady coloured noise (one-pole low-pass of white) at `db` RMS. */
export function steadyNoise(n: number, db: number, r: () => number): Float32Array {
    const y = new Float32Array(n);
    let lp = 0, s = 0;
    for (let i = 0; i < n; i++) { lp += 0.35 * ((r() * 2 - 1) - lp); y[i] = lp; s += lp * lp; }
    const g = dbToLin(db) / Math.sqrt(s / n);
    for (let i = 0; i < n; i++) y[i] *= g;
    return y;
}

export type EventKind = 'none' | 'breath' | 'keys' | 'both';

export interface WindowSpec {
    /** Speech level over voiced (nucleus) blocks, dBFS: what `speech_db` reports (RMS, gate input domain). */
    speechDb: number;
    /** Share of time in voiced nuclei (`talk_pct / 100`). Gaps are capped at `maxGapSec` (6 s), so low duties are only approximated unless it is raised. */
    duty: number;
    /** Assumed noise floor at the gate input, dBFS RMS. */
    floorDb: number;
    seconds?: number;
    seed?: number;
    events?: EventKind;
    /** Syllable level spread (dB, sigma). Default 3.5. */
    sigmaDb?: number;
    /** Longest pause between phrases (s). Default 6; raise it (and `seconds`) to reproduce a very low duty cycle. */
    maxGapSec?: number;
    /** Phrase-to-phrase level spread (dB, sigma, clipped +-14): a talker who is loud, then quiet, over a minute. Default 0. */
    phraseSigmaDb?: number;
    /** Raise the breath / key-click events by this many dB (default 0: breaths at speech-22, keys at speech-16). */
    eventBoostDb?: number;
}

export interface Synth {
    x: Float32Array;
    /** Per 128-block: 0 none, 1 consonant/transition, 2 voiced nucleus (clean speech block RMS >= floor + 3 dB only). */
    speech: Uint8Array;
    /** Per block: 1 when a noise event (breath / key click) contributes more than floor + 3 dB. */
    event: Uint8Array;
    /** Per block: seconds since the last speech block (Infinity before any). */
    sinceSpeech: Float32Array;
    blocks: number;
}

/** Speech-like signal over steady noise, with optional non-speech events (breaths, key clicks) in the pauses. */
export function synth(spec: WindowSpec): Synth {
    const seconds = spec.seconds ?? 30;
    const N = Math.round(seconds * SR);
    const blocks = Math.floor(N / Q);
    const r = rng((spec.seed ?? 1) * 7919 + 13);
    const sigma = spec.sigmaDb ?? 3.5;
    const speech = new Float32Array(N); // clean speech
    const kind = new Uint8Array(N);     // 1 consonant, 2 nucleus
    const evt = new Float32Array(N);    // noise events
    const duty = Math.min(0.6, Math.max(0.05, spec.duty));
    const lead = Math.round(1.0 * SR);
    let t = lead;
    let ph = 0;
    const gaps: Array<[number, number]> = [];
    let hp = 0, prevN = 0;
    const lvl = (db: number) => dbToLin(db); // unit-RMS reference scaled later
    const addSyll = (start: number, durN: number, durC: number, nucDb: number, consDb: number, f0: number, decayDb: number, voicedCons: boolean) => {
        // consonant / transition
        for (let i = 0; i < durC; i++) {
            const k = start + i; if (k >= N) break;
            const w = Math.sin(Math.PI * (i + 0.5) / durC);
            let v: number;
            if (voicedCons) { ph += f0 / SR; ph -= Math.floor(ph); v = Math.sin(2 * Math.PI * ph) + 0.4 * Math.sin(4 * Math.PI * ph); v *= 0.8; }
            else { const nn = r() * 2 - 1; hp = nn - prevN; prevN = nn; v = hp * 0.7; }
            speech[k] = v * w * lvl(consDb); kind[k] = 1;
        }
        // nucleus: harmonic source, 15 ms attack, linear-in-dB decay
        for (let i = 0; i < durN; i++) {
            const k = start + durC + i; if (k >= N) break;
            const tt = i / durN;
            ph += f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 3 * tt)) / SR; ph -= Math.floor(ph);
            let v = 0; for (let h = 1; h <= 20; h++) v += Math.sin(2 * Math.PI * h * ph) / Math.pow(h, 1.1);
            const att = Math.min(1, i / (0.015 * SR)), rel = Math.min(1, (durN - i) / (0.02 * SR));
            speech[k] = v * att * rel * lvl(nucDb - decayDb * tt); kind[k] = 2;
        }
    };
    while (t < N) {
        const nSyl = 6 + Math.floor(r() * 10);
        const f0 = 95 + r() * 135;
        const phraseStart = t;
        const pOff = Math.max(-14, Math.min(14, gauss(r) * (spec.phraseSigmaDb ?? 0)));
        let nucTotal = 0;
        for (let s = 0; s < nSyl && t < N; s++) {
            const wordFinal = r() < 0.4;
            const durN = Math.round((0.11 + r() * 0.14) * SR);
            const durC = Math.round((0.03 + r() * 0.06) * SR);
            const dev = Math.max(-9, Math.min(9, gauss(r) * sigma));
            const decl = -3 * (s / nSyl);
            const nucDb = dev + decl + pOff - (wordFinal ? 4 + r() * 4 : 0);
            addSyll(t, durN, durC, nucDb, nucDb - 14 + gauss(r) * 3, f0 * (1 + 0.08 * Math.sin(s * 0.9)), wordFinal ? 8 : 4, r() < 0.3);
            t += durN + durC; nucTotal += durN;
            t += Math.round((wordFinal ? 0.05 + r() * 0.05 : 0.0) * SR);
        }
        const phraseLen = t - phraseStart;
        const nucShare = Math.max(0.3, nucTotal / Math.max(1, phraseLen));
        const gapMean = phraseLen * (nucShare / duty - 1);
        const gap = Math.round(Math.min((spec.maxGapSec ?? 6) * SR, Math.max(0.5 * SR, gapMean * (0.6 + 0.8 * r()))));
        gaps.push([t, Math.min(N, t + gap)]);
        t += gap;
    }
    // Calibrate: energy-mean over nucleus samples = speechDb.
    let e = 0, c = 0;
    for (let i = 0; i < N; i++) if (kind[i] === 2) { e += speech[i] * speech[i]; c++; }
    const sg = dbToLin(spec.speechDb) / Math.sqrt(e / Math.max(1, c));
    for (let i = 0; i < N; i++) speech[i] *= sg;
    // Events inside gaps (level re the speech level).
    const ev = spec.events ?? 'none';
    if (ev !== 'none') {
        for (const [g0, g1] of gaps) {
            const room = g1 - g0 - Math.round(1.6 * SR);
            if (room <= 0) continue;
            if ((ev === 'breath' || ev === 'both') && r() < 0.8) {
                const d = Math.round((0.25 + r() * 0.2) * SR), a = g0 + Math.round(0.8 * SR + r() * Math.max(0, room - d));
                const lv = dbToLin(spec.speechDb - 22 + (spec.eventBoostDb ?? 0) + gauss(r) * 3); let lp = 0;
                for (let i = 0; i < d && a + i < N; i++) { lp += 0.5 * ((r() * 2 - 1) - lp); evt[a + i] += lp * lv * 1.7 * Math.pow(Math.sin(Math.PI * (i + 0.5) / d), 2); }
            }
            if ((ev === 'keys' || ev === 'both') && r() < 0.8) {
                let a = g0 + Math.round(0.8 * SR + r() * Math.max(0, room * 0.5));
                const nClicks = 3 + Math.floor(r() * 6);
                for (let k = 0; k < nClicks && a < g1 - Math.round(0.8 * SR); k++) {
                    const lv = dbToLin(spec.speechDb - 16 + (spec.eventBoostDb ?? 0) + gauss(r) * 4), dl = Math.round(0.006 * SR);
                    for (let i = 0; i < dl && a + i < N; i++) evt[a + i] += (r() * 2 - 1) * lv * 1.9 * Math.exp(-i / (0.0015 * SR));
                    a += Math.round((0.08 + r() * 0.12) * SR);
                }
            }
        }
    }
    const noise = steadyNoise(N, spec.floorDb, rng((spec.seed ?? 1) * 104729 + 7));
    const x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = speech[i] + evt[i] + noise[i];
    // Per-block labels from the CLEAN components.
    const sp = new Uint8Array(blocks), evm = new Uint8Array(blocks), since = new Float32Array(blocks);
    const floorLin = dbToLin(spec.floorDb + 3);
    let last = -Infinity;
    for (let b = 0; b < blocks; b++) {
        let es = 0, ee = 0, n2 = 0, n1 = 0;
        for (let i = b * Q; i < (b + 1) * Q; i++) { es += speech[i] * speech[i]; ee += evt[i] * evt[i]; if (kind[i] === 2) n2++; else if (kind[i] === 1) n1++; }
        const rs = Math.sqrt(es / Q), re = Math.sqrt(ee / Q);
        if (rs >= floorLin && (n2 + n1) > Q / 4) { sp[b] = n2 >= n1 ? 2 : 1; last = b; }
        if (re >= floorLin) evm[b] = 1;
        since[b] = last === -Infinity ? Infinity : (b - last) * Q / SR;
    }
    return { x, speech: sp, event: evm, sinceSpeech: since, blocks };
}

export { linToDb };
