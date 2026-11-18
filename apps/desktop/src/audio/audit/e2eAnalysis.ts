/**
 * Analysis for the call-audio END-TO-END test (callAudioE2E.sweep.test.ts): align what a listener received over a real
 * LiveKit round trip with what the talker's chain sent and with the talker's input, and measure what the round trip
 * adds. Test-only (nothing in the app imports it). Pure functions over Float32Arrays at 48 kHz; the speech labels and the
 * level / onset / tail / pause metrics are chainHarness.ts's (labelSpeech, score), so the offline and the round-trip
 * numbers are computed by the same code.
 *
 * Alignment: a coarse lag from an FFT cross-correlation of 6 kHz block averages, refined at 48 kHz, then a lag per 1 s
 * window tracked from the previous window (the receiver's jitter buffer stretches and shrinks time, so one global lag
 * drifts). Every round-trip measurement uses the window's own lag.
 */
import { SR, Q, LF, rmsOf, linToDb, score, type SpeechLabels, type ChainTrace, type Metrics } from './chainHarness';

// ── FFT cross-correlation (coarse lag) ──────────────────────────────────────

function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let j = 0; j < len / 2; j++) {
                const a = i + j, b = a + len / 2;
                const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
                const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
        }
    }
}

function decimate(x: Float32Array, f: number): Float64Array {
    const n = Math.floor(x.length / f), y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < f; k++) s += x[i * f + k]; y[i] = s / f; }
    return y;
}

/**
 * Lag L (samples) maximising sum x[i] * y[i + L], searched over [minLag, maxLag]. y is the later copy (y[i + L] ~ x[i]).
 */
export function findLag(x: Float32Array, y: Float32Array, minLag: number, maxLag: number): { lag: number; corr: number } {
    const D = 8;
    const a = decimate(x, D), b = decimate(y, D);
    let n = 1; while (n < a.length + b.length) n <<= 1;
    const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    ar.set(a); br.set(b);
    fftInPlace(ar, ai, false); fftInPlace(br, bi, false);
    // conj(A) * B -> correlation at lag l = sum a[i] b[i + l]
    for (let i = 0; i < n; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], im = ar[i] * bi[i] - ai[i] * br[i]; ar[i] = r; ai[i] = im; }
    fftInPlace(ar, ai, true);
    let best = -Infinity, bl = 0;
    for (let l = Math.ceil(minLag / D); l <= Math.floor(maxLag / D); l++) {
        const v = ar[(l + n) % n];
        if (v > best) { best = v; bl = l; }
    }
    // refine at full rate on the loudest 4 s of x
    const coarse = bl * D;
    const win = Math.min(4 * SR, x.length);
    let s0 = 0, bestE = -1;
    for (let s = 0; s + win <= x.length; s += SR) { const e = rmsOf(x, s, s + win); if (e > bestE) { bestE = e; s0 = s; } }
    const r = refineLag(x, y, s0, win, coarse, 2 * D);
    return { lag: r.lag, corr: r.corr };
}

/** Best lag in [center - span, center + span] by direct normalised correlation over x[s, s + n). */
export function refineLag(x: Float32Array, y: Float32Array, s: number, n: number, center: number, span: number, step = 1): { lag: number; corr: number } {
    let best = -Infinity, bl = center;
    let xx = 0; for (let i = s; i < s + n; i += step) xx += x[i] * x[i];
    for (let l = center - span; l <= center + span; l++) {
        let c = 0, yy = 0;
        for (let i = s; i < s + n; i += step) {
            const j = i + l; if (j < 0 || j >= y.length) continue;
            c += x[i] * y[j]; yy += y[j] * y[j];
        }
        const v = c / Math.sqrt(Math.max(xx * yy, 1e-30));
        if (v > best) { best = v; bl = l; }
    }
    return { lag: bl, corr: best };
}

export interface LagTrack {
    /** Lag (samples) per 1 s window of x, starting at window 0. */
    lags: Int32Array;
    /** Normalised correlation per window (NaN where x was too quiet to measure and the lag was carried). */
    corr: Float32Array;
}

/** Per-1 s-window lag, each searched +-span around the previous window's (starting from `start`). */
export function trackLag(x: Float32Array, y: Float32Array, start: number, span = 240, minRms = 1e-4): LagTrack {
    const nW = Math.floor(x.length / SR);
    const lags = new Int32Array(nW), corr = new Float32Array(nW).fill(NaN);
    let cur = start;
    for (let w = 0; w < nW; w++) {
        const s = w * SR;
        if (rmsOf(x, s, s + SR) >= minRms && s + cur >= 0 && s + SR + cur + span < y.length) {
            const r = refineLag(x, y, s, SR, cur, span, 2);
            if (r.corr > 0.5) cur = r.lag;
            corr[w] = r.corr;
        }
        lags[w] = cur;
    }
    return { lags, corr };
}

