/**
 * AgcProcessor — the real automatic gain control the "Auto gain control"
 * setting was always supposed to be.
 *
 * ── The bug this replaces ──────────────────────────────────────────────
 * Before this, "Auto gain control" in Settings toggled a DynamicsCompressor
 * with a FIXED -26 dBFS threshold and a flat +5 dB makeup gain
 * (COMPRESSOR_PRESET / COMPRESSOR_MAKEUP_GAIN in voiceProcessor.ts). That's
 * a levelling compressor, not gain control: a mic sitting at -42 dBFS never
 * crosses the -26 dBFS threshold, so it only ever gets the flat +5 dB —
 * while a mic at -12 dBFS gets compressed down and then only partially
 * lifted back up. A 30 dB hardware difference between two speakers came out
 * roughly 20 dB apart on the wire, no matter how "Auto gain control" was
 * set on either end.
 *
 * This is a genuine two-stage design instead (the libwebrtc AGC2 pattern):
 *   1. A SLOW adaptive digital gain that estimates the speaker's average
 *      speech level over several seconds and steers it toward a target,
 *      changing by only a few dB per second so it's inaudible as movement.
 *   2. A FAST peak limiter as the last stage, so a sudden loud transient
 *      (a laugh, a chair scrape) can never clip even while the slow stage
 *      is still catching up.
 *
 * The compressor from before (COMPRESSOR_PRESET) stays downstream of this as
 * the fast layer for consonant peaks — with AGC now normalizing everyone's
 * average level first, the compressor engages consistently for every
 * speaker instead of only for the ones whose hardware happened to run hot.
 *
 * ── Voice-activity detection ─────────────────────────────────────────────
 * AGC sits AFTER the gate worklet in the chain (gate → EQ → AGC →
 * compressor), so gate-closed silence has already been attenuated toward
 * zero by the time it reaches here. A simple RMS floor check on the
 * (post-gate) input quantum is therefore a reasonable "is this speech"
 * signal without needing a second, independent VAD or any cross-worklet
 * coordination — silence never crosses the floor, so the level estimate and
 * gain only ever adapt to genuine speech.
 */

export function dbToLinear(db) {
    return Math.pow(10, db / 20);
}

