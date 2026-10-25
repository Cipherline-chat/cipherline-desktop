/**
 * Custom entrance sound: the signal processing, as pure functions over mono
 * Float32 PCM at 48 kHz, so all of it is unit-tested in node. Decoding,
 * resampling and encoding need WebAudio / WebCodecs and live in ./browser.ts.
 *
 * Pipeline (processClip):
 *   trim to the chosen window (<= 2.5 s)
 *   -> loudness-normalize to TARGET_LUFS (integrated, BS.1770 K-weighting)
 *   -> true-peak limit to TRUE_PEAK_CEILING_DB (4x oversampled detection,
 *      lookahead gain, never a clip)
 *   -> FADE_MS raised-cosine fade in and out.
 * (Downmix to mono and the resample to 48 kHz happen before, in browser.ts:
 * downmix() is here so it is tested.)
 *
 * ── The loudness measurement, and where it is an approximation ─────────────
 * integratedLoudness() is ITU-R BS.1770-4 for ONE channel: the two K-weighting
 * biquads (high shelf + RLB high-pass, coefficients derived for any rate the
 * way libebur128 does, exact at 48 kHz), mean square over 400 ms blocks with
 * 75 % overlap, the -70 LUFS absolute gate and the -10 LU relative gate. It is
 * an approximation of a full meter in two ways, both irrelevant at this scale:
 *   - a clip shorter than one 400 ms block is measured as ONE block of its own
 *     length (BS.1770 needs at least one full block);
 *   - the block grid starts at sample 0 and drops a trailing partial block.
 * Mono means channel weight 1, so the result is directly comparable to what
 * a stereo meter reads for the same signal on one channel.
 *
 * ── True peak ──────────────────────────────────────────────────────────────
 * truePeak() follows BS.1770 Annex 2 in spirit: 4x oversampling through a
 * 48-tap windowed-sinc interpolator (12 taps per phase), max |value| over the
 * original and interpolated points. The limiter is offline (the whole clip is
 * in memory), so it is a zero-latency "lookahead" with a symmetric window:
 *   req[n] = min(1, ceiling / tpEnv[n])
 *   m[n]   = min of req over [n-L, n+L]
 *   g[n]   = mean of m over [n-L, n+L]
 * Every m[k] in n's window is <= req[n] (n is inside k's window), so g[n] <=
 * req[n] everywhere: the gain is smooth AND always at least as low as the
 * peak needs. The interpolated peaks of x*g can still differ slightly from
 * g * peaks(x) where g bends, so the result is re-measured and the pass repeated
 * (at most a few times); a final static scale guarantees the ceiling.
 */

import {
    FADE_MS, MAX_CLIP_SAMPLES, MAX_NORMALIZE_GAIN_DB, MIN_CLIP_SECONDS, SAMPLE_RATE, TARGET_LUFS, TRUE_PEAK_CEILING_DB,
} from './constants';

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity);

// ── channels ────────────────────────────────────────────────────────────────

/** Average the channels into one. A single channel is returned as a copy. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
    if (channels.length === 0) return new Float32Array(0);
    const n = Math.min(...channels.map(c => c.length));
    const out = new Float32Array(n);
    const k = 1 / channels.length;
    for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
    return out;
}

/**
 * The window [startS, startS + lengthS) clamped to the source and to
 * MAX_CLIP_SAMPLES. Throws on a window that ends up shorter than
 * MIN_CLIP_SECONDS (start past the end, zero length).
 */
export function trimWindow(mono: Float32Array, startS: number, lengthS: number, sampleRate = SAMPLE_RATE): Float32Array {
    if (!Number.isFinite(startS) || !Number.isFinite(lengthS)) throw new Error('bad window');
    const start = Math.max(0, Math.min(mono.length, Math.round(startS * sampleRate)));
    const want = Math.max(0, Math.round(lengthS * sampleRate));
    const end = Math.min(mono.length, start + Math.min(want, Math.round(MAX_CLIP_SAMPLES * (sampleRate / SAMPLE_RATE))));
    if (end - start < Math.round(MIN_CLIP_SECONDS * sampleRate)) throw new Error('window too short');
    return mono.slice(start, end);
}

// ── K-weighting + integrated loudness ───────────────────────────────────────

export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** The two BS.1770 K-weighting stages for `fs` (libebur128's derivation). */
export function kWeightingFilters(fs: number): [Biquad, Biquad] {
    // Stage 1: high shelf (+4 dB above ~1.7 kHz, the head's acoustic effect).
    const f0 = 1681.974450955533;
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf: Biquad = {
        b0: (Vh + Vb * K / Q + K * K) / a0,
        b1: 2 * (K * K - Vh) / a0,
        b2: (Vh - Vb * K / Q + K * K) / a0,
        a1: 2 * (K * K - 1) / a0,
        a2: (1 - K / Q + K * K) / a0,
    };
    // Stage 2: RLB high-pass (~38 Hz).
    const f1 = 38.13547087602444;
    const Q1 = 0.5003270373238773;
    K = Math.tan(Math.PI * f1 / fs);
    a0 = 1 + K / Q1 + K * K;
    const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q1 + K * K) / a0 };
    return [shelf, hp];
}