/** y re-sampled onto x's time axis with the window lags (no interpolation: whole samples). */
export function alignByTrack(y: Float32Array, track: LagTrack, n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const w = Math.min(track.lags.length - 1, Math.floor(i / SR));
        const j = i + (w >= 0 ? track.lags[w] : 0);
        out[i] = j >= 0 && j < y.length ? y[j] : 0;
    }
    return out;
}

// ── Speech cut as heard (gate + NS + transport), estimated from the signal ─

/**
 * A per-128-block "is the speech getting through" gain in {0, 1} estimated from the OUTPUT against the INPUT: the block
 * is passed when out/in is within `marginDb` of the median phrase-core transmission. A closed gate sends digital zero,
 * so a cut block reads 40+ dB under; the AGC's own swings (a few dB) stay well inside the margin. Applied identically to
 * the offline output, the sent signal and the received signal, and validated against the offline gate's true gain
 * (e2eAnalysis.test.ts and the sweep's estimator check).
 */
export function passGain(input: Float32Array, out: Float32Array, lab: SpeechLabels, from: number, marginDb = 20): Float32Array {
    const core: number[] = [];
    for (let f = Math.ceil(from / LF); f < lab.frame.length; f++) {
        if (lab.frame[f] === 2 && lab.distToSpeech[f] === 0) {
            const s = f * LF;
            core.push(linToDb(rmsOf(out, s, s + LF)) - linToDb(rmsOf(input, s, s + LF)));
        }
    }
    core.sort((a, b) => a - b);
    const ref = core[Math.floor(core.length / 2)] ?? 0;
    const blocks = Math.floor(Math.min(input.length, out.length) / Q);
    const g = new Float32Array(blocks);
    for (let k = 0; k < blocks; k++) {
        const s = k * Q;
        const d = linToDb(rmsOf(out, s, s + Q)) - linToDb(rmsOf(input, s, s + Q));
        g[k] = d >= ref - marginDb ? 1 : 0;
    }
    return g;
}

/** chainHarness.score() on an already-aligned output, with the estimated pass gain standing in for the gate trace. */
export function scoreAligned(input: Float32Array, lab: SpeechLabels, out: Float32Array, from: number): Metrics {
    const n = Math.min(input.length, out.length);
    const o = out.length === n ? out : out.subarray(0, n);
    const g = passGain(input, o, lab, from);
    const blocks = g.length;
    const tr: ChainTrace = {
        out: o, nsOut: o, gateGain: g, gateOpen: new Uint8Array(blocks), gateThrDb: new Float32Array(blocks).fill(NaN),
        agcGainDb: new Float32Array(blocks), agcVoice: new Uint8Array(blocks), agcLimHeld: new Uint8Array(blocks),
    };
    return score(input.subarray(0, n), lab, tr, 0, from);
}

// ── What the round trip adds (received vs sent, both on the input's time axis) ─

export interface RoundTrip {
    /** Received speech level minus sent speech level over the scored speech frames (dB). */
    levelDeltaDb: number;
    /** 10 ms frames where the sent signal carried speech-level audio but the received one was >= 15 dB lower (count, ms, longest ms). */
    dropouts: number; dropoutMs: number; longestDropoutMs: number;
    /** Same, for frames where the sent signal was (near) silent and the received one was >= 15 dB louder and above -60 dBFS. */
    insertions: number;
    /** Median / p10 segmental SNR (received vs sent waveform, 10 ms speech frames, best of +-3 samples), dB. */
    segSnrDb: number; segSnrP10Db: number;
    /** Received minus sent energy in 4-8 kHz and 8-16 kHz over speech frames (dB): bandwidth the codec removed. */
    band4to8Db: number; band8to16Db: number;
    /** Received minus sent level in pauses >= 300 ms from speech (dB) (both near zero = NaN). */
    pauseDeltaDb: number;
}

function bandEnergy(x: Float32Array, s: number, n: number, lo: number, hi: number): number {
    // Goertzel-free: crude band energy by a 1024-pt DFT magnitude sum via the chainHarness-free FFT above
    const N = 1024; let acc = 0, frames = 0;
    const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    for (let p = s; p + N <= s + n && p + N <= x.length; p += N) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = x[p + i] * w[i];
        fftInPlace(re, im, false);
        const a = Math.round(lo / (SR / N)), b = Math.round(hi / (SR / N));
        for (let k = a; k < b; k++) acc += re[k] * re[k] + im[k] * im[k];
        frames++;
    }
    return frames ? acc / frames : 0;
}

