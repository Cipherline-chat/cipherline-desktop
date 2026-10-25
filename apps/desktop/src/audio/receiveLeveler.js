/**
 * ReceiveLeveler — the listener-side safety net behind "Normalize voice volume".
 *
 * Sender-side AGC (agcKernel.js) is the primary levelling stage, but a
 * receiver cannot count on it: an older desktop build, the mobile app (which
 * runs the platform's own AGC at its own level), a client with "Auto gain
 * control" off, or a talker whose AGC is still converging all arrive at their
 * own loudness. This estimates how loud ONE remote talker's active speech is
 * and returns a small, slow gain (default -9..+6 dB) that moves it toward the
 * same target the sender AGC aims at.
 *
 * ── What it measures, and why that is safe ───────────────────────────────
 * The level comes from the RTP `ssrc-audio-level` header extension (RFC 6464),
 * which libwebrtc senders (Chromium, the React Native WebRTC build, LiveKit's
 * server) stamp on every packet from the signal they are about to encode and
 * which Chromium exposes per packet through
 * RTCRtpReceiver.getSynchronizationSources().audioLevel. Consequences:
 *   - it is the talker's level BEFORE any gain we apply, so this stage is
 *     open loop: it can never chase its own output or fight the sender's AGC
 *     (it sees the post-AGC level and only closes the REMAINING error);
 *   - it is a header extension, so it needs no decoded audio, no Web Audio
 *     tap and no extra latency, and it is unaffected by the call's frame
 *     encryption (E2EE covers the payload, not the header extension);
 *   - it reads ~1.4 dB under the true RMS (measured: a sawtooth swept
 *     -60..-10 dBFS RMS read back -61.5..-11.5 through a loopback
 *     RTCPeerConnection in Chromium); RTP_LEVEL_BIAS_DB corrects for it.
 *
 * ── Behaviour ────────────────────────────────────────────────────────────
 *   - Only speech counts: a packet is speech if it is above an absolute floor
 *     and above a tracked noise floor + margin, so pauses, comfort noise and
 *     a steady room hiss are neither measured nor amplified. The gain FREEZES
 *     (never decays or jumps) while nothing is speech.
 *   - A dead band around the target (default +-2.5 dB): a talker the sender
 *     AGC already put close to target gets exactly 0 dB, so the two stages do
 *     not fight over a dB or two.
 *   - Slow: the level is a running mean until its window fills, then a 4 s
 *     EMA; the gain slews at 2 dB/s up and 4 dB/s down of active speech
 *     (slower than the sender's, so a sender still converging is not
 *     overshot by a receiver that is still catching up with it).
 *   - Nothing here touches audio samples; the caller applies the returned gain
 *     to its own volume node (before the user's per-person slider is
 *     multiplied in, so manual volume keeps working).
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

// Same scale and same number as the sender AGC's wire target (see
// agcKernel.js): active-speech level, dBFS RMS. The sender AGC's own target is
// -19 at its output and lands about -20 on the wire after its compressor.
export const RX_TARGET_DB = -20;
export const RX_DEADBAND_DB = 2.5;
export const RX_MIN_GAIN_DB = -9;
export const RX_MAX_GAIN_DB = 6;
export const RX_RISE_DB_PER_SEC = 2;
export const RX_FALL_DB_PER_SEC = 4;
export const RX_LEVEL_SMOOTHING_SEC = 4;
export const RX_BOOTSTRAP_SEC = 3;
export const RX_BOOTSTRAP_RATE_MULT = 3;
// Seconds of speech before the first correction: one sentence, not one word.
export const RX_MIN_EVIDENCE_SEC = 1.0;
export const RX_FLOOR_DB = -55;
export const RX_NOISE_MARGIN_DB = 10;
export const RX_NOISE_FALL_FRACTION = 0.2;
export const RX_NOISE_RISE_DB_PER_SEC = 0.5;
// ssrc-audio-level reads this far BELOW the true RMS (measured, see above).
export const RTP_LEVEL_BIAS_DB = 1.4;

// A boost only a Web Audio gain node can apply (an <audio> element tops out
// at volume 1): how many seconds it has to be wanted before the caller pays
// that path's latency for it.
export const RX_BOOST_LATCH_SEC = 3;

/**
 * Advance the "this talker needs the boost-capable playback path" latch.
 * Pure so the policy is a table under test. `accumSec` is the seconds the
 * (wanted) combined gain has exceeded what the cheap path can reproduce; it
 * only grows while that is true, decays back toward 0 otherwise (a blip must
 * not accumulate across minutes), and the latch reports true once it reaches
 * RX_BOOST_LATCH_SEC. The caller keeps a latched chain latched for its life.
 */
export function stepBoostLatch(accumSec, wantsBoost, dtSec) {
    const next = wantsBoost ? accumSec + dtSec : Math.max(0, accumSec - 2 * dtSec);
    return { accumSec: next, latched: next >= RX_BOOST_LATCH_SEC };
}

