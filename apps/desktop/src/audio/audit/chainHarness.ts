/**
 * Offline replay of the WHOLE outgoing voice chain (audit 2026-11-17): the real worklet sources and kernels, in
 * the order voiceProcessor.ts wires them, fed a signal and instrumented block by block.
 *
 *   input -> [Strong: rnnoise-inline-worklet | Light: speex-light-worklet | Off] -> gate-worklet (GATE_WORKLET_SOURCE)
 *         -> mic volume (slider ^ 1.25, as micSliderToGain) -> AgcProcessor (agcKernel.js) -> out
 *
 * EQ (flat by default) and the DynamicsCompressorNode (ratio 1, transparent) are not modelled. Chromium's own
 * capture processing (AEC3) and the Opus encoder are not modelled either.
 *
 * Extends the gate-only replay of claude/gate-data-tune (utils/voiceGateHarness.ts, whose loadGate it uses) to the
 * NS and AGC stages around the gate. Test-only: nothing in the app imports this file. Used by audioAudit.sweep.test.ts (skipped unless AUDIO_AUDIT).
 */
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgcProcessor } from '../agcKernel.js';
import { loadGate } from '../../utils/voiceGateHarness';

export const SR = 48000;
export const Q = 128;

// ── Worklet loading ──────────────────────────────────────────────────────────

