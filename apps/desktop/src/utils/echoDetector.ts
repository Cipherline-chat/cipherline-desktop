/**
 * Acoustic-echo detector: "is what I hear from the call coming back in through
 * my microphone?" - decided locally, on level envelopes only.
 *
 * It exists for people who have echo cancellation OFF (headphones assumed, but
 * the output is really speakers): every other participant then hears their own
 * voice a little later, boosted by our AGC. We cannot hear that ourselves, so we
 * look for it: the far end's loudness over time (what we play) against our raw
 * microphone's loudness over time, and ask whether the mic envelope is a delayed,
 * scaled copy of the far-end envelope.
 *
 * Signals (both are LEVELS, never audio; see EchoTap for where they are taken):
 *   far  - RMS of the mix of everyone we are playing, per 10 ms hop (100 Hz)
 *   near - RMS of the raw microphone (before gate / NS / EQ / AGC), same hops
 *
 * Method (envelope cross-correlation, no adaptive filter, no FFT):
 *   1. keep the last 30 s of both envelopes;
 *   2. high-pass each envelope (subtract a 250 ms running mean) so slow level
 *      drift and a steady noise floor cannot correlate;
 *   3. for every candidate delay 20..500 ms take the Pearson correlation between
 *      far[n - delay] and near[n] over the frames where the far end WAS speaking
 *      (a far-end that is silent carries no echo evidence) and the frame is not
 *      dominated by the local talker (double-talk guard: near much louder than
 *      anything the far end sent recently);
 *   4. a window passes when the best delay's correlation clears the threshold, it
 *      stands clear of the correlation at all other delays (a real echo is ONE
 *      sharp peak, a shared slow trend is a plateau), the window holds enough
 *      far-end speech, and the near envelope is audibly above its own noise floor
 *      while the far end speaks;
 *   5. DETECTED only after 3 consecutive passing windows (evaluated every 2 s)
 *      at the same delay (+-30 ms): sustained evidence, not one coincidence.
 *
 * Cost: an evaluation is ~49 lags x <= 3000 frames of multiply-adds, about
 * 150 k operations, once per 2 s - noise next to one audio quantum of any
 * worklet in the voice chain. The envelope tap itself is a sum of squares per
 * sample in an AudioWorklet.
 *
 * Pure: no Web Audio, no timers, no DOM. Frames are pushed in; the host decides
 * when the detector may run (echo cancellation off, mic open, not deafened) by
 * marking frames `valid`. Unit-tested on synthetic signals in echoDetector.test.ts.
 */

export const ECHO_HOP_MS = 10;
export const ECHO_FRAME_RATE = 1000 / ECHO_HOP_MS;

export interface EchoDetectorConfig {
    /** History kept, in frames (30 s). */
    windowFrames: number;
    /** Evaluate every this many NEW frames (2 s). */
    evalEveryFrames: number;
    /** Candidate delays, in frames (20..500 ms). */
    minLag: number;
    maxLag: number;
    /** Far-end level (linear RMS) above which a frame counts as speech: about -50 dBFS. */
    farActiveRms: number;
    /** Minimum far-end speech in the window, in frames (5 s). */
    minSpeechFrames: number;
    /** Pearson correlation the best delay must reach. */
    minCorr: number;
    /** How far above the mean correlation of the OTHER delays the best must stand. */
    minProminence: number;
    /** Delays within this many frames of the best are excluded from that mean (80 ms). */
    peakExclusion: number;
    /** Consecutive passing windows required. */
    requiredStreak: number;
    /** Best delay may wander this many frames between consecutive passes (30 ms). */
    lagTolerance: number;
    /** Near level during far speech must exceed its own floor by this factor. */
    nearAboveFloor: number;
    /** Double-talk guard: a frame is skipped when the near level exceeds this x the loudest far level of the last 500 ms. */
    doubleTalkRatio: number;
}