export function linearToDb(linear) {
    return 20 * Math.log10(Math.max(linear, 1e-12));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// Target dropped from -24 to -28 dBFS, and the max boost from +18 to +12 dB,
// after "people in calls are too loud" reports: with the old target plus the
// downstream compressor's (then) +5/+3 dB makeup gain, typical speech landed
// around -21 dBFS on the wire — loud for voice chat, and the +18 dB ceiling
// meant a quiet mic's noise floor got lifted right along with its voice. See
// voiceProcessor.ts's COMPRESSOR_MAKEUP_GAIN comment for the paired change
// (makeup gain removed entirely — this AGC stage is the only leveling now).
export const DEFAULT_TARGET_DB = -28;
export const DEFAULT_FLOOR_DB = -50;
export const DEFAULT_MIN_GAIN_DB = -18;
export const DEFAULT_MAX_GAIN_DB = 12;
export const DEFAULT_RISE_DB_PER_SEC = 3;
export const DEFAULT_FALL_DB_PER_SEC = 6;
export const DEFAULT_LEVEL_SMOOTHING_SEC = 3;
export const DEFAULT_LIMITER_CEILING_DB = -1;
export const DEFAULT_LIMITER_ATTACK_SEC = 0.001;
export const DEFAULT_LIMITER_RELEASE_SEC = 0.1;

export class AgcProcessor {
    constructor(opts) {
        opts = opts || {};
        this.sampleRate = opts.sampleRate || 48000;

        this.targetRms = opts.targetRms != null ? opts.targetRms : dbToLinear(DEFAULT_TARGET_DB);
        this.floorRms = opts.floorRms != null ? opts.floorRms : dbToLinear(DEFAULT_FLOOR_DB);
        this.minGain = opts.minGain != null ? opts.minGain : dbToLinear(DEFAULT_MIN_GAIN_DB);
        this.maxGain = opts.maxGain != null ? opts.maxGain : dbToLinear(DEFAULT_MAX_GAIN_DB);
        this.riseDbPerSec = opts.riseDbPerSec != null ? opts.riseDbPerSec : DEFAULT_RISE_DB_PER_SEC;
        this.fallDbPerSec = opts.fallDbPerSec != null ? opts.fallDbPerSec : DEFAULT_FALL_DB_PER_SEC;
        this.levelSmoothingSec =
            opts.levelSmoothingSec != null ? opts.levelSmoothingSec : DEFAULT_LEVEL_SMOOTHING_SEC;

        this.limiterCeiling =
            opts.limiterCeiling != null ? opts.limiterCeiling : dbToLinear(DEFAULT_LIMITER_CEILING_DB);
        this.limiterAttackSec =
            opts.limiterAttackSec != null ? opts.limiterAttackSec : DEFAULT_LIMITER_ATTACK_SEC;
        this.limiterReleaseSec =
            opts.limiterReleaseSec != null ? opts.limiterReleaseSec : DEFAULT_LIMITER_RELEASE_SEC;

        // Bypass: when false, gain is pinned to 1.0 and never adapts — used
        // when the user has "Auto gain control" turned off. The limiter still
        // runs even in bypass, purely as safety against whatever the rest of
        // the chain hands it; at unity gain it will essentially never engage
        // on a normal voice signal.
        this.enabled = opts.enabled !== false;

        this.gain = 1.0; // current applied slow-stage gain (linear)
        // Seed the level estimate at the target rather than 0 — starting
        // "already correct" avoids a big, audible gain swing in the first
        // second of the very first utterance after init.
        this.levelEstimate = this.targetRms;
        this.limiterGain = 1.0; // current limiter gain reduction (<=1, 1=no reduction)
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            // Snap back to unity rather than leaving whatever gain was last
            // applied — otherwise turning AGC off mid-call would leave a
            // stale boost/cut baked in with no way to adapt it back.
            this.gain = 1.0;
        }
    }

    _quantumRms(block) {
        let sum = 0;
        for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
        return Math.sqrt(sum / block.length);
    }

    /**
     * Process one render quantum in place.
     * @param inp  Float32Array of input samples for this quantum (or null).
     * @param out  Float32Array to write output into; same length as inp.
     * @returns {{ gain: number, voiceActive: boolean }} diagnostics for the
     *          caller to forward upstream (e.g. an "applied gain" readout).
     */
    process(inp, out) {
        const quantumDurationSec = out.length / this.sampleRate;

        if (this.enabled) {
            const rms = inp ? this._quantumRms(inp) : 0;
            const voiceActive = rms >= this.floorRms;

            if (voiceActive) {
                const alpha = 1 - Math.exp(-quantumDurationSec / this.levelSmoothingSec);
                this.levelEstimate += (rms - this.levelEstimate) * alpha;

                const desiredGain = clamp(
                    this.targetRms / Math.max(this.levelEstimate, 1e-6),
                    this.minGain,
                    this.maxGain,
                );

                const currentDb = linearToDb(this.gain);
                const desiredDb = clamp(
                    linearToDb(desiredGain),
                    DEFAULT_MIN_GAIN_DB - 0.001, // guard float noise at the exact bound
                    DEFAULT_MAX_GAIN_DB + 0.001,
                );
                const maxStepUp = this.riseDbPerSec * quantumDurationSec;
                const maxStepDown = this.fallDbPerSec * quantumDurationSec;

                let nextDb;
                if (desiredDb > currentDb) {
                    nextDb = Math.min(desiredDb, currentDb + maxStepUp);
                } else {
                    nextDb = Math.max(desiredDb, currentDb - maxStepDown);
                }
                this.gain = clamp(dbToLinear(nextDb), this.minGain, this.maxGain);
            }
            // else: voice inactive — gain and levelEstimate are frozen, not
            // reset, so a mid-sentence pause doesn't lose the calibration.

            this._applyGainAndLimiter(inp, out);
            return { gain: this.gain, voiceActive };
        }

        // Bypassed: unity gain, limiter still runs as a safety net.
        this.gain = 1.0;
        this._applyGainAndLimiter(inp, out);
        return { gain: 1.0, voiceActive: false };
    }

    _applyGainAndLimiter(inp, out) {
        const attackCoeff = 1 - Math.exp(-1 / (this.limiterAttackSec * this.sampleRate));
        const releaseCoeff = 1 - Math.exp(-1 / (this.limiterReleaseSec * this.sampleRate));

        for (let i = 0; i < out.length; i++) {
            const s = (inp ? inp[i] : 0) * this.gain;
            const absS = Math.abs(s);

            if (absS > this.limiterCeiling) {
                const targetReduction = this.limiterCeiling / absS;
                this.limiterGain += (targetReduction - this.limiterGain) * attackCoeff;
            } else {
                this.limiterGain += (1.0 - this.limiterGain) * releaseCoeff;
            }
            // Guard against the limiter follower ever amplifying — it exists
            // only to reduce, never to boost above what the slow stage set.
            const effectiveLimiterGain = Math.min(1, this.limiterGain);
            out[i] = s * effectiveLimiterGain;
        }
    }
}