export type Proc = {
    port: { onmessage: ((m: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
    process: (i: Float32Array[][], o: Float32Array[][]) => boolean;
    [k: string]: unknown;
};

const g = globalThis as unknown as Record<string, unknown>;

/** Load an ES-module worklet source (Speex / RNNoise) through a temp file, the way noiseSuppressionWorklets.test.ts does. */
export async function loadModuleWorklet(src: string, name: string, processorOptions: Record<string, unknown> = {}): Promise<Proc> {
    let Ctor: (new (opts?: unknown) => Proc) | undefined;
    g.registerProcessor = (n: string, c: unknown) => { if (n === name) Ctor = c as typeof Ctor; };
    g.AudioWorkletProcessor = class {
        _msgs: unknown[] = [];
        port = { onmessage: null, postMessage: (m: unknown) => { this._msgs.push(m); } };
    };
    g.sampleRate = SR;
    const f = join(tmpdir(), `audit-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(f, src);
    try { await import(/* @vite-ignore */ `file://${f}`); } finally { unlinkSync(f); }
    if (!Ctor) throw new Error(`${name} did not register`);
    return new Ctor({ processorOptions });
}


export const waitFor = async (cond: () => boolean, ms = 8000) => {
    for (let t = 0; t < ms && !cond(); t += 20) await new Promise(r => setTimeout(r, 20));
    if (!cond()) throw new Error('timed out waiting for worklet');
};

// ── Chain ────────────────────────────────────────────────────────────────────

export type NsMode = 'off' | 'light' | 'strong';
export type GateMode = 'off' | 'manual';

/** The new audio engine ('v2', crates/cl-audio via cl-audio-worklet): one stage in place of NS + gate + mic gain + AGC. */
export type EngineProfile = 'light' | 'off';

export interface ChainConfig {
    /** 'v2' runs ONLY the cl-audio worklet (profile + `agc` as auto gain + `slider` as manual gain when AGC is off); ns / gate are ignored. */
    engine?: 'v2';
    /** v2 noise profile (default 'light'). */
    profile?: EngineProfile;
    ns: NsMode;
    gate: GateMode;
    /** Fixed threshold, dBFS (default -45, the app's default). */
    gateThresholdDb?: number;
    agc: boolean;
    /** Mic volume slider, 0..200 (100 = unity). */
    slider?: number;
    /** Gate worklet source to use (default: the app's GATE_WORKLET_SOURCE, passed in by the caller). */
    gateSource: string;
    /** Own-property overrides on the gate worklet after construction (positive controls). */
    gateOverrides?: Record<string, number>;
    /** AgcProcessor options (positive controls). */
    agcOpts?: Record<string, unknown>;
    /** A different AgcProcessor class (e.g. a previous release's agcKernel.js, for before/after samples). */
    agcClass?: typeof AgcProcessor;
    /** Feed exact zeros (a muted track) for these [startSec, endSec) spans. */
    muted?: Array<[number, number]>;
}

export interface NsSources { light: string; strong: string; speexWasm: () => ArrayBuffer; clAudio?: { source: string; wasm: ArrayBuffer } }

export interface ChainTrace {
    out: Float32Array;
    /** Per 128-sample block. */
    gateGain: Float32Array;
    gateOpen: Uint8Array;
    gateThrDb: Float32Array;
    agcGainDb: Float32Array;
    agcVoice: Uint8Array;
    agcLimHeld: Uint8Array;
    /** The gate's input (NS output) — for NS-only measurements. */
    nsOut: Float32Array;
}

const MIC_GAIN_EXPONENT = 1.25;
export const micSliderToGain = (slider: number) => Math.pow(Math.max(0, slider) / 100, MIC_GAIN_EXPONENT);

type LegacyChain = Awaited<ReturnType<typeof buildLegacyChain>>;

/** The chain for `cfg`. With engine 'v2' the result has the same shape, but `gate`, `agc` and `gatePosted` are null: that
 *  chain is the cl-audio worklet alone (callers that read them are legacy-only). */
export async function buildChain(cfg: ChainConfig, ns: NsSources): Promise<LegacyChain> {
    if (cfg.engine === 'v2') return buildV2Chain(cfg, ns) as unknown as LegacyChain;
    return buildLegacyChain(cfg, ns);
}

async function buildLegacyChain(cfg: ChainConfig, ns: NsSources) {
    let nsNode: Proc | null = null;
    if (cfg.ns === 'light') {
        nsNode = await loadModuleWorklet(ns.light, 'speex-light-worklet');
        nsNode.port.onmessage!({ data: { type: 'init', wasm: ns.speexWasm() } });
        await waitFor(() => !!nsNode!.ready);
        nsNode.port.onmessage!({ data: { type: 'toggle', enabled: true } });
    } else if (cfg.ns === 'strong') {
        nsNode = await loadModuleWorklet(ns.strong, 'rnnoise-inline-worklet');
        await waitFor(() => !!nsNode!.rnnoiseReady);
        nsNode.port.onmessage!({ data: { type: 'compGain', value: 1.496 } });
        nsNode.port.onmessage!({ data: { type: 'toggle', enabled: true } });
    }
    // The gate is loaded by the gate-data-tune harness (voiceGateHarness.loadGate), with the messages init() sends.
    const loaded = loadGate(cfg.gateSource, [
        { type: 'gate', enabled: cfg.gate !== 'off' },
        { type: 'threshold', value: cfg.gateThresholdDb ?? -45 },
        { type: 'hold', ms: 150 },
    ], cfg.gateOverrides ?? {});
    const gate = loaded.node;
    /** Everything the gate worklet posted (gateStats once a second, with GateCutMeter's counts). */
    const gatePosted = loaded.posted;
    const agc = new (cfg.agcClass ?? AgcProcessor)({ sampleRate: SR, enabled: cfg.agc, ...(cfg.agcOpts ?? {}) });
    const slider = cfg.slider ?? 100;
    const micGain = micSliderToGain(slider);
    agc.setMicGainDb(20 * Math.log10(Math.max(micGain, 1e-9)));

    function run(x: Float32Array): ChainTrace {
        const blocks = Math.floor(x.length / Q);
        const n = blocks * Q;
        const out = new Float32Array(n);
        const nsOut = new Float32Array(n);
        const tr: ChainTrace = {
            out, nsOut,
            gateGain: new Float32Array(blocks), gateOpen: new Uint8Array(blocks),
            gateThrDb: new Float32Array(blocks),
            agcGainDb: new Float32Array(blocks), agcVoice: new Uint8Array(blocks), agcLimHeld: new Uint8Array(blocks),
        };
        const a = new Float32Array(Q), b = new Float32Array(Q), c = new Float32Array(Q);
        const zero = new Float32Array(Q);
        const isMuted = (k: number) => (cfg.muted ?? []).some(([a, b]) => k * Q >= a * SR && k * Q < b * SR);
        for (let k = 0; k < blocks; k++) {
            const inp = isMuted(k) ? zero : x.subarray(k * Q, (k + 1) * Q);
            if (nsNode) nsNode.process([[inp]], [[a]]); else a.set(inp);
            nsOut.set(a, k * Q);
            gate.process([[a]], [[b]]);
            tr.gateGain[k] = gate.gain as number;
            tr.gateOpen[k] = (gate.holdLeft as number) > 0 ? 1 : 0;
            tr.gateThrDb[k] = cfg.gate === 'manual' ? (cfg.gateThresholdDb ?? -45) : NaN;
            for (let i = 0; i < Q; i++) b[i] *= micGain;
            const r = agc.process(b, c);
            tr.agcGainDb[k] = r.gainDb;
            tr.agcVoice[k] = r.voiceActive ? 1 : 0;
            tr.agcLimHeld[k] = (agc.limiterGain < 0.891 || agc.compReductionDb < -1) ? 1 : 0;
            out.set(c, k * Q);
        }
        return tr;
    }
    return { run, gate, agc, nsNode, gatePosted };
}

// ── Signals ──────────────────────────────────────────────────────────────────

export function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
export const dbToLin = (db: number) => Math.pow(10, db / 20);
export const linToDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

export function rmsOf(a: Float32Array, s = 0, e = a.length): number {
    let t = 0; const lo = Math.max(0, s), hi = Math.min(a.length, e);
    for (let i = lo; i < hi; i++) t += a[i] * a[i];
    return Math.sqrt(t / Math.max(1, hi - lo));
}

/** Gaussian-ish white noise (sum of uniforms). */
function white(n: number, r: () => number): Float32Array {
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) { let u = 0; for (let k = 0; k < 4; k++) u += r(); y[i] = (u - 2) * 1.732; }
    return y;
}
function normalise(y: Float32Array, db: number): Float32Array {
    const k = dbToLin(db) / Math.max(rmsOf(y), 1e-20);
    for (let i = 0; i < y.length; i++) y[i] *= k;
    return y;
}

export type NoiseKind = 'none' | 'hiss' | 'fan' | 'hum';

/** Steady background: 'hiss' = white with a gentle 100 Hz high-pass (preamp hiss); 'fan' = pink-ish, low-passed at
 *  ~1.5 kHz, plus a weak 120 Hz blade tone (a PC fan / AC unit). RMS = `db`. */
export function background(kind: NoiseKind, n: number, db: number, seed = 3): Float32Array {
    if (kind === 'none') return new Float32Array(n);
    const r = rng(seed);
    const w = white(n, r);
    const y = new Float32Array(n);
    if (kind === 'hiss') {
        let px = 0, py = 0; const a = Math.exp(-2 * Math.PI * 100 / SR);
        for (let i = 0; i < n; i++) { py = a * (py + w[i] - px); px = w[i]; y[i] = py; }
    } else {
        // Paul Kellet's economy pink filter, then a one-pole low-pass at 1.5 kHz
        let b0 = 0, b1 = 0, b2 = 0, lp = 0; const al = 1 - Math.exp(-2 * Math.PI * 1500 / SR);
        for (let i = 0; i < n; i++) {
            b0 = 0.99765 * b0 + w[i] * 0.0990460; b1 = 0.96300 * b1 + w[i] * 0.2965164; b2 = 0.57000 * b2 + w[i] * 1.0526913;
            const p = b0 + b1 + b2 + w[i] * 0.1848;
            lp += al * (p - lp);
            y[i] = lp;
        }
    }
    if (kind === 'hum') {
        // the fan above plus mains hum: 60 Hz and its harmonics up to 600 Hz (ground loop / USB interface / AC unit),
        // the hum carrying half the noise power. Periodic, so a pitch detector can take it for a voice.
        const f = background('fan', n, 0, seed + 1);
        for (let i = 0; i < n; i++) {
            let h = 0; for (let k = 1; k <= 10; k++) h += Math.sin(2 * Math.PI * 60 * k * i / SR + k) / k;
            y[i] = f[i] * 0.707 + h * 0.707 / 0.9;
        }
    }
    return normalise(y, db);
}

/** Breath: band-passed (400-2500 Hz) noise, raised-cosine envelope, `dur` s, RMS over the burst = `db`. */
export function breath(dur: number, db: number, seed: number): Float32Array {
    const n = Math.round(dur * SR), r = rng(seed), w = white(n, r), y = new Float32Array(n);
    let lp1 = 0, lp2 = 0; const a1 = 1 - Math.exp(-2 * Math.PI * 2500 / SR), a2 = 1 - Math.exp(-2 * Math.PI * 400 / SR);
    for (let i = 0; i < n; i++) { lp1 += a1 * (w[i] - lp1); lp2 += a2 * (lp1 - lp2); y[i] = (lp1 - lp2) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)); }
    return normalise(y, db);
}

/** Key clicks: `count` 6 ms exponentially decaying broadband bursts, ~9/s, burst-peak RMS = `db`. */
export function keyClicks(count: number, db: number, seed: number): Float32Array {
    const r = rng(seed), gap = Math.round(SR / 9), n = gap * count + SR / 10, y = new Float32Array(n);
    const cl = Math.round(0.006 * SR);
    let one: Float32Array | null = null;
    for (let c = 0; c < count; c++) {
        // Integer index: `gap / 2` alone is 2666.5 at 48 kHz, and a Float32Array silently ignores a write to a fractional
        // index, so before 2026-11-18 every click was dropped (the audit's "key clicks in the pauses" never sounded).
        const at = c * gap + Math.round((r() - 0.5) * gap * 0.5) + Math.round(gap / 2);
        const w = white(cl, r);
        for (let i = 0; i < cl; i++) w[i] *= Math.exp(-i / (0.0012 * SR));
        if (!one) one = w;
        for (let i = 0; i < cl && at + i < n; i++) y[at + i] += w[i] * (0.6 + 0.4 * r());
    }
    // scale so a single click's 6 ms RMS is `db`
    const k = dbToLin(db) / Math.max(rmsOf(one!), 1e-20);
    for (let i = 0; i < n; i++) y[i] *= k;
    return y;
}

/**
 * Whisper stand-in: a 4-band noise vocoder of real speech (300-1k, 1-2k, 2-4k, 4-8k Hz). Each band of white noise follows
 * that band's 5 ms envelope in the speech, so it has the speech's timing and spectral shape and no pitch at all, which is
 * what a whisper is to a denoiser.
 */
export function whisperize(speech: Float32Array, seed = 17): Float32Array {
    const n = speech.length, r = rng(seed), out = new Float32Array(n);
    const bands: Array<[number, number]> = [[300, 1000], [1000, 2000], [2000, 4000], [4000, 8000]];
    const bp = (x: Float32Array, lo: number, hi: number) => {
        // two one-pole high-passes at lo, two one-pole low-passes at hi
        const y = new Float32Array(x.length);
        const ah = Math.exp(-2 * Math.PI * lo / SR), al = 1 - Math.exp(-2 * Math.PI * hi / SR);
        let h1 = 0, h1x = 0, h2 = 0, h2x = 0, l1 = 0, l2 = 0;
        for (let i = 0; i < x.length; i++) {
            h1 = ah * (h1 + x[i] - h1x); h1x = x[i];
            h2 = ah * (h2 + h1 - h2x); h2x = h1;
            l1 += al * (h2 - l1); l2 += al * (l1 - l2);
            y[i] = l2;
        }
        return y;
    };
    const noise = white(n, r);
    for (const [lo, hi] of bands) {
        const sb = bp(speech, lo, hi), nb = bp(noise, lo, hi);
        const nr = Math.max(rmsOf(nb), 1e-20);
        for (let s0 = 0; s0 < n; s0 += LF) {
            const e = Math.min(n, s0 + LF), env = rmsOf(sb, s0, e) / nr;
            for (let i = s0; i < e; i++) out[i] += nb[i] * env;
        }
    }
    return out;
}

/** Active-speech level of a clean signal (P.56 flavour): power mean over 10 ms frames within 30 dB of its loudest. */
export function activeLevelDb(x: Float32Array): number {
    const f = 480, lv: number[] = [];
    for (let i = 0; i + f <= x.length; i += f) lv.push(rmsOf(x, i, i + f));
    const top = [...lv].sort((p, q) => q - p)[Math.floor(lv.length * 0.01)] ?? 0;
    const thr = top * dbToLin(-30);
    let s = 0, k = 0;
    for (const v of lv) if (v >= thr) { s += v * v; k++; }
    return 10 * Math.log10(Math.max(s / Math.max(1, k), 1e-24));
}

export function scaleTo(x: Float32Array, activeDb: number): Float32Array {
    const k = dbToLin(activeDb - activeLevelDb(x));
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] * k;
    return y;
}

