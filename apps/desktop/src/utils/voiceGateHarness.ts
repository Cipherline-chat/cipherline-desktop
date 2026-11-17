/**
 * Offline replay harness for the AUTO voice gate (the `GATE_WORKLET_SOURCE` worklet in voiceProcessor.ts).
 *
 * It feeds the REAL worklet source (loaded the way voiceGateAuto.test.ts does) synthetic speech-over-noise signals
 * that are parameterised by the statistics a diagnostic `mic_level` window exports (speech level `speech_db`, voiced
 * duty cycle `talk_pct`) plus an ASSUMED noise floor (the floor is not exported by 0.1.0), and scores what the gate
 * did: how much speech it cut (false close) and how much noise it passed (false open).
 *
 * Honest limits (see docs/worklog/entries/2026-11-16-gate-data-tune.md): real windows are 30 s aggregates, so the
 * per-syllable dynamics here are a MODEL (syllable level N(0, 3.5 dB) clipped to +-9 dB, consonants ~14 dB under the
 * nucleus, word-final syllables 4-8 dB lower, 3 dB declination per phrase), not measured; the floor is a grid.
 * The harness is for ranking constants against each other, not for predicting an absolute cut rate.
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

/** Build a gate from worklet source. `overrides` set own properties after construction (AUTO_* constants etc.). */
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

export interface WindowResult {
    /** Share of voiced-nucleus blocks the gate had mostly closed (block gain < 0.5): the false-close rate. */
    cutNucleus: number;
    /** Same for consonant / transition blocks (word starts, fricatives, tails). */
    cutCons: number;
    /** All speech blocks: share cut, and energy lost (1 - out/in energy) in dB. */
    cutSpeech: number;
    lossDb: number;
    /** Steady-noise pass: share of far-gap blocks (>= 0.7 s after speech, no event) with block gain > 0.5. */
    passSteady: number;
    /** Event pass: output/input energy ratio over breath / key-click blocks in far gaps (0..1); NaN when none. */
    passEvent: number;
    /** Gate open share of the whole window after warm-up, as the worklet's own gateStats tally reports it (compare with `gate_pct`). */
    gateOpen: number;
    /** Mean threshold in force, tracked floor and tracked speech level (dBFS) after warm-up. */
    effDb: number; floorTr: number; speechTr: number;
    nNuc: number; nCons: number; nGap: number; nEvt: number;
}

export function runWindow(source: string, msgs: Array<Record<string, unknown>>, overrides: Record<string, number>, spec: WindowSpec, warmSec = 8): WindowResult {
    const s = synth(spec);
    const g = loadGate(source, msgs, overrides);
    // Run in 1 s chunks so the tracker state (floor, speech estimate, threshold in force) can be sampled.
    const y = new Float32Array(s.blocks * Q);
    let trF = 0, trS = 0, trT = 0, trN = 0;
    for (let c = 0; c * SR < y.length; c++) {
        const a = c * SR, b = Math.min(y.length, a + SR);
        y.set(g.run(s.x.subarray(a, b)), a);
        if (c >= warmSec) { trF += g.node.floorDb as number; trS += g.node.speechDb as number; trT += g.node.effDb as number; trN++; }
    }
    let nN = 0, cN = 0, nC = 0, cC = 0, eIn = 0, eOut = 0, nG = 0, pG = 0, evIn = 0, evOut = 0, nE = 0;
    const b0 = Math.round(warmSec * SR / Q);
    for (let b = b0; b < s.blocks; b++) {
        let ei = 0, eo = 0;
        for (let i = b * Q; i < (b + 1) * Q; i++) { ei += s.x[i] * s.x[i]; eo += y[i] * y[i]; }
        const gain = Math.sqrt(eo / Math.max(ei, 1e-20));
        const m = s.speech[b];
        if (m === 2) { nN++; if (gain < 0.5) cN++; }
        else if (m === 1) { nC++; if (gain < 0.5) cC++; }
        if (m) { eIn += ei; eOut += eo; }
        if (!m && s.sinceSpeech[b] >= 0.7) {
            if (s.event[b]) { evIn += ei; evOut += eo; nE++; }
            else { nG++; if (gain > 0.5) pG++; }
        }
    }
    const stats = g.posted.filter(m => m.type === 'gateStats') as Array<{ open: number; total: number }>;
    const st = stats.slice(Math.round(warmSec));
    const gateOpen = st.length ? st.reduce((a, m) => a + m.open / m.total, 0) / st.length : NaN;
    const effDb = trN ? trT / trN : NaN;
    return {
        cutNucleus: nN ? cN / nN : NaN, cutCons: nC ? cC / nC : NaN,
        cutSpeech: nN + nC ? (cN + cC) / (nN + nC) : NaN,
        lossDb: eIn > 0 ? 10 * Math.log10(Math.max(eOut / eIn, 1e-6)) : NaN,
        passSteady: nG ? pG / nG : NaN,
        passEvent: nE ? evOut / Math.max(evIn, 1e-20) : NaN,
        gateOpen, effDb, floorTr: trN ? trF / trN : NaN, speechTr: trN ? trS / trN : NaN, nNuc: nN, nCons: nC, nGap: nG, nEvt: nE,
    };
}

/** Voiced bursts (glottal-ish, 25 harmonics, 125 Hz) of 0.3 s every 0.4 s at `db` RMS over the burst. */
export function voicedBursts(sec: number, db: number): Float32Array {
    const y = new Float32Array(Math.round(sec * SR));
    let ph = 0;
    for (let i = 0; i < y.length; i++) {
        ph += 125 / SR; ph -= Math.floor(ph);
        let v = 0; for (let h = 1; h <= 25; h++) v += Math.sin(2 * Math.PI * h * ph) / h;
        const k = (i / SR) % 0.4;
        y[i] = k < 0.3 ? v * Math.min(1, Math.min(k, 0.3 - k) / 0.02) : 0;
    }
    let s = 0, n = 0; for (let i = 0; i < y.length; i++) if (y[i] !== 0) { s += y[i] * y[i]; n++; }
    const g = dbToLin(db) / Math.sqrt(s / n);
    for (let i = 0; i < y.length; i++) y[i] *= g;
    return y;
}

/**
 * A talker at `speechDb` for 12 s, then ONLY a second voice `offsetDb` under them for 6 s (a TV, a person across the
 * room), over a steady floor. Returns the share of the second voice's energy the gate passed (0..1) after 1 s.
 */
export function backgroundVoicePass(source: string, overrides: Record<string, number>, speechDb: number, offsetDb: number, floorDb: number): number {
    const r = rng(5);
    const talk = voicedBursts(12, speechDb), bg = voicedBursts(6, speechDb - offsetDb);
    const n1 = steadyNoise(talk.length, floorDb, r), n2 = steadyNoise(bg.length, floorDb, r);
    const x = new Float32Array(talk.length + bg.length);
    for (let i = 0; i < talk.length; i++) x[i] = talk[i] + n1[i];
    for (let i = 0; i < bg.length; i++) x[talk.length + i] = bg[i] + n2[i];
    const g = loadGate(source, [{ type: 'gate', enabled: true }, { type: 'threshold', value: -45 }, { type: 'auto', value: true }], overrides);
    const y = g.run(x);
    let ei = 0, eo = 0;
    for (let i = talk.length + SR; i < y.length; i++) { ei += x[i] * x[i]; eo += y[i] * y[i]; }
    return eo / Math.max(ei, 1e-20);
}

export { linToDb };