export const DEFAULT_ECHO_CONFIG: Readonly<EchoDetectorConfig> = {
    windowFrames: 3000,
    evalEveryFrames: 200,
    minLag: 2,
    maxLag: 50,
    farActiveRms: 0.0032,
    minSpeechFrames: 500,
    minCorr: 0.45,
    minProminence: 0.25,
    peakExclusion: 8,
    requiredStreak: 3,
    lagTolerance: 3,
    nearAboveFloor: 1.5,
    doubleTalkRatio: 2.5,
};

export interface EchoEvidence {
    /** Pearson correlation at the best delay (0..1). */
    corr: number;
    /** The best delay, ms. */
    delayMs: number;
    /** Far-end speech the window held, seconds. */
    speechSec: number;
}

export interface EchoDetection extends EchoEvidence {
    /** Consecutive passing windows that led to it. */
    windows: number;
}

/** One evaluation of a history window. `null` = the window does not show an echo. */
export function evaluateEchoWindow(
    far: ArrayLike<number>,
    near: ArrayLike<number>,
    valid: ArrayLike<number>,
    cfg: Readonly<EchoDetectorConfig> = DEFAULT_ECHO_CONFIG,
): EchoEvidence | null {
    const n = far.length;
    if (n < cfg.maxLag + 60 || near.length !== n || valid.length !== n) return null;

    // High-passed envelopes: subtract a +-12 frame running mean (O(n) with prefix sums).
    const hp = (x: ArrayLike<number>): Float32Array => {
        const pre = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const lo = Math.max(0, i - 12), hi = Math.min(n, i + 13);
            out[i] = x[i] - (pre[hi] - pre[lo]) / (hi - lo);
        }
        return out;
    };
    const fh = hp(far), mh = hp(near);

    // Loudest far level over the previous 500 ms, for the double-talk guard.
    const farMax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let mx = 0;
        for (let j = Math.max(0, i - 50); j <= i; j++) if (far[j] > mx) mx = far[j];
        farMax[i] = mx;
    }
    // Near level smoothed over 100 ms (a single loud frame is not "talking").
    const nearSm = new Float32Array(n);
    {
        let acc = 0;
        for (let i = 0; i < n; i++) {
            acc += near[i];
            if (i >= 10) acc -= near[i - 10];
            nearSm[i] = acc / Math.min(i + 1, 10);
        }
    }

    // Near noise floor: the 10th percentile of the valid near levels.
    const nearLevels: number[] = [];
    for (let i = 0; i < n; i++) if (valid[i]) nearLevels.push(near[i]);
    if (nearLevels.length < cfg.minSpeechFrames) return null;
    nearLevels.sort((a, b) => a - b);
    const nearFloor = Math.max(nearLevels[Math.floor(nearLevels.length * 0.1)], 1e-5);

    const nLags = cfg.maxLag - cfg.minLag + 1;
    const corr = new Float64Array(nLags);
    const used = new Int32Array(nLags);
    const nearOnFar = new Float64Array(nLags);
    for (let li = 0; li < nLags; li++) {
        const lag = cfg.minLag + li;
        let cnt = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, nearSum = 0;
        for (let i = lag; i < n; i++) {
            const f = i - lag;
            if (!valid[i] || !valid[f] || far[f] < cfg.farActiveRms) continue;
            if (nearSm[i] > cfg.doubleTalkRatio * farMax[f] && nearSm[i] > 4 * nearFloor) continue; // local talker dominates
            const a = fh[f], b = mh[i];
            cnt++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
            nearSum += near[i];
        }
        used[li] = cnt;
        if (cnt > 1) {
            const cov = sab - (sa * sb) / cnt;
            const va = saa - (sa * sa) / cnt;
            const vb = sbb - (sb * sb) / cnt;
            corr[li] = va > 1e-12 && vb > 1e-12 ? cov / Math.sqrt(va * vb) : 0;
            nearOnFar[li] = nearSum / cnt;
        }
    }

    let best = 0;
    for (let li = 1; li < nLags; li++) if (corr[li] > corr[best]) best = li;
    if (used[best] < cfg.minSpeechFrames) return null;
    if (corr[best] < cfg.minCorr) return null;
    // One sharp peak: compare with the mean correlation at delays well away from it.
    let others = 0, nOthers = 0;
    for (let li = 0; li < nLags; li++) {
        if (Math.abs(li - best) <= cfg.peakExclusion) continue;
        others += corr[li]; nOthers++;
    }
    if (nOthers > 0 && corr[best] - others / nOthers < cfg.minProminence) return null;
    // The echo must be audible above the microphone's own floor while the far end speaks.
    if (nearOnFar[best] < cfg.nearAboveFloor * nearFloor) return null;

    return { corr: corr[best], delayMs: (cfg.minLag + best) * ECHO_HOP_MS, speechSec: used[best] / ECHO_FRAME_RATE };
}