function runBiquad(x: Float32Array | Float64Array, f: Biquad): Float64Array {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
        const x0 = x[i];
        const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        y[i] = y0;
    }
    return y;
}

export const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const BLOCK_S = 0.4;
const HOP_S = 0.1;

const blockLoudness = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);

/** Integrated loudness in LUFS (mono; see the header for the approximation). -Infinity for silence. */
export function integratedLoudness(x: Float32Array, fs = SAMPLE_RATE): number {
    if (x.length === 0) return -Infinity;
    const [shelf, hp] = kWeightingFilters(fs);
    const y = runBiquad(runBiquad(x, shelf), hp);
    const block = Math.round(BLOCK_S * fs);
    const hop = Math.round(HOP_S * fs);
    const powers: number[] = [];
    const meanSq = (from: number, to: number) => {
        let s = 0;
        for (let i = from; i < to; i++) s += y[i] * y[i];
        return s / (to - from);
    };
    if (y.length < block) powers.push(meanSq(0, y.length));
    else for (let start = 0; start + block <= y.length; start += hop) powers.push(meanSq(start, start + block));

    const gated = powers.filter(p => p > 0 && blockLoudness(p) > ABSOLUTE_GATE_LUFS);
    if (gated.length === 0) return -Infinity;
    const absMean = gated.reduce((a, b) => a + b, 0) / gated.length;
    const relGate = blockLoudness(absMean) + RELATIVE_GATE_LU;
    const final = gated.filter(p => blockLoudness(p) > relGate);
    if (final.length === 0) return -Infinity;
    return blockLoudness(final.reduce((a, b) => a + b, 0) / final.length);
}

// ── true peak ───────────────────────────────────────────────────────────────

const OVERSAMPLE = 4;
const HALF_TAPS = 6; // 12 taps per phase, 48 in all

/** Phase p (1..OVERSAMPLE-1) coefficients for offsets j = -HALF_TAPS+1 .. HALF_TAPS. */
const PHASES: Float64Array[] = (() => {
    const out: Float64Array[] = [];
    for (let p = 1; p < OVERSAMPLE; p++) {
        const frac = p / OVERSAMPLE;
        const c = new Float64Array(2 * HALF_TAPS);
        let sum = 0;
        for (let k = 0; k < 2 * HALF_TAPS; k++) {
            const j = k - HALF_TAPS + 1; // tap at x[n + j]
            const t = j - frac;          // distance from the interpolated point
            const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
            const w = 0.5 * (1 + Math.cos(Math.PI * t / HALF_TAPS)); // Hann over |t| <= HALF_TAPS
            c[k] = sinc * w;
            sum += c[k];
        }
        for (let k = 0; k < c.length; k++) c[k] /= sum; // unity at DC
        out.push(c);
    }
    return out;
})();

/**
 * Per-sample true-peak envelope: env[n] = max |value| over sample n and the
 * interpolated points on both sides of it.
 */
export function truePeakEnvelope(x: Float32Array): Float64Array {
    const n = x.length;
    const env = new Float64Array(n);
    for (let i = 0; i < n; i++) env[i] = Math.abs(x[i]);
    for (let i = 0; i < n - 1; i++) {
        // points between x[i] and x[i+1]
        for (const c of PHASES) {
            let v = 0;
            for (let k = 0; k < c.length; k++) {
                const idx = i + k - HALF_TAPS + 1;
                if (idx >= 0 && idx < n) v += x[idx] * c[k];
            }
            const a = Math.abs(v);
            if (a > env[i]) env[i] = a;
            if (a > env[i + 1]) env[i + 1] = a;
        }
    }
    return env;
}

/** Max true peak (linear). */
export function truePeak(x: Float32Array): number {
    const env = truePeakEnvelope(x);
    let m = 0;
    for (let i = 0; i < env.length; i++) if (env[i] > m) m = env[i];
    return m;
}

export function samplePeak(x: Float32Array): number {
    let m = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
    return m;
}

/** Sliding min over [i-r, i+r] (monotonic deque, O(n)). */
function slidingMin(v: Float64Array, r: number): Float64Array {
    const n = v.length;
    const out = new Float64Array(n);
    const dq = new Int32Array(n);
    let head = 0, tail = 0, next = 0;
    for (let i = 0; i < n; i++) {
        const hi = Math.min(n - 1, i + r);
        while (next <= hi) {
            while (tail > head && v[dq[tail - 1]] >= v[next]) tail--;
            dq[tail++] = next++;
        }
        while (dq[head] < i - r) head++;
        out[i] = v[dq[head]];
    }
    return out;
}