export class ReceiveLeveler {
    constructor(opts) {
        opts = opts || {};
        this.targetDb = opts.targetDb != null ? opts.targetDb : RX_TARGET_DB;
        this.deadbandDb = opts.deadbandDb != null ? opts.deadbandDb : RX_DEADBAND_DB;
        this.minGainDb = opts.minGainDb != null ? opts.minGainDb : RX_MIN_GAIN_DB;
        this.maxGainDb = opts.maxGainDb != null ? opts.maxGainDb : RX_MAX_GAIN_DB;
        this.riseDbPerSec = opts.riseDbPerSec != null ? opts.riseDbPerSec : RX_RISE_DB_PER_SEC;
        this.fallDbPerSec = opts.fallDbPerSec != null ? opts.fallDbPerSec : RX_FALL_DB_PER_SEC;
        this.smoothingSec = opts.smoothingSec != null ? opts.smoothingSec : RX_LEVEL_SMOOTHING_SEC;
        this.bootstrapSec = opts.bootstrapSec != null ? opts.bootstrapSec : RX_BOOTSTRAP_SEC;
        this.bootstrapMult = opts.bootstrapMult != null ? opts.bootstrapMult : RX_BOOTSTRAP_RATE_MULT;
        this.minEvidenceSec = opts.minEvidenceSec != null ? opts.minEvidenceSec : RX_MIN_EVIDENCE_SEC;
        this.floorDb = opts.floorDb != null ? opts.floorDb : RX_FLOOR_DB;
        this.noiseMarginDb = opts.noiseMarginDb != null ? opts.noiseMarginDb : RX_NOISE_MARGIN_DB;
        this.biasDb = opts.biasDb != null ? opts.biasDb : RTP_LEVEL_BIAS_DB;
        this.reset();
    }

    /** Forget the talker (track replaced, participant re-joined). */
    reset() {
        this.gainDb = 0;
        this.levelPower = 0; // mean square of ACTIVE speech, true-RMS domain
        this.activeSec = 0;
        this.noiseFloorDb = this.floorDb;
    }

    /** Current estimate of the talker's active speech level, dBFS (or -Infinity). */
    get levelDb() {
        return this.levelPower > 0 ? 10 * Math.log10(this.levelPower) : -Infinity;
    }

    /**
     * Feed one level reading and return the gain (dB) to apply.
     * @param audioLevel linear 0..1 as reported by getSynchronizationSources()
     *                   (0 / undefined = silence, treated as a pause).
     * @param dtSec      seconds this reading stands for (poll interval).
     */
    pushLinear(audioLevel, dtSec) {
        const lin = typeof audioLevel === 'number' && Number.isFinite(audioLevel) ? audioLevel : 0;
        return this.push(linearToDb(lin), dtSec);
    }

    /** Same, with the level already in dBov/dBFS RMS (the raw RTP reading). */
    push(levelDb, dtSec) {
        if (!(dtSec > 0) || !Number.isFinite(levelDb)) return this.gainDb;
        const dt = Math.min(dtSec, 0.5);
        const level = levelDb + this.biasDb;

        // Noise floor of what this talker sends: follows the quietest packets
        // down, creeps up slowly, never above what the talker's own speech
        // level could justify.
        if (level < this.noiseFloorDb) {
            this.noiseFloorDb += (level - this.noiseFloorDb) * RX_NOISE_FALL_FRACTION;
        } else {
            this.noiseFloorDb += RX_NOISE_RISE_DB_PER_SEC * dt;
        }
        if (this.levelPower > 0) {
            this.noiseFloorDb = Math.min(this.noiseFloorDb, 10 * Math.log10(this.levelPower) - 15);
        }
        this.noiseFloorDb = clamp(this.noiseFloorDb, -90, 0);

        const active = level >= Math.max(this.floorDb, this.noiseFloorDb + this.noiseMarginDb);
        if (!active) return this.gainDb; // pause: freeze, never decay

        this.activeSec += dt;
        const p = Math.pow(10, level / 10);
        const alpha = Math.max(1 - Math.exp(-dt / this.smoothingSec), dt / this.activeSec);
        this.levelPower = this.levelPower > 0 ? this.levelPower + (p - this.levelPower) * alpha : p;

        if (this.activeSec < this.minEvidenceSec) return this.gainDb;

        const err = this.targetDb - this.levelDb;
        let desired = 0;
        if (err > this.deadbandDb) desired = err - this.deadbandDb;
        else if (err < -this.deadbandDb) desired = err + this.deadbandDb;
        desired = clamp(desired, this.minGainDb, this.maxGainDb);

        const mult = this.activeSec < this.bootstrapSec ? this.bootstrapMult : 1;
        if (desired > this.gainDb) {
            this.gainDb = Math.min(desired, this.gainDb + this.riseDbPerSec * mult * dt);
        } else {
            this.gainDb = Math.max(desired, this.gainDb - this.fallDbPerSec * mult * dt);
        }
        return this.gainDb;
    }
}