// ── Speech labels (from the CLEAN speech) ───────────────────────────────────

export interface SpeechLabels {
    /** 5 ms frames: 0 pause, 1 speech (within 25 dB of active level), 2 nucleus (within 12 dB). */
    frame: Uint8Array;
    /** Per onset: the first sample where the word is clearly audible (a 5 ms frame within 15 dB of the active level
     *  inside 300 ms), or -1 when it never is. */
    audibleAt: number[];
    /** Sample index of each phrase onset / end (a speech run after / before >= 200 ms of pause). */
    onsets: number[];
    ends: number[];
    /** Per 5 ms frame, samples to the nearest speech frame (for "pause" regions). */
    distToSpeech: Float32Array;
}
export const LF = 240; // 5 ms label frame

export function labelSpeech(clean: Float32Array): SpeechLabels {
    const act = activeLevelDb(clean);
    const nF = Math.floor(clean.length / LF);
    const frame = new Uint8Array(nF);
    const lvl = new Float32Array(nF);
    for (let f = 0; f < nF; f++) {
        const l = linToDb(rmsOf(clean, f * LF, (f + 1) * LF));
        frame[f] = l >= act - 12 ? 2 : l >= act - 25 ? 1 : 0;
        lvl[f] = l;
    }
    // bridge 1-2 frame dropouts inside speech so a stop consonant does not split a phrase
    const onsets: number[] = [], ends: number[] = [];
    const minPause = 40; // 200 ms
    let lastSpeech = -1e9;
    for (let f = 0; f < nF; f++) {
        if (frame[f] > 0) {
            if (f - lastSpeech > minPause) onsets.push(f * LF);
            lastSpeech = f;
        }
    }
    let nextSpeech = 1e9;
    for (let f = nF - 1; f >= 0; f--) {
        if (frame[f] > 0) {
            if (nextSpeech - f > minPause) ends.push((f + 1) * LF);
            nextSpeech = f;
        }
    }
    ends.reverse();
    const dist = new Float32Array(nF).fill(1e9);
    let last = -1e9;
    for (let f = 0; f < nF; f++) { if (frame[f] > 0) last = f; dist[f] = (f - last) * LF; }
    last = 1e9;
    for (let f = nF - 1; f >= 0; f--) { if (frame[f] > 0) last = f; dist[f] = Math.min(dist[f], (last - f) * LF); }
    const audibleAt = onsets.map(on => {
        for (let f = on / LF; f < on / LF + 60 && f < nF; f++) if (lvl[f] >= act - 15) return f * LF;
        return -1; // a soft sound (a breath in the recording) that never becomes a word: not scored as an onset
    });
    return { frame, onsets, ends, distToSpeech: dist, audibleAt };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface Metrics {
    /** Onsets measured. */
    onsets: number;
    /** Mean / p90 ms from the moment a phrase is clearly audible (within 15 dB of the active level) until the gate is
     *  at least half open (0 = open already): audible speech lost at each phrase start. */
    gateOnsetMs: number; gateOnsetP90Ms: number;
    /** Phrase onsets that lost more than 20 ms to the gate. */
    onsetsClipped: number;
    /** Output vs input energy in the first 80 ms of each phrase from its audible point, relative to the phrase cores
     *  (dB, < 0 = lost). */
    onsetLossDb: number;
    /** Same for the last 120 ms before each phrase end. */
    tailLossDb: number;
    /** Share of syllable-nucleus frames where the gate was under half open (%). */
    nucleusCutPct: number;
    /** Share of all speech frames where the gate was under half open (%). */
    speechCutPct: number;
    /** Gate closes (gain falling through 0.5) that happen INSIDE a phrase, per minute of speech. */
    midPhraseClosesPerMin: number;
    /** Gate opens per second inside pauses (>= 300 ms from speech): chatter on noise/breath/keys. */
    pauseOpensPerSec: number;
    /** Output level in pauses >= 300 ms from speech, and in the 50-450 ms right after a phrase end (dBFS). */
    pauseNoiseDb: number; tailNoiseDb: number;
    /** Output active speech level (dBFS) and output speech-to-pause ratio (dB). */
    outSpeechDb: number; outSnrDb: number;
    /** AGC: compressor/limiter held >= 1 dB on voiced blocks (%), share of output samples at the -1 dBFS ceiling (%). */
    limPct: number; ceilPct: number;
    /** AGC total gain: sd over speech blocks (dB) and the p95-p5 spread inside phrase cores (dB). */
    gainSdDb: number; gainSpreadDb: number;
    /** sd of 20 ms output frame levels in pauses (dB): chatter / bubbling of what is left between words. */
    pauseLevelSdDb: number;
    /** Samples whose sign flipped against the input while |input| > 0.5 (int16 wrap). */
    polarityFlips: number;
    /** NS-stage signal-to-distortion on 10 ms frames whose input peaks over full scale: count, median, p10 (dB). */
    overFsFrames: number; overFsSdrDb: number; overFsSdrP10Db: number;
    /** Gate open share overall (%). */
    gateOpenPct: number;
    /** Gate threshold in force: median in the steady half (dBFS). */
    thrMedianDb: number;
}

function pct(arr: number[], p: number): number {
    if (!arr.length) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

/**
 * Score one run. `lagIn` = samples the NS stage delays the signal (the gate trace and the output are aligned to the
 * input with it). `from` = first sample scored (skip warm-up).
 */
export function score(input: Float32Array, lab: SpeechLabels, tr: ChainTrace, lagIn: number, from: number): Metrics {
    const out = tr.out;
    const blockAt = (sample: number) => Math.floor((sample + lagIn) / Q);
    const gGain = (sample: number) => tr.gateGain[Math.min(tr.gateGain.length - 1, Math.max(0, blockAt(sample)))];
    const nF = lab.frame.length;
    const outRms = (s: number, e: number) => rmsOf(out, s + lagIn, e + lagIn);

    // Reference transmission: median over phrase-core nucleus frames of out/in (dB)
    const core: number[] = [];
    for (let f = Math.ceil(from / LF); f < nF; f++) {
        if (lab.frame[f] === 2 && lab.distToSpeech[f] === 0) {
            const s = f * LF, e = s + LF;
            core.push(linToDb(outRms(s, e)) - linToDb(rmsOf(input, s, e)));
        }
    }
    const ref = pct(core, 50);

    const onsetMs: number[] = []; let clipped = 0; const onLoss: number[] = [];
    lab.onsets.forEach((on, idx) => {
        if (on < from) return;
        const aud = lab.audibleAt[idx];
        if (aud < 0) return;
        let k = 0;
        while (k < SR * 0.4 && gGain(aud + k) < 0.5) k += Q;
        const ms = (k / SR) * 1000;
        onsetMs.push(ms);
        if (ms > 20) clipped++;
        const e = aud + Math.round(0.08 * SR);
        onLoss.push(linToDb(outRms(aud, e)) - linToDb(rmsOf(input, aud, e)) - ref);
    });
    const tailLoss: number[] = [];
    for (const en of lab.ends) {
        if (en < from) continue;
        const s = en - Math.round(0.12 * SR);
        tailLoss.push(linToDb(outRms(s, en)) - linToDb(rmsOf(input, s, en)) - ref);
    }

    let nuc = 0, nucCut = 0, sp = 0, spCut = 0;
    for (let f = Math.ceil(from / LF); f < nF; f++) {
        if (lab.frame[f] === 0) continue;
        const cut = gGain(f * LF + LF / 2) < 0.5;
        sp++; if (cut) spCut++;
        if (lab.frame[f] === 2) { nuc++; if (cut) nucCut++; }
    }

    // gate transitions
    let midCloses = 0, pauseOpens = 0, pauseSec = 0, speechSec = 0;
    const b0 = blockAt(from);
    const frameOfBlock = (k: number) => Math.floor((k * Q - lagIn) / LF);
    for (let k = Math.max(1, b0); k < tr.gateGain.length; k++) {
        const f = frameOfBlock(k);
        if (f < 0 || f >= nF) continue;
        const inPause = lab.distToSpeech[f] >= 0.3 * SR;
        const inPhrase = lab.distToSpeech[f] < 0.2 * SR && lab.frame[f] > 0;
        if (inPause) pauseSec += Q / SR;
        if (lab.frame[f] > 0) speechSec += Q / SR;
        const was = tr.gateGain[k - 1] >= 0.5, is = tr.gateGain[k] >= 0.5;
        if (was && !is && inPhrase) midCloses++;
        if (!was && is && inPause) pauseOpens++;
    }

    // noise in pauses / tails, output speech level
    let pN = 0, pS = 0, tN = 0, tS = 0, sN = 0, sS = 0;
    const pauseLv: number[] = [];
    const tailMask = new Uint8Array(nF);
    for (const en of lab.ends) {
        const a = Math.floor((en + 0.05 * SR) / LF), b = Math.floor((en + 0.45 * SR) / LF);
        for (let f = a; f < b && f < nF; f++) if (lab.frame[f] === 0) tailMask[f] = 1;
    }
    for (let f = Math.ceil(from / LF); f < nF; f++) {
        const r = outRms(f * LF, (f + 1) * LF), p = r * r;
        if (lab.distToSpeech[f] >= 0.3 * SR) { pN++; pS += p; }
        if (tailMask[f]) { tN++; tS += p; }
        if (lab.frame[f] > 0) { sN++; sS += p; }
    }
    for (let f = Math.ceil(from / LF); f + 4 <= nF; f += 4) {
        let ok = true; for (let j = 0; j < 4; j++) if (lab.distToSpeech[f + j] < 0.3 * SR) ok = false;
        if (ok) pauseLv.push(linToDb(outRms(f * LF, (f + 4) * LF)));
    }
    const mean = pauseLv.reduce((a, b) => a + b, 0) / Math.max(1, pauseLv.length);
    const pauseSd = Math.sqrt(pauseLv.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, pauseLv.length));

    // AGC
    let voiced = 0, held = 0; const gains: number[] = []; const coreGains: number[] = [];
    for (let k = b0; k < tr.agcGainDb.length; k++) {
        if (tr.agcVoice[k]) { voiced++; if (tr.agcLimHeld[k]) held++; }
        const f = frameOfBlock(k);
        if (f >= 0 && f < nF && lab.frame[f] > 0) gains.push(tr.agcGainDb[k]);
        if (f >= 0 && f < nF && lab.frame[f] === 2) coreGains.push(tr.agcGainDb[k]);
    }
    const gm = gains.reduce((a, b) => a + b, 0) / Math.max(1, gains.length);
    const gsd = Math.sqrt(gains.reduce((a, b) => a + (b - gm) ** 2, 0) / Math.max(1, gains.length));
    let ceil = 0, flips = 0;
    for (let i = from + lagIn; i < out.length; i++) {
        if (Math.abs(out[i]) >= 0.88) ceil++;
        const x = input[i - lagIn];
        if (Math.abs(x) > 0.5 && Math.sign(tr.nsOut[i]) !== Math.sign(x) && Math.abs(tr.nsOut[i]) > 0.3) flips++;
    }
    // Signal-to-distortion of the NS stage on frames whose INPUT peaks over full scale (10 ms frames): the NS output
    // against the best scaled copy of its input. Clean processing reads 15-30 dB; int16 wrap or clipping reads ~0-10.
    const sdrs: number[] = [];
    for (let s0 = from; s0 + 480 <= input.length - lagIn; s0 += 480) {
        let pk = 0; for (let i = s0; i < s0 + 480; i++) pk = Math.max(pk, Math.abs(input[i]));
        if (pk <= 1) continue;
        let xy = 0, xx = 0, yy = 0;
        for (let i = s0; i < s0 + 480; i++) { const a = input[i], b = tr.nsOut[i + lagIn]; xy += a * b; xx += a * a; yy += b * b; }
        const k = xy / Math.max(xx, 1e-20), err = Math.max(yy - 2 * k * xy + k * k * xx, 1e-20);
        sdrs.push(10 * Math.log10((k * k * xx) / err));
    }
    let open = 0, tot = 0; const thr: number[] = [];
    for (let k = b0; k < tr.gateGain.length; k++) { tot++; if (tr.gateGain[k] >= 0.5) open++; if (Number.isFinite(tr.gateThrDb[k])) thr.push(tr.gateThrDb[k]); }

    const avg = (a: number[]) => a.reduce((p, q) => p + q, 0) / Math.max(1, a.length);
    return {
        onsets: onsetMs.length,
        gateOnsetMs: avg(onsetMs), gateOnsetP90Ms: pct(onsetMs, 90), onsetsClipped: clipped,
        onsetLossDb: avg(onLoss), tailLossDb: avg(tailLoss),
        nucleusCutPct: (100 * nucCut) / Math.max(1, nuc), speechCutPct: (100 * spCut) / Math.max(1, sp),
        midPhraseClosesPerMin: midCloses / Math.max(1e-9, speechSec / 60),
        pauseOpensPerSec: pauseOpens / Math.max(1e-9, pauseSec),
        pauseNoiseDb: 10 * Math.log10(Math.max(pS / Math.max(1, pN), 1e-24)),
        tailNoiseDb: 10 * Math.log10(Math.max(tS / Math.max(1, tN), 1e-24)),
        outSpeechDb: 10 * Math.log10(Math.max(sS / Math.max(1, sN), 1e-24)),
        outSnrDb: 10 * Math.log10(Math.max(sS / Math.max(1, sN), 1e-24)) - 10 * Math.log10(Math.max(pS / Math.max(1, pN), 1e-24)),
        limPct: (100 * held) / Math.max(1, voiced), ceilPct: (100 * ceil) / Math.max(1, out.length - from),
        gainSdDb: gsd, gainSpreadDb: pct(coreGains, 95) - pct(coreGains, 5),
        pauseLevelSdDb: pauseSd,
        polarityFlips: flips,
        overFsFrames: sdrs.length, overFsSdrDb: pct(sdrs, 50), overFsSdrP10Db: pct(sdrs, 10),
        gateOpenPct: (100 * open) / Math.max(1, tot),
        thrMedianDb: pct(thr, 50),
    };
}

/** Lag (samples) of y against x, 0..maxLag, by cross-correlation over [a, a + n). */
export function measureLag(x: Float32Array, y: Float32Array, a: number, n: number, maxLag = 3000): number {
    let best = -Infinity, lag = 0;
    for (let l = 0; l <= maxLag; l++) {
        let c = 0; for (let i = 0; i < n; i += 3) c += x[a + i] * y[a + i + l];
        if (c > best) { best = c; lag = l; }
    }
    return lag;
}

// ── Spectral fluctuation of residual noise (musical noise / bubbling) ────────

function fft(re: Float64Array, im: Float64Array) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let j = 0; j < len / 2; j++) {
                const ur = re[i + j], ui = im[i + j];
                const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
                re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
                const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
        }
    }
}

