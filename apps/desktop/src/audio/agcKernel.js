/**
 * AgcProcessor — the real automatic gain control the "Auto gain control"
 * setting drives. Sender-side, slow and speech-gated, with a fast burst guard
 * and a look-ahead peak limiter (the libwebrtc AGC2 pattern: slow adaptive
 * digital gain + limiter).
 *
 * ── History ────────────────────────────────────────────────────────────
 * v1 replaced a fixed-threshold compressor (a mic at -42 dBFS never crossed
 * its -26 dBFS threshold, so a 30 dB hardware difference between two speakers
 * came out ~20 dB apart on the wire). v2 (call-loudness, 2026-10) keeps that
 * architecture and fixes what a measured run of the full send chain showed:
 *
 *  - SLOW CONVERGENCE: gain started at 0 dB and the level estimate was seeded
 *    at the target, so the first 5-10 s of every talker were 4-6 dB off in both
 *    directions. The estimate is now a running mean until its window fills
 *    (so it is right after a fraction of a second of speech) and the slew is
 *    3x faster during the first seconds of speech.
 *  - REACH: +12 dB could not lift a -46 dBFS mic to the target. Range is now
 *    -24..+24 dB, BUT the boost is capped so the noise floor is never lifted
 *    above DEFAULT_OUTPUT_NOISE_LIMIT_DB (AGC2's max_output_noise_level idea).
 *    The v1 floor check ("RMS above -50 dBFS = speech") also treated room
 *    noise as speech, so a noisy mic with NS off was boosted like a voice.
 *  - LOUD TALKERS: a shout moved a 3 s estimate only slowly. A short-window
 *    burst guard now pulls the gain down quickly when the talker is far above
 *    target, then lets the slow stage take over.
 *  - PEAKS: the limiter had no look-ahead (it could only react after a peak
 *    had already passed). It now delays the signal by 1 ms and reacts before
 *    the peak, with a hard ceiling so nothing clips.
 *  - LEVEL MEASURE: mean of per-block RMS under-reads dynamic speech and
 *    varies with speaking style. The estimate is mean-square over active
 *    blocks, i.e. the P.56-style "active speech level", which is what the
 *    target and the receive-side leveler (receiveLeveler.js) are expressed in.
 *
 * Voice activity: the gate worklet sits upstream (gate -> EQ -> AGC), so
 * gate-closed silence is already ~0. On top of that a block counts as speech
 * only if it is above an absolute floor AND DEFAULT_NOISE_MARGIN_DB above a
 * tracked noise floor, so a gate-off, NS-off room is not "speech". Gain and
 * level estimate freeze (never reset) while nothing is active.
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

// ── Targets ────────────────────────────────────────────────────────────────
// Active-speech level the AGC steers to, mean-square over speech blocks (the
// P.56 flavour), in dBFS, at the AGC output. The compressor downstream is
// make-up-neutral (voiceProcessor.ts), so this is the level that reaches the
// wire within ~1 dB: about -20 dBFS active speech. libwebrtc AGC2 aims a peak
// headroom of 5 dB (=> roughly -17..-22 dBFS RMS for speech), 3GPP/ITU-T P.56
// work uses -26 dBov nominal, Google's two-stage conferencing AGC patent
// -20..-25 dB, and the chain this replaces measured -19.7 dBFS at steady
// state — a level the owner had already trimmed once for "too loud".
export const DEFAULT_TARGET_DB = -19;
// Absolute activity floor (dBFS RMS of a 128-sample block).
export const DEFAULT_FLOOR_DB = -50;
// A block is speech only this far above the tracked noise floor.
export const DEFAULT_NOISE_MARGIN_DB = 10;
// The boost is capped so the noise floor never comes out louder than this.
export const DEFAULT_OUTPUT_NOISE_LIMIT_DB = -45;
export const DEFAULT_MIN_GAIN_DB = -24;
export const DEFAULT_MAX_GAIN_DB = 24;
// Slew, per second of ACTIVE speech (the gain is frozen between words, so the
// wall-clock rate is about half of this in conversation).
export const DEFAULT_RISE_DB_PER_SEC = 6;
export const DEFAULT_FALL_DB_PER_SEC = 12;
// Time constant of the level estimate once its window has filled.
export const DEFAULT_LEVEL_SMOOTHING_SEC = 3;
// Seconds of cumulative active speech during which the slew runs faster, and
// by how much (right after joining, or after the AGC was toggled on).
export const DEFAULT_BOOTSTRAP_SEC = 2;
export const DEFAULT_BOOTSTRAP_RATE_MULT = 3;
// Speech must be this long before the first gain move (a single block says
// nothing about a talker).
export const DEFAULT_MIN_EVIDENCE_SEC = 0.25;
// Burst guard: if the last ~150 ms of speech would come out more than this
// above target, pull the gain down at the burst rate.
export const DEFAULT_BURST_MARGIN_DB = 6;
export const DEFAULT_BURST_SMOOTHING_SEC = 0.15;
export const DEFAULT_BURST_FALL_DB_PER_SEC = 40;
// Smoothing of the energy used to decide "is this speech" (not the level).
export const DEFAULT_ACTIVITY_SMOOTHING_SEC = 0.012;
// Noise floor tracker: how fast it follows the quietest blocks down (per
// block, fraction of the gap) and how fast it is allowed to creep up (dB/s).
export const DEFAULT_NOISE_FALL_FRACTION = 0.25;
export const DEFAULT_NOISE_RISE_DB_PER_SEC = 2;
// The floor is never allowed above (speech level - this): a talker who never
// pauses must not teach the tracker that their own voice is the noise. 25 dB
// is also close to P.56's rule that speech is what is within ~16 dB of the
// active level (activity = floor + margin = level - 15 here).
export const DEFAULT_SPEECH_TO_FLOOR_DB = 25;
// Peak compressor (the "fast layer" for loud syllables), applied after the
// slow gain and before the limiter. It lives HERE, not in a DynamicsCompressor
// node, because a Web Audio DynamicsCompressorNode silently adds an automatic
// make-up gain (spec: pow(1/saturate(1), 0.6) — +9.1 dB for the old -26 dB / 4:1
// preset, measured in Chromium) to EVERYTHING below its threshold too. That
// hidden gain is what put speech at -19.7 dBFS when the AGC target said -28,
// and lifted room noise by the same amount. This one has no make-up: below the
// threshold it is exactly unity.
export const DEFAULT_COMP_THRESHOLD_DB = -14;
export const DEFAULT_COMP_RATIO = 3;
export const DEFAULT_COMP_KNEE_DB = 8;
export const DEFAULT_COMP_ATTACK_SEC = 0.003;
export const DEFAULT_COMP_RELEASE_SEC = 0.15;
// Limiter.
export const DEFAULT_LIMITER_CEILING_DB = -1;
export const DEFAULT_LIMITER_LOOKAHEAD_SEC = 0.001;
export const DEFAULT_LIMITER_ATTACK_SEC = 0.00025;
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
        this.noiseMarginDb = opts.noiseMarginDb != null ? opts.noiseMarginDb : DEFAULT_NOISE_MARGIN_DB;
        this.outputNoiseLimitDb =
            opts.outputNoiseLimitDb != null ? opts.outputNoiseLimitDb : DEFAULT_OUTPUT_NOISE_LIMIT_DB;
        this.bootstrapSec = opts.bootstrapSec != null ? opts.bootstrapSec : DEFAULT_BOOTSTRAP_SEC;
        this.bootstrapRateMult =
            opts.bootstrapRateMult != null ? opts.bootstrapRateMult : DEFAULT_BOOTSTRAP_RATE_MULT;
        this.minEvidenceSec = opts.minEvidenceSec != null ? opts.minEvidenceSec : DEFAULT_MIN_EVIDENCE_SEC;
        this.burstMarginDb = opts.burstMarginDb != null ? opts.burstMarginDb : DEFAULT_BURST_MARGIN_DB;
        this.burstSmoothingSec =
            opts.burstSmoothingSec != null ? opts.burstSmoothingSec : DEFAULT_BURST_SMOOTHING_SEC;
        this.burstFallDbPerSec =
            opts.burstFallDbPerSec != null ? opts.burstFallDbPerSec : DEFAULT_BURST_FALL_DB_PER_SEC;

        this.compThresholdDb =
            opts.compThresholdDb != null ? opts.compThresholdDb : DEFAULT_COMP_THRESHOLD_DB;
        this.compRatio = opts.compRatio != null ? opts.compRatio : DEFAULT_COMP_RATIO;
        this.compKneeDb = opts.compKneeDb != null ? opts.compKneeDb : DEFAULT_COMP_KNEE_DB;
        this.compAttackSec = opts.compAttackSec != null ? opts.compAttackSec : DEFAULT_COMP_ATTACK_SEC;
        this.compReleaseSec = opts.compReleaseSec != null ? opts.compReleaseSec : DEFAULT_COMP_RELEASE_SEC;
        // `compressor: false` leaves only gain + limiter (tests, bypass).
        this.compressorEnabled = opts.compressor !== false;

        this.limiterCeiling =
            opts.limiterCeiling != null ? opts.limiterCeiling : dbToLinear(DEFAULT_LIMITER_CEILING_DB);
        this.limiterAttackSec =
            opts.limiterAttackSec != null ? opts.limiterAttackSec : DEFAULT_LIMITER_ATTACK_SEC;
        this.limiterReleaseSec =
            opts.limiterReleaseSec != null ? opts.limiterReleaseSec : DEFAULT_LIMITER_RELEASE_SEC;
        this.lookahead = Math.max(
            1,
            Math.round(
                (opts.limiterLookaheadSec != null ? opts.limiterLookaheadSec : DEFAULT_LIMITER_LOOKAHEAD_SEC) *
                    this.sampleRate,
            ),
        );

        // Bypass: when false, gain is pinned to 1.0 and never adapts — used
        // when the user has "Auto gain control" turned off. The limiter still
        // runs even in bypass, purely as safety against whatever the rest of
        // the chain hands it; at unity gain it will essentially never engage
        // on a normal voice signal.
        this.enabled = opts.enabled !== false;

        this.gain = 1.0; // current applied slow-stage gain (linear)
        // Mean-square level of the talker's ACTIVE speech (input domain). Zero
        // until the first speech block: a running mean takes over from there,
        // so the estimate is right after a fraction of a second rather than
        // seeded at the target and dragged toward the truth over seconds.
        this.levelPower = 0;
        this.levelEstimate = 0; // sqrt(levelPower), kept for diagnostics/tests
        this.burstPower = 0; // short-window mean-square (burst guard)
        this.activeSec = 0; // cumulative seconds of speech seen
        this.noiseFloorDb = DEFAULT_FLOOR_DB; // tracked quiet-block level
        this.limiterGain = 1.0; // current limiter gain reduction (<=1, 1=no reduction)
        this.actPower = 0; // smoothed block energy for the activity decision
        this.compEnv = 0; // compressor peak envelope (linear)
        this.compReductionDb = 0; // current compressor gain reduction (<= 0)

        this._ring = new Float32Array(this.lookahead);
        this._ringPos = 0;
        this._peak = 0; // loudest |sample| currently in the look-ahead ring
    }

    setEnabled(enabled) {
        const was = this.enabled;
        this.enabled = enabled;
        if (!enabled) {
            // Snap back to unity rather than leaving whatever gain was last
            // applied — otherwise turning AGC off mid-call would leave a
            // stale boost/cut baked in with no way to adapt it back.
            this.gain = 1.0;
        } else if (!was) {
            // Re-enabled: relearn the talker from scratch, fast.
            this.levelPower = 0;
            this.levelEstimate = 0;
            this.burstPower = 0;
            this.activeSec = 0;
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
        const dt = out.length / this.sampleRate;

        if (this.enabled) {
            const rms = inp ? this._quantumRms(inp) : 0;

            // Activity is judged on a ~12 ms smoothed energy, not on one 2.7 ms
            // block: a single block of steady noise swings by several dB on its
            // own, speech does not. (The level estimate below still uses the
            // block energy.)
            const aAct = 1 - Math.exp(-dt / DEFAULT_ACTIVITY_SMOOTHING_SEC);
            this.actPower += (rms * rms - this.actPower) * aAct;
            const actRms = Math.sqrt(this.actPower);
            const rmsDb = linearToDb(actRms);

            // Noise floor: follow the quietest blocks down quickly, creep up
            // slowly so sustained speech cannot drag it up with it (and never
            // above what the talker's own level could justify).
            if (rmsDb < this.noiseFloorDb) {
                this.noiseFloorDb += (rmsDb - this.noiseFloorDb) * DEFAULT_NOISE_FALL_FRACTION;
            } else {
                this.noiseFloorDb += DEFAULT_NOISE_RISE_DB_PER_SEC * dt;
            }
            if (this.levelPower > 0) {
                this.noiseFloorDb = Math.min(this.noiseFloorDb, 10 * Math.log10(this.levelPower) - DEFAULT_SPEECH_TO_FLOOR_DB);
            }
            this.noiseFloorDb = clamp(this.noiseFloorDb, -90, 0);

            const activeThreshold = Math.max(this.floorRms, dbToLinear(this.noiseFloorDb + this.noiseMarginDb));
            const voiceActive = actRms >= activeThreshold;

            if (voiceActive) {
                this.activeSec += dt;
                const p = rms * rms;

                // Running mean until the window fills, then an EMA. (First
                // block: alpha = 1, i.e. the estimate IS that block.)
                const aSlow = Math.max(1 - Math.exp(-dt / this.levelSmoothingSec), dt / this.activeSec);
                this.levelPower = this.levelPower > 0 ? this.levelPower + (p - this.levelPower) * aSlow : p;
                this.levelEstimate = Math.sqrt(this.levelPower);
                const aBurst = Math.max(1 - Math.exp(-dt / this.burstSmoothingSec), dt / this.activeSec);
                this.burstPower = this.burstPower > 0 ? this.burstPower + (p - this.burstPower) * aBurst : p;

                if (this.activeSec >= this.minEvidenceSec) {
                    const targetDb = linearToDb(this.targetRms);
                    const levelDb = 10 * Math.log10(Math.max(this.levelPower, 1e-24));
                    const burstDb = 10 * Math.log10(Math.max(this.burstPower, 1e-24));

                    // Never boost the noise past the limit; never "cap" below
                    // unity (a noisy line is not a reason to attenuate speech).
                    const noiseCapDb = Math.max(0, this.outputNoiseLimitDb - this.noiseFloorDb);
                    const maxDb = Math.min(linearToDb(this.maxGain), noiseCapDb);
                    const minDb = linearToDb(this.minGain);

                    const desiredDb = clamp(targetDb - levelDb, minDb, Math.max(minDb, maxDb));
                    const burstDesiredDb = Math.max(minDb, targetDb + this.burstMarginDb - burstDb);

                    const currentDb = linearToDb(this.gain);
                    const mult = this.activeSec < this.bootstrapSec ? this.bootstrapRateMult : 1;
                    let nextDb;
                    if (burstDesiredDb < currentDb && burstDesiredDb < desiredDb) {
                        nextDb = Math.max(burstDesiredDb, currentDb - this.burstFallDbPerSec * dt);
                    } else if (desiredDb > currentDb) {
                        // Rising: never past what the burst guard would allow.
                        nextDb = Math.min(desiredDb, currentDb + this.riseDbPerSec * mult * dt);
                        nextDb = Math.min(nextDb, Math.max(currentDb, burstDesiredDb));
                    } else {
                        nextDb = Math.max(desiredDb, currentDb - this.fallDbPerSec * mult * dt);
                    }
                    this.gain = clamp(dbToLinear(nextDb), this.minGain, this.maxGain);
                }
            }
            // else: voice inactive — gain and level estimates are frozen, not
            // reset, so a mid-sentence pause doesn't lose the calibration.

            this._applyGainAndLimiter(inp, out);
            return { gain: this.gain, voiceActive };
        }

        // Bypassed: unity gain, limiter still runs as a safety net.
        this.gain = 1.0;
        this._applyGainAndLimiter(inp, out);
        return { gain: 1.0, voiceActive: false };
    }

    /**
     * Gain, then a look-ahead peak limiter: the signal is delayed by
     * `lookahead` samples (1 ms), the limiter gain is steered by the loudest
     * sample in that window — i.e. it is already down when the peak arrives at
     * the output — and a hard clamp at the ceiling guarantees nothing exceeds
     * it even if the follower is momentarily late.
     */
    _applyGainAndLimiter(inp, out) {
        const attackCoeff = 1 - Math.exp(-1 / (this.limiterAttackSec * this.sampleRate));
        const releaseCoeff = 1 - Math.exp(-1 / (this.limiterReleaseSec * this.sampleRate));
        const ring = this._ring;
        const L = ring.length;
        const ceiling = this.limiterCeiling;
        let pos = this._ringPos;
        let peak = this._peak;

        // Compressor state (only used while the AGC is on: bypass must stay a
        // pure unity path).
        const comp = this.enabled && this.compressorEnabled;
        const cAtk = 1 - Math.exp(-1 / (this.compAttackSec * this.sampleRate));
        const cRel = 1 - Math.exp(-1 / (this.compReleaseSec * this.sampleRate));
        const slope = 1 / this.compRatio - 1; // negative
        const halfKnee = this.compKneeDb / 2;

        for (let i = 0; i < out.length; i++) {
            let s = (inp ? inp[i] : 0) * this.gain;

            if (comp) {
                const a = s < 0 ? -s : s;
                this.compEnv += (a - this.compEnv) * (a > this.compEnv ? cAtk : cRel);
                const over = 20 * Math.log10(Math.max(this.compEnv, 1e-9)) - this.compThresholdDb;
                let grDb = 0;
                if (over > halfKnee) grDb = slope * over;
                else if (over > -halfKnee) grDb = (slope * (over + halfKnee) * (over + halfKnee)) / (2 * this.compKneeDb);
                this.compReductionDb = grDb;
                if (grDb < 0) s *= Math.pow(10, grDb / 20);
            }
            const delayed = ring[pos];
            ring[pos] = s;
            pos = pos + 1 === L ? 0 : pos + 1;

            // Peak of the look-ahead window, rescanned only when the sample that
            // just left WAS the peak (otherwise a new sample can only raise it).
            const as = s < 0 ? -s : s;
            if (as >= peak) {
                peak = as;
            } else if ((delayed < 0 ? -delayed : delayed) >= peak) {
                peak = 0;
                for (let k = 0; k < L; k++) {
                    const a = ring[k] < 0 ? -ring[k] : ring[k];
                    if (a > peak) peak = a;
                }
            }

            if (peak > ceiling) {
                const targetReduction = ceiling / peak;
                this.limiterGain += (targetReduction - this.limiterGain) * attackCoeff;
            } else {
                this.limiterGain += (1.0 - this.limiterGain) * releaseCoeff;
            }
            // Guard against the limiter follower ever amplifying — it exists
            // only to reduce, never to boost above what the slow stage set.
            const o = delayed * Math.min(1, this.limiterGain);
            out[i] = o > ceiling ? ceiling : o < -ceiling ? -ceiling : o;
        }
        this._ringPos = pos;
        this._peak = peak;
    }
}