export function roundTrip(sent: Float32Array, recv: Float32Array, lab: SpeechLabels, from: number, to = Math.min(sent.length, recv.length)): RoundTrip {
    const F = 480;
    let sS = 0, sR = 0, nS = 0;
    let pS = 0, pR = 0, nP = 0;
    const segs: number[] = [];
    let drops = 0, dropMs = 0, longest = 0, run = 0, ins = 0;
    let hs48 = 0, hr48 = 0, hs816 = 0, hr816 = 0;
    // sent active level for the "speech-level" test
    for (let s = from; s + F <= to; s += F) {
        const f = Math.floor(s / LF);
        if (f < lab.frame.length && lab.frame[f] > 0) { const a = rmsOf(sent, s, s + F); sS += a * a; nS++; const b = rmsOf(recv, s, s + F); sR += b * b; }
    }
    const sentAct = 10 * Math.log10(Math.max(sS / Math.max(1, nS), 1e-24));
    const levelDelta = 10 * Math.log10(Math.max(sR / Math.max(1, nS), 1e-24)) - sentAct;
    for (let s = from; s + F <= to; s += F) {
        const ls = linToDb(rmsOf(sent, s, s + F)), lr = linToDb(rmsOf(recv, s, s + F)) - levelDelta;
        const f = Math.floor(s / LF);
        const speechy = ls >= sentAct - 20 && ls > -60;
        if (speechy && lr < ls - 15) { run++; if (run === 1) drops++; dropMs += 10; longest = Math.max(longest, run * 10); } else run = 0;
        if (ls < -70 && lr > ls + 15 && lr > -60) ins++;
        if (f < lab.frame.length && lab.distToSpeech[f] >= 0.3 * SR) { const a = rmsOf(sent, s, s + F), b = rmsOf(recv, s, s + F); pS += a * a; pR += b * b; nP++; }
        if (speechy && f < lab.frame.length && lab.frame[f] === 2) {
            let best = -Infinity;
            const k = Math.pow(10, -levelDelta / 20);
            for (let d = -3; d <= 3; d++) {
                let e = 0, p = 0;
                for (let i = s; i < s + F; i++) { const j = i + d; const r = j >= 0 && j < recv.length ? recv[j] : 0; const err = sent[i] - r * k; e += err * err; p += sent[i] * sent[i]; }
                best = Math.max(best, 10 * Math.log10(Math.max(p, 1e-30) / Math.max(e, 1e-30)));
            }
            segs.push(best);
        }
    }
    // band energies over the loudest speech second blocks (cheap: every 4th 1024-sample block of speech)
    for (let s = from; s + 1024 <= to; s += 4096) {
        const f = Math.floor(s / LF);
        if (f >= lab.frame.length || lab.frame[f] !== 2) continue;
        hs48 += bandEnergy(sent, s, 1024, 4000, 8000); hr48 += bandEnergy(recv, s, 1024, 4000, 8000);
        hs816 += bandEnergy(sent, s, 1024, 8000, 16000); hr816 += bandEnergy(recv, s, 1024, 8000, 16000);
    }
    segs.sort((a, b) => a - b);
    const pd = nP && pS > 1e-14 * nP ? 10 * Math.log10(Math.max(pR, 1e-30) / pS) : NaN;
    return {
        levelDeltaDb: levelDelta, dropouts: drops, dropoutMs: dropMs, longestDropoutMs: longest, insertions: ins,
        segSnrDb: segs[Math.floor(segs.length / 2)] ?? NaN, segSnrP10Db: segs[Math.floor(segs.length / 10)] ?? NaN,
        band4to8Db: 10 * Math.log10(Math.max(hr48, 1e-30) / Math.max(hs48, 1e-30)),
        band8to16Db: 10 * Math.log10(Math.max(hr816, 1e-30) / Math.max(hs816, 1e-30)),
        pauseDeltaDb: pd,
    };
}

/** Level (dBFS RMS) of `x` in [s, e) relative to the same span of `ref`, for before/after windows. */
export function spanLevelDb(x: Float32Array, s: number, e: number): number {
    return linToDb(rmsOf(x, Math.max(0, s), Math.min(x.length, e)));
}

/** Longest run (ms) of |x| < 1e-6 inside [s, e): a digital gap. */
export function longestZeroRunMs(x: Float32Array, s: number, e: number): number {
    let run = 0, best = 0;
    for (let i = Math.max(0, s); i < Math.min(x.length, e); i++) { if (Math.abs(x[i]) < 1e-6) { run++; if (run > best) best = run; } else run = 0; }
    return (best / SR) * 1000;
}

/** Largest sample-to-sample jump in [s, e) (a click / discontinuity), relative to the local RMS (dB). */
export function maxStepDb(x: Float32Array, s: number, e: number): number {
    let m = 0;
    for (let i = Math.max(1, s); i < Math.min(x.length, e); i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
    return linToDb(m) - linToDb(rmsOf(x, s, e));
}