/**
 * Median over 300 Hz-6 kHz bins of the sd (dB) of each bin's level over time, 1024-pt Hann STFT, hop 512, on the
 * samples in [s, e). Gaussian noise reads ~5.6 dB; isolated tonal blips that come and go (musical noise) read higher.
 */
export function spectralFluctuationDb(x: Float32Array, s: number, e: number): number {
    const N = 1024, H = 512, lo = Math.round(300 / (SR / N)), hi = Math.round(6000 / (SR / N));
    const frames: Float64Array[] = [];
    const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    for (let p = s; p + N <= e; p += H) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = x[p + i] * w[i];
        fft(re, im);
        const lv = new Float64Array(hi - lo);
        for (let b = lo; b < hi; b++) lv[b - lo] = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-30);
        frames.push(lv);
    }
    if (frames.length < 4) return NaN;
    const sds: number[] = [];
    for (let b = 0; b < hi - lo; b++) {
        let m = 0; for (const f of frames) m += f[b]; m /= frames.length;
        let v = 0; for (const f of frames) v += (f[b] - m) ** 2;
        sds.push(Math.sqrt(v / frames.length));
    }
    return pct(sds, 50);
}

// ── WAV (32-bit float) ───────────────────────────────────────────────────────

export function writeWavF32(path: string, x: Float32Array, sr = SR): void {
    const data = Buffer.from(x.buffer, x.byteOffset, x.byteLength);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34);
    h.write('data', 36); h.writeUInt32LE(data.length, 40);
    writeFileSync(path, Buffer.concat([h, data]));
}