export class EchoDetector {
    private readonly cfg: EchoDetectorConfig;
    private far: Float32Array;
    private near: Float32Array;
    private valid: Uint8Array;
    private count = 0;       // frames stored (<= windowFrames)
    private head = 0;        // next write index
    private sinceEval = 0;
    private streak = 0;
    private lastDelayFrames = -1;
    private _detected: EchoDetection | null = null;

    constructor(cfg: Partial<EchoDetectorConfig> = {}) {
        this.cfg = { ...DEFAULT_ECHO_CONFIG, ...cfg };
        const n = this.cfg.windowFrames;
        this.far = new Float32Array(n);
        this.near = new Float32Array(n);
        this.valid = new Uint8Array(n);
    }

    /** The detection, once made (latched until reset()). */
    get detection(): EchoDetection | null { return this._detected; }

    /** Forget everything (a new call, a mic restart, the user turned echo cancellation on). */
    reset(): void {
        this.count = 0; this.head = 0; this.sinceEval = 0; this.streak = 0; this.lastDelayFrames = -1;
        this.far.fill(0); this.near.fill(0); this.valid.fill(0);
        this._detected = null;
    }

    /**
     * Add frames (equal-length arrays of linear RMS, one value per 10 ms hop).
     * `valid` false marks a stretch the detector must not learn from (mic muted,
     * deafened, echo cancellation on): the frames still advance time so delays stay true.
     * Returns the detection the moment it is made, otherwise null.
     */
    push(far: ArrayLike<number>, near: ArrayLike<number>, valid = true): EchoDetection | null {
        const len = Math.min(far.length, near.length);
        const w = this.cfg.windowFrames;
        for (let i = 0; i < len; i++) {
            this.far[this.head] = far[i];
            this.near[this.head] = near[i];
            this.valid[this.head] = valid ? 1 : 0;
            this.head = (this.head + 1) % w;
            if (this.count < w) this.count++;
        }
        this.sinceEval += len;
        if (this._detected || this.sinceEval < this.cfg.evalEveryFrames || this.count < 1000) return null;
        this.sinceEval = 0;
        return this.evaluate();
    }

    private snapshot(): { far: Float32Array; near: Float32Array; valid: Uint8Array } {
        const n = this.count, w = this.cfg.windowFrames;
        const start = (this.head - n + w) % w;
        const far = new Float32Array(n), near = new Float32Array(n), valid = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const j = (start + i) % w;
            far[i] = this.far[j]; near[i] = this.near[j]; valid[i] = this.valid[j];
        }
        return { far, near, valid };
    }

    private evaluate(): EchoDetection | null {
        const { far, near, valid } = this.snapshot();
        const ev = evaluateEchoWindow(far, near, valid, this.cfg);
        if (!ev) { this.streak = 0; this.lastDelayFrames = -1; return null; }
        const delayFrames = Math.round(ev.delayMs / ECHO_HOP_MS);
        if (this.lastDelayFrames >= 0 && Math.abs(delayFrames - this.lastDelayFrames) > this.cfg.lagTolerance) this.streak = 0;
        this.streak++;
        this.lastDelayFrames = delayFrames;
        if (this.streak >= this.cfg.requiredStreak) {
            this._detected = { ...ev, windows: this.streak };
            return this._detected;
        }
        return null;
    }
}