/** Box average over [i-r, i+r] (clamped at the edges). */
function boxAverage(v: Float64Array, r: number): Float64Array {
    const n = v.length;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + v[i];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
        out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    }
    return out;
}

/** Lookahead radius: 5 ms each side, so a gain change is spread over ~10 ms. */
const LIMITER_RADIUS_S = 0.005;

/**
 * Bring the true peak down to `ceilingDb` with a smooth gain envelope (see the
 * header). Returns a new buffer; never clips.
 */
export function limitTruePeak(x: Float32Array, ceilingDb = TRUE_PEAK_CEILING_DB, fs = SAMPLE_RATE): Float32Array {
    const ceiling = dbToGain(ceilingDb);
    const r = Math.max(1, Math.round(LIMITER_RADIUS_S * fs));
    let y = Float32Array.from(x);
    for (let pass = 0; pass < 4; pass++) {
        const env = truePeakEnvelope(y);
        let over = false;
        const req = new Float64Array(env.length);
        for (let i = 0; i < env.length; i++) {
            req[i] = env[i] > ceiling ? ceiling / env[i] : 1;
            if (env[i] > ceiling) over = true;
        }
        if (!over) return y;
        const g = boxAverage(slidingMin(req, r), r);
        const next = new Float32Array(y.length);
        for (let i = 0; i < y.length; i++) next[i] = y[i] * g[i];
        y = next;
    }
    // Belt and braces: whatever is left over goes away with one static scale.
    const tp = truePeak(y);
    if (tp > ceiling) {
        // Float32 rounding of the product must not land a hair over again.
        const k = (ceiling / tp) * (1 - 1e-6);
        for (let i = 0; i < y.length; i++) y[i] *= k;
    }
    return y;
}

// ── loudness normalization + fades ──────────────────────────────────────────

/** Scale to `targetLufs` (gain capped at MAX_NORMALIZE_GAIN_DB). Throws on silence. */
export function normalizeLoudness(x: Float32Array, targetLufs = TARGET_LUFS, fs = SAMPLE_RATE): { out: Float32Array; gainDb: number; measured: number } {
    const measured = integratedLoudness(x, fs);
    if (!Number.isFinite(measured)) throw new Error('silent');
    const gainDb = Math.min(MAX_NORMALIZE_GAIN_DB, targetLufs - measured);
    const g = dbToGain(gainDb);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
    return { out, gainDb, measured };
}

/** Raised-cosine fade in over the first and out over the last `fadeMs` (in place). */
export function applyFades(x: Float32Array, fadeMs = FADE_MS, fs = SAMPLE_RATE): Float32Array {
    const n = Math.min(Math.floor(x.length / 2), Math.round((fadeMs / 1000) * fs));
    if (n < 1) return x;
    for (let i = 0; i < n; i++) {
        // 0 at the very first / last sample, 1 at the inner edge.
        const w = 0.5 * (1 - Math.cos(Math.PI * (i / n)));
        x[i] *= w;
        x[x.length - 1 - i] *= w;
    }
    return x;
}

export interface ProcessedClip {
    /** Mono PCM at SAMPLE_RATE, ready to encode. */
    pcm: Float32Array;
    durationMs: number;
    /** Integrated loudness before / after. */
    inputLufs: number;
    outputLufs: number;
    /** True peak after limiting, dBTP. */
    truePeakDb: number;
}

/**
 * The whole chain on a mono 48 kHz source: trim, normalize, limit, fade.
 * Throws 'window too short' / 'silent'.
 */
export function processClip(mono48k: Float32Array, startS: number, lengthS: number): ProcessedClip {
    const clip = trimWindow(mono48k, startS, lengthS, SAMPLE_RATE);
    const { out, measured } = normalizeLoudness(clip, TARGET_LUFS, SAMPLE_RATE);
    const limited = limitTruePeak(out, TRUE_PEAK_CEILING_DB, SAMPLE_RATE);
    applyFades(limited, FADE_MS, SAMPLE_RATE);
    return {
        pcm: limited,
        durationMs: Math.round((limited.length / SAMPLE_RATE) * 1000),
        inputLufs: measured,
        outputLufs: integratedLoudness(limited, SAMPLE_RATE),
        truePeakDb: gainToDb(truePeak(limited)),
    };
}

/**
 * `buckets` peak magnitudes (0..1) across the source, for the waveform strip.
 * Cheap: one pass, max |x| per bucket.
 */
export function waveformPeaks(mono: Float32Array, buckets: number): Float32Array {
    const out = new Float32Array(Math.max(0, buckets));
    if (mono.length === 0 || buckets <= 0) return out;
    const per = mono.length / buckets;
    for (let b = 0; b < buckets; b++) {
        const from = Math.floor(b * per), to = Math.max(from + 1, Math.floor((b + 1) * per));
        let m = 0;
        for (let i = from; i < to && i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > m) m = a; }
        out[b] = Math.min(1, m);
    }
    return out;
}