// ── New audio engine ─────────────────────────────────────────────────────────

/** The v2 chain: cl-audio-worklet alone, driven in 128-sample quanta exactly as the render thread would. The returned
 *  object mirrors buildChain's (run / nsNode) so callers can treat both alike; gate / agc are absent. */
async function buildV2Chain(cfg: ChainConfig, ns: NsSources) {
    if (!ns.clAudio) throw new Error('buildChain: engine v2 needs NsSources.clAudio');
    const slider = cfg.slider ?? 100;
    const settings = {
        noise: cfg.profile === 'off' ? 0 : 1,
        autoGain: cfg.agc,
        manualGainDb: cfg.agc ? 0 : 20 * Math.log10(Math.max(micSliderToGain(slider), 1e-9)),
        originalSound: false,
    };
    const node = await loadModuleWorklet(ns.clAudio.source, 'cl-audio-worklet', { wasmBytes: ns.clAudio.wasm.slice(0), settings });
    await waitFor(() => !!node.ready || !!node.failed, 20000);
    if (!node.ready) throw new Error('cl-audio-worklet did not come up');
    let lastGain = 0;
    let seen = 0;
    function run(x: Float32Array): ChainTrace {
        const blocks = Math.floor(x.length / Q);
        const n = blocks * Q;
        const out = new Float32Array(n);
        const tr: ChainTrace = {
            out, nsOut: out,
            gateGain: new Float32Array(blocks).fill(1), gateOpen: new Uint8Array(blocks).fill(1), gateThrDb: new Float32Array(blocks).fill(NaN),
            agcGainDb: new Float32Array(blocks), agcVoice: new Uint8Array(blocks), agcLimHeld: new Uint8Array(blocks),
        };
        const a = new Float32Array(Q);
        const msgs = (node as unknown as { _msgs: Array<{ type?: string; deviceGainDb?: number; speechProb?: number }> })._msgs;
        for (let k = 0; k < blocks; k++) {
            node.process([[x.subarray(k * Q, (k + 1) * Q)]], [[a]]);
            out.set(a, k * Q);
            for (; seen < msgs.length; seen++) {
                const m = msgs[seen];
                if (m.type === 'stats' && typeof m.deviceGainDb === 'number') lastGain = m.deviceGainDb;
            }
            tr.agcGainDb[k] = lastGain; // the engine's learned device gain, as of its last once-a-second report
        }
        return tr;
    }
    return { run, nsNode: node, gate: null, agc: null, gatePosted: null };
}
