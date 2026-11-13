/**
 * AgcProcessor — the real automatic gain control the "Auto gain control"
 * setting drives. Sender-side, speech-gated, with an instant loud-onset guard
 * and a look-ahead peak limiter (the libwebrtc AGC2 pattern: adaptive digital
 * gain + fast limiter), and ONE gain law for every noise-suppression mode.
 *
 * ── History ────────────────────────────────────────────────────────────
 * v1 replaced a fixed-threshold compressor. v2 (call-loudness, 2026-10) fixed
 * the make-up gain hidden in Web Audio's compressor, the seeded level estimate
 * and the missing look-ahead. v3 (agc-behaviour, 2026-10) fixes what the owner
 * heard on real Windows calls:
 *
 *  1. "Quiet for a while, then I talk and I'm super loud." The v2 voice
 *     detector was ENERGY only: any sound 10 dB over the noise floor (a breath,
 *     a key click, a chair, a cough) counted as speech, and the AGC raised the
 *     gain towards its +24 dB ceiling to bring that quiet sound up to the
 *     speech target. The first word after the silence then left at +10..+24 dB
 *     above where it belonged, and the 40 dB/s burst guard needed ~0.5 s to
 *     come down. Now: the gain adapts ONLY while VoiceDetector hears voiced
 *     speech (pitch periodicity - breaths, clicks, fans and rumble have none),
 *     so in silence and noise it HOLDS. And a loud onset is caught in the very
 *     block it arrives in (the fast guard below), not after the fact.
 *  2. "Some people join really loud and it slowly turns them down." The gain
 *     started at unity and fell at 12 dB/s (40 dB/s burst) after 0.25 s of
 *     evidence, and the receive leveler restarted at 0 dB every time its chain
 *     was rebuilt. The same fast guard clamps a hot mic from the first block;
 *     see receiveLeveler.js for the listener side.
 *  3. "On Light, loud speech clips and everything is very loud; Strong is
 *     fine." Strong (RNNoise) deletes breaths, clicks and other non-speech
 *     before the AGC; Light (Speex) only removes STEADY noise, so all of that
 *     reached the energy-only detector and drove the gain up (1.). Same
 *     detector and same law for both now; nothing in this file knows which
 *     noise suppressor is upstream.
 *
 * v4 (agc-fast, 2026-10) - "it takes wayyy too long to turn up and down; it
 * should work like: +5 dB above desired, lower it 5 dB". Measured on a talker
 * who drops 12 dB: the output stayed ~10 dB under target for the whole next
 * second and was still 8 dB under after 2.8 s, because
 *
 *  - the level estimate FELL with a 1.5 s time constant (it was only allowed
 *    to rise fast), so the quiet talker was not even recognised as quiet for
 *    seconds, and
 *  - the slow gain then crept up at 24 dB/s behind that estimate.
 *
 * And on the loud side the guard waited until the output was 7 dB over target
 * before it did anything, hit the sudden-onset block with a 0.7 ms cut ramp
 * (the first 32 samples of a hot onset still left at the old, boosted gain, so
 * the limiter clamp pinned them: the flat-topped "clipping" heard on Light,
 * where the lower noise floor lets the gain park 10-20 dB higher), and
 * only followed with a 6 ms level detector. Now the estimate follows a louder
 * talker in ~30 ms and a quieter one in ~80 ms, the slow gain moves at
 * 100 dB/s up / 300 dB/s down, the guard acts 4 dB over target on a 2 ms
 * detector with a 0.3 ms ramp, and the limiter's follower reaches its target
 * inside its own look-ahead.
 *
 * ── The law ────────────────────────────────────────────────────────────
 *  Per 128-sample block, in the input domain (dB):
 *    L      speech-gated active level (mean-square over voiced speech blocks;
 *           a running mean until its window fills, then an EMA that follows a
 *           louder talker with a ~30 ms and a quieter one with a ~80 ms time
 *           constant)
 *    Gs     slow gain. HOLDS unless speech is detected. While speech:
 *             rises towards  clamp(T - L, MIN, noise-capped MAX)  at
 *             RISE dB/s (x2 during the first BOOTSTRAP_SEC of speech),
 *             falls at FALL dB/s (same bootstrap multiplier).
 *    F      fast level of the input (attack ~2 ms, release ~150 ms)
 *    cut    min(0, T + M - (F + Gs)): how far over the loud-onset ceiling the
 *           output would be. Applied IMMEDIATELY (same block, any sound - a
 *           shout, a cough, a hot mic at join) and, while speech, Gs follows it
 *           down at FAST_FALL dB/s so the cut hands over to the slow gain
 *           instead of pumping. Gs never rises past the headroom it leaves.
 *           (So +X dB over the ceiling is -X dB, in the block it arrives in.)
 *    output = x * dB(Gs + cut) -> make-up-free peak compressor -> 1 ms
 *             look-ahead limiter (-1 dBFS hard ceiling).
 *
 * Because T, M and every rate are applied after the noise suppressor, the same
 * speech lands at the same level whether Light or Strong is upstream (their
 * +3.5 dB compensation difference is removed by the slow gain within the first
 * word), and the same limiter and guard protect against clipping on both.
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
// P.56 flavour), in dBFS, at the AGC output. The chain lands about 2 dB below
// this on the wire (compressor), i.e. ~-17.6 dBFS. Raised 3 dB on 2026-11-08
// (owner: calls too quiet) from ~-20.6, with the compressor threshold and the
// listener's RX_TARGET_DB moved by the same 3 dB: moving the target alone mostly
// runs into the compressor (6.5 dB more target gave only ~2 dB more level), and
// the listener would turn it back down. Peaks stay about 4 dB under the limiter.
// Raised again 2026-11-10 from -15.5 to -12.5 (owner: "make mics louder for everyone"; a
// tester found a Cipherline call much quieter than Discord, whose WebRTC AGC runs hot):
// the compressor threshold and the listener's RX_TARGET_DB move by the same 3 dB for
// the same reason as above. About -14.5 dBFS active speech on the wire now.
export const DEFAULT_TARGET_DB = -14; // was -12.5 (2026-11-11: with full quiet-talker compensation and the compressor threshold at -4, peaks no longer sit on the -1 dBFS ceiling; wire speech about -16 dBFS, louder than before for everyone quieter than -18 dBFS)
// Absolute activity floor (dBFS RMS of a 128-sample block). Lowered from -50 to -62
// on 2026-11-10: a mic whose speech averages -45 dBFS (an ordinary Windows mic at a
// modest OS level) spends its quiet syllables under -50, so a third of its speech was
// "not active" and never reached the level estimate or the pitch detector.
export const DEFAULT_FLOOR_DB = -62;
// Where the tracked noise floor starts before it has heard a quiet block (was the
// activity floor, -50, and must stay: it caps the boost of a talker who starts
// speaking straight away, until the floor tracker has seen a pause).
export const DEFAULT_INITIAL_NOISE_FLOOR_DB = -50;
// A block is speech only this far above the tracked noise floor.
export const DEFAULT_NOISE_MARGIN_DB = 8;
// The boost is capped so the noise floor never comes out louder than this.
// The boost is capped so the tracked noise floor never comes out louder than the HIGHER of this and
// (target - DEFAULT_MIN_SNR_DB): a mic whose hiss is only ~7 dB under its speech (owner: -45 dBFS speech
// over a -52 floor) must still reach the target, since gain cannot make its SNR worse. See noiseCapDb.
export const DEFAULT_MIN_SNR_DB = 6;
export const DEFAULT_OUTPUT_NOISE_LIMIT_DB = -40; // was -45; owner-approved 2026-11-11 (+5 dB boost for a quiet-but-clean talker, hiss up to 5 dB louder)
// Quiet-talker boost curve. Only the way UP: anything over the target is still
// cut all the way to it. Below the target a talker is brought most of the way
// (RATIO), by at most MAX_BOOST dB, so soft speech stays a little softer than
// normal talking. Below QUIET_KNEE the allowed boost shrinks in a straight line,
// reaching 0 dB at NO_BOOST; nothing at or below NO_BOOST is turned up at all, so
// breath and room noise are still left alone (owner 2026-10-31: "almost too good").
// Loosened 2026-11-08 from 45% / 7 dB / -34 dBFS after testers reported calls too
// quiet: those numbers were chosen by ear on one very hot mic. At the listener
// they left a -30 dBFS talker about 2 dB down and a -40 dBFS one about 8 dB down
// (owner approved the change).
// Loosened again 2026-11-10 (tester: "my microphone is much quieter on a cipher call
// than a discord call"; Windows 11, mic slider already at 150). The 14 dB cap and the
// -42 knee were still the limit for a QUIET mic: measured through the real chain with
// Light noise suppression, a -45 dBFS talker left at -33.7 dBFS and a -50 dBFS one at
// -45.9, against about -18 dBFS for any mic that is -30 or hotter (and ~-18 for
// everyone on Discord, whose WebRTC AGC can add 30+ dB and moves the Windows mic slider).
// The 75% ratio is unchanged, so every mic hotter than about -36 dBFS lands exactly where
// it did; only the cap and the taper moved: up to 30 dB, full strength down to -50 dBFS,
// tapering to nothing at -62 (a mic that quiet is muted or broken, not a quiet talker).
// What still keeps room noise down is not this curve but the output-noise limit
// (a boost never lifts the tracked noise floor above -45 dBFS) and the voiced-speech gate.
// 2026-11-11 (owner: "louder, raise the floor of quiet audio to start boosting"): FULL
// compensation (ratio 1) with up to 45 dB, down to -55 dBFS, tapering to nothing at -62.
export const DEFAULT_QUIET_BOOST_RATIO = 1;
export const DEFAULT_MAX_QUIET_BOOST_DB = 45;
export const DEFAULT_QUIET_KNEE_DB = -55;
export const DEFAULT_NO_BOOST_DB = -62;
// A very hot mic gets turned down much further than a quiet one gets turned up:
// 36 dB of cut against 14 dB of boost. -24 left +12 dBFS talkers about 1 dB over.
export const DEFAULT_MIN_GAIN_DB = -36;
export const DEFAULT_MAX_GAIN_DB = 46; // was 24; a -50 dBFS talker needs ~+28 to reach where the curve aims
// Slow-gain slew, per second of ACTIVE speech (the gain holds between words).
// +12 dB takes 0.12 s (0.06 s in the bootstrap), not the ~1 s it did at 24 dB/s;
// fast, but still a ramp, and still only while someone is talking, so it cannot
// pump the noise floor up between words.
export const DEFAULT_RISE_DB_PER_SEC = 100;
export const DEFAULT_FALL_DB_PER_SEC = 300;
// Time constant of the level estimate once its window has filled, when the
// talker has gotten QUIETER (it falls slowly enough to ride out a soft syllable).
// A louder talker is learned with DEFAULT_LOUDER_JUMP_SEC.
export const DEFAULT_LEVEL_SMOOTHING_SEC = 0.05;
// ...and a louder one (power ratio above DEFAULT_LOUDER_JUMP_RATIO) with this.
export const DEFAULT_LOUDER_JUMP_RATIO = 1;
export const DEFAULT_LOUDER_JUMP_SEC = 0.03;
// Seconds of cumulative active speech during which the slew runs faster, and
// by how much (right after joining, or after the AGC was toggled on).
export const DEFAULT_BOOTSTRAP_SEC = 1.5;
export const DEFAULT_BOOTSTRAP_RATE_MULT = 2;
// Speech must be this long before the first slow-gain move.
export const DEFAULT_MIN_EVIDENCE_SEC = 0.04;
// Loud-onset guard (the fast layer). Ceiling = target + this, measured on the
// fast level of the block. Syllable-to-syllable swings sit 3-4 dB over the
// active level, so this leaves ordinary dynamics alone and acts on anything
// louder: a talker +5 dB over the target is cut by about that much in the very
// block it arrives in (it was 7 dB before anything happened, then seconds to
// settle).
export const DEFAULT_FAST_MARGIN_DB = 5;
export const DEFAULT_FAST_ATTACK_SEC = 0.002;
export const DEFAULT_FAST_RELEASE_SEC = 0.15;
// How fast the slow gain follows the guard's cut down while speech is heard.
export const DEFAULT_FAST_FALL_DB_PER_SEC = 600;
// A falling gain reaches its new value over this many samples (0.3 ms). A cut
// must not leave the head of a hot block at the old, boosted gain.
export const FALL_RAMP_SAMPLES = 16;
// Smoothing of the energy used to decide "is this speech" (not the level).
export const DEFAULT_ACTIVITY_SMOOTHING_SEC = 0.012;
// Noise floor tracker: how fast it follows the quietest blocks down (per
// block, fraction of the gap) and how fast it is allowed to creep up (dB/s).
export const DEFAULT_NOISE_FALL_FRACTION = 0.25;
export const DEFAULT_NOISE_RISE_DB_PER_SEC = 2;
// The floor is never allowed above (speech level - this): a talker who never
// pauses must not teach the tracker that their own voice is the noise.
export const DEFAULT_SPEECH_TO_FLOOR_DB = 25;
// Voice activity (pitch periodicity). A frame is voiced when its normalized
// autocorrelation peak (70-500 Hz) reaches this; speech then stays "active"
// for the hangover so consonants and short pauses between vowels do not
// freeze the gain mid-word.
export const DEFAULT_VOICED_THRESHOLD = 0.5;
export const DEFAULT_VOICE_HANGOVER_SEC = 0.15;
// The LEVEL estimate learns only from blocks this close to a voiced frame. The
// hangover above keeps the gain armed through consonants and short pauses; it
// must not also let a key click or a breath inside that window pull a (now
// fast-moving) estimate down and the gain up behind it.
export const DEFAULT_LEVEL_VOICE_HOLD_SEC = 0.02;
// The level estimate ignores blocks more than ~16 dB under itself (a word's tail is not
// "active speech"). That exclusion has to be able to LET GO: after one loud voiced moment
// (a laugh, a shout, a leaned-in word: estimate -25 dBFS) a talker whose ordinary speech is
// 20 dB lower never produced a single admitted block, the estimate stayed at -25 for the
// rest of the call and the gain sat near 0-9 dB under a -45 dBFS voice (owner report
// 8d425682: gain_db 0.6 / 1.1 / 4.3 against ~20 dB in the windows around them). So: after
// this much VOICED time in which nothing was admitted, the estimate decays at
// DEFAULT_LEVEL_STALE_FALL_DB_PER_SEC until blocks are admitted again (then normal tracking
// resumes). A word's own tail is far shorter than the wait; the first admitted block ends it.
export const DEFAULT_LEVEL_STALE_SEC = 0.4;
export const DEFAULT_LEVEL_STALE_FALL_DB_PER_SEC = 20;
// Peak compressor (catches loud syllables), applied after the gain and before
// the limiter. It lives HERE, not in a DynamicsCompressorNode, because a Web
// Audio compressor silently adds an automatic make-up gain to everything below
// its threshold too (measured +9.1 dB in Chromium). This one is exactly unity
// below the threshold.
// Share of a slider BOOST (dB) that raises the AGC target (see setMicGainDb).
export const MIC_BOOST_TARGET_SHARE = 0.67;
// ...but never more than this: above it, typical-crest speech sits on the -1 dBFS ceiling and the
// limiter takes over (lim_pct 90 %+). The slider above 100 % still lifts a very quiet mic (its pre-gain
// moves the input into the compensated range); it just stops raising the loudness target.
export const MIC_BOOST_TARGET_MAX_DB = 1;
export const DEFAULT_COMP_THRESHOLD_DB = -4; // was -8 (moved with the target, see DEFAULT_TARGET_DB)
export const DEFAULT_COMP_RATIO = 3;
export const DEFAULT_COMP_KNEE_DB = 8;
export const DEFAULT_COMP_ATTACK_SEC = 0.003;
export const DEFAULT_COMP_RELEASE_SEC = 0.15;
// Limiter.
export const DEFAULT_LIMITER_CEILING_DB = -1;
export const DEFAULT_LIMITER_LOOKAHEAD_SEC = 0.001;
// The follower's time constant is 1/7 of the look-ahead, so it has covered
// 99.9 % of a gain step by the time the peak reaches the output (a slower
// follower left up to a few percent over the ceiling for the hard clamp to cut).
export const DEFAULT_LIMITER_ATTACK_SEC = 0.00014;
export const DEFAULT_LIMITER_RELEASE_SEC = 0.1;

/**
 * VoiceDetector - "is a person talking", from pitch periodicity.
 *
 * Voiced speech is quasi-periodic at 70-500 Hz; breaths, key clicks, chair
 * noise, fans, room hiss and rumble are not (or only at far lower correlation),
 * however loud they are. That is the property an energy threshold cannot give:
 * it is what keeps the AGC from "turning up" the room. Works on the signal the
 * AGC sees, so it is the same for Light and Strong.
 *
 * ~8 kHz box-decimated, 90 Hz high-passed, 32 ms window, one analysis per 96
 * decimated samples (12 ms), and only while the block is loud enough to be
 * speech at all (push(blk, analyse)): ~1 M multiply-adds/s while someone talks,
 * nothing in silence.
 */
export class VoiceDetector {
    constructor(sampleRate) {
        this.dec = Math.max(1, Math.round(sampleRate / 8000));
        this.fs = sampleRate / this.dec;
        this.hop = 96;
        this.win = Math.round(this.fs * 0.032);
        this.minLag = Math.floor(this.fs / 500);
        this.maxLag = Math.ceil(this.fs / 70);
        this.ring = new Float32Array(this.win); // circular: newest decimated sample at ringPos - 1
        this.x = new Float32Array(this.win); // linearised copy, rebuilt per analysis
        this.ringPos = 0;
        this.n = 0;
        this.sinceHop = 0;
        this.accum = 0;
        this.accN = 0;
        this.hpPrevIn = 0;
        this.hpPrevOut = 0;
        this.hpA = Math.exp((-2 * Math.PI * 90) / this.fs);
        /** Normalized autocorrelation peak of the latest analysed frame (0..1). */
        this.score = 0;
    }

    /** Feed samples; returns true when a new frame was analysed (score updated).
     *  `analyse` = false skips the (only expensive) correlation for quiet input. */
    push(blk, analyse) {
        let fresh = false;
        const dec = this.dec;
        const win = this.win;
        for (let i = 0; i < blk.length; i++) {
            this.accum += blk[i];
            if (++this.accN === dec) {
                const v = this.accum / dec;
                this.accum = 0;
                this.accN = 0;
                const y = this.hpA * (this.hpPrevOut + v - this.hpPrevIn);
                this.hpPrevIn = v;
                this.hpPrevOut = y;
                this.ring[this.ringPos] = y;
                this.ringPos = this.ringPos + 1 === win ? 0 : this.ringPos + 1;
                if (this.n < win) this.n++;
                if (++this.sinceHop === this.hop) {
                    this.sinceHop = 0;
                    if (this.n === win && analyse !== false) {
                        // oldest sample sits at ringPos
                        const head = win - this.ringPos;
                        this.x.set(this.ring.subarray(this.ringPos), 0);
                        this.x.set(this.ring.subarray(0, this.ringPos), head);
                        this._analyze();
                        fresh = true;
                    }
                }
            }
        }
        return fresh;
    }

    _analyze() {
        const x = this.x;
        const N = this.win - this.maxLag;
        let e0 = 0;
        for (let i = 0; i < N; i++) e0 += x[i] * x[i];
        if (e0 < 1e-12) {
            this.score = 0;
            return;
        }
        let es = 0;
        for (let i = 0; i < N; i++) es += x[this.minLag - 1 + i] * x[this.minLag - 1 + i];
        let best = 0;
        let seenNeg = false;
        for (let lag = this.minLag; lag <= this.maxLag; lag++) {
            es += x[lag + N - 1] * x[lag + N - 1] - x[lag - 1] * x[lag - 1];
            let c = 0;
            for (let i = 0; i < N; i++) c += x[i] * x[i + lag];
            const r = c / Math.sqrt(Math.max(e0 * es, 1e-20));
            // Only peaks after the autocorrelation has first gone negative count:
            // a slow rumble is highly correlated at every short lag and must not
            // read as a pitch.
            if (r < 0) seenNeg = true;
            else if (seenNeg && r > best) best = r;
        }
        this.score = best;
    }
}

export class AgcProcessor {
    constructor(opts) {
        opts = opts || {};
        this.sampleRate = opts.sampleRate || 48000;

        this.targetRms = opts.targetRms != null ? opts.targetRms : dbToLinear(DEFAULT_TARGET_DB);
        this.baseTargetDb = linearToDb(this.targetRms);
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
        this.minSnrDb = opts.minSnrDb != null ? opts.minSnrDb : DEFAULT_MIN_SNR_DB;
        this.quietKneeDb = opts.quietKneeDb != null ? opts.quietKneeDb : DEFAULT_QUIET_KNEE_DB;
        this.noBoostDb = opts.noBoostDb != null ? opts.noBoostDb : DEFAULT_NO_BOOST_DB;
        this.quietBoostRatio = opts.quietBoostRatio != null ? opts.quietBoostRatio : DEFAULT_QUIET_BOOST_RATIO;
        this.maxQuietBoostDb = opts.maxQuietBoostDb != null ? opts.maxQuietBoostDb : DEFAULT_MAX_QUIET_BOOST_DB;
        this.bootstrapSec = opts.bootstrapSec != null ? opts.bootstrapSec : DEFAULT_BOOTSTRAP_SEC;
        this.bootstrapRateMult =
            opts.bootstrapRateMult != null ? opts.bootstrapRateMult : DEFAULT_BOOTSTRAP_RATE_MULT;
        this.minEvidenceSec = opts.minEvidenceSec != null ? opts.minEvidenceSec : DEFAULT_MIN_EVIDENCE_SEC;
        this.fastMarginDb = opts.fastMarginDb != null ? opts.fastMarginDb : DEFAULT_FAST_MARGIN_DB;
        this.fastAttackSec = opts.fastAttackSec != null ? opts.fastAttackSec : DEFAULT_FAST_ATTACK_SEC;
        this.fastReleaseSec = opts.fastReleaseSec != null ? opts.fastReleaseSec : DEFAULT_FAST_RELEASE_SEC;
        this.fastFallDbPerSec =
            opts.fastFallDbPerSec != null ? opts.fastFallDbPerSec : DEFAULT_FAST_FALL_DB_PER_SEC;
        this.louderJumpRatio = opts.louderJumpRatio != null ? opts.louderJumpRatio : DEFAULT_LOUDER_JUMP_RATIO;
        this.louderJumpSec = opts.louderJumpSec != null ? opts.louderJumpSec : DEFAULT_LOUDER_JUMP_SEC;
        this.voicedThreshold =
            opts.voicedThreshold != null ? opts.voicedThreshold : DEFAULT_VOICED_THRESHOLD;
        this.voiceHangoverSec =
            opts.voiceHangoverSec != null ? opts.voiceHangoverSec : DEFAULT_VOICE_HANGOVER_SEC;

        // `levelStaleSec: Infinity` restores the pre-fix ratchet (tests' control).
        this.levelStaleLimitSec = opts.levelStaleSec != null ? opts.levelStaleSec : DEFAULT_LEVEL_STALE_SEC;

        this.compThresholdDb =
            opts.compThresholdDb != null ? opts.compThresholdDb : DEFAULT_COMP_THRESHOLD_DB;
        this.compRatio = opts.compRatio != null ? opts.compRatio : DEFAULT_COMP_RATIO;
        this.compKneeDb = opts.compKneeDb != null ? opts.compKneeDb : DEFAULT_COMP_KNEE_DB;
        this.compAttackSec = opts.compAttackSec != null ? opts.compAttackSec : DEFAULT_COMP_ATTACK_SEC;
        this.compReleaseSec = opts.compReleaseSec != null ? opts.compReleaseSec : DEFAULT_COMP_RELEASE_SEC;
        this.baseCompThresholdDb = this.compThresholdDb;
        this.micBoostShare = opts.micBoostShare != null ? opts.micBoostShare : MIC_BOOST_TARGET_SHARE;
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

        // Bypass: when false, gain is pinned to 1.0 and never adapts - used
        // when the user has "Auto gain control" turned off. The limiter still
        // runs even in bypass, purely as safety against whatever the rest of
        // the chain hands it.
        this.enabled = opts.enabled !== false;

        // Slow gain, dB. A caller that knows this talker/device (a stored
        // per-device level) can start there; the default is unity - the fast
        // guard covers a hot mic from the first block, and a quiet one is
        // brought up within a few hundred ms.
        this.gainDb = opts.initialGainDb != null ? opts.initialGainDb : 0;
        // The gain actually applied (slow gain + fast cut), linear.
        this.gain = dbToLinear(this.gainDb);
        this.cutDb = 0; // fast guard's current reduction (<= 0)
        // Mean-square level of the talker's ACTIVE speech (input domain). Zero
        // until the first speech block.
        this.levelPower = 0;
        this.levelEstimate = 0; // sqrt(levelPower), kept for diagnostics/tests
        this.fastPower = 0; // fast mean-square detector (attack ~6 ms, release ~150 ms)
        this.activeSec = 0; // cumulative seconds of speech seen
        this.noiseFloorDb = DEFAULT_INITIAL_NOISE_FLOOR_DB; // tracked quiet-block level
        this.limiterGain = 1.0; // current limiter gain reduction (<=1, 1=no reduction)
        this.actPower = 0; // smoothed block energy for the activity decision
        this.compEnv = 0; // compressor peak envelope (linear)
        this.compReductionDb = 0; // current compressor gain reduction (<= 0)

        this.detector = new VoiceDetector(this.sampleRate);
        this.voicedHoldSec = 0;
        this.levelHoldSec = 0;
        this.levelStaleSec = 0; // voiced seconds in a row in which no block was admitted to the level estimate

        this._compGain = 1; // compressor gain (linear), ramped between evaluations
        this._ring = new Float32Array(this.lookahead);
        this._ringPos = 0;
        this._peak = 0; // loudest |sample| currently in the look-ahead ring
        this._appliedDb = this.gainDb; // gain at the end of the previous block (for the ramp)
        this._result = { gain: this.gain, voiceActive: false, gainDb: this.gainDb };
    }

    setEnabled(enabled) {
        const was = this.enabled;
        this.enabled = enabled;
        if (!enabled) {
            // Snap back to unity rather than leaving whatever gain was last
            // applied - otherwise turning AGC off mid-call would leave a
            // stale boost/cut baked in with no way to adapt it back.
            this.gainDb = 0;
            this.cutDb = 0;
            this.gain = 1.0;
            this._appliedDb = 0;
        } else if (!was) {
            // Re-enabled: relearn the talker from scratch, fast.
            this.levelPower = 0;
            this.levelEstimate = 0;
            this.fastPower = 0;
            this.activeSec = 0;
            this.voicedHoldSec = 0;
            this.levelHoldSec = 0;
            this.levelStaleSec = 0;
        }
    }

    /**
     * The Settings mic-volume slider, in dB (0 = 100 %), which now sits IN FRONT of this stage. The AGC
     * would otherwise level it away, so the slider moves what the AGC steers to: a cut moves the
     * target and the compressor threshold by the same dB (the old post-AGC cut), a boost by
     * MIC_BOOST_TARGET_SHARE of it (+7.5 dB at 200 % -> +5 dB louder on the wire). The limiter ceiling
     * does NOT move: it stays at -1 dBFS.
     */
    setMicGainDb(db) {
        const off = db > 0 ? Math.min(db * this.micBoostShare, MIC_BOOST_TARGET_MAX_DB) : db;
        this.targetRms = dbToLinear(this.baseTargetDb + off);
        this.compThresholdDb = this.baseCompThresholdDb + off;
    }

    /** Most boost allowed for active speech at `levelDb` (see DEFAULT_QUIET_BOOST_RATIO). */
    quietBoostCapDb(levelDb, targetDb) {
        if (levelDb >= targetDb) return Infinity;
        if (levelDb <= this.noBoostDb) return 0;
        const partial = (lvl) => Math.min((targetDb - lvl) * this.quietBoostRatio, this.maxQuietBoostDb);
        if (levelDb >= this.quietKneeDb) return partial(levelDb);
        return partial(this.quietKneeDb) * (levelDb - this.noBoostDb) / (this.quietKneeDb - this.noBoostDb);
    }

    _quantumRms(block) {
        let sum = 0;
        for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
        return Math.sqrt(sum / block.length);
    }

    /**
     * Process one render quantum.
     * @param inp  Float32Array of input samples for this quantum (or null).
     * @param out  Float32Array to write output into; same length as inp.
     * @returns {{ gain: number, voiceActive: boolean, gainDb: number }}
     *          diagnostics for the caller to forward upstream (the object is
     *          reused between calls - read it, do not keep it).
     */
    process(inp, out) {
        const dt = out.length / this.sampleRate;
        const res = this._result;

        if (!this.enabled) {
            // Bypassed: unity gain, limiter still runs as a safety net.
            this.gain = 1.0;
            this.gainDb = 0;
            this._applyGainAndLimiter(inp, out, 0, 0, false);
            res.gain = 1.0;
            res.gainDb = 0;
            res.voiceActive = false;
            return res;
        }

        const rms = inp ? this._quantumRms(inp) : 0;
        const p = rms * rms;

        // ── Activity (energy) ── judged on a ~12 ms smoothed energy, not on one
        // 2.7 ms block: a single block of steady noise swings by several dB on
        // its own, speech does not.
        const aAct = 1 - Math.exp(-dt / DEFAULT_ACTIVITY_SMOOTHING_SEC);
        this.actPower += (p - this.actPower) * aAct;
        const actRms = Math.sqrt(this.actPower);
        const rmsDb = linearToDb(actRms);

        // Noise floor: follow the quietest blocks down quickly, creep up
        // slowly so sustained speech cannot drag it up with it (and never above
        // what the talker's own level could justify).
        if (rmsDb < this.noiseFloorDb) {
            this.noiseFloorDb += (rmsDb - this.noiseFloorDb) * DEFAULT_NOISE_FALL_FRACTION;
        } else {
            this.noiseFloorDb += DEFAULT_NOISE_RISE_DB_PER_SEC * dt;
        }
        if (this.levelPower > 0) {
            this.noiseFloorDb = Math.min(this.noiseFloorDb, 10 * Math.log10(this.levelPower) - DEFAULT_SPEECH_TO_FLOOR_DB);
        }
        this.noiseFloorDb = clamp(this.noiseFloorDb, -90, 0);
        const energyActive = actRms >= Math.max(this.floorRms, dbToLinear(this.noiseFloorDb + this.noiseMarginDb));

        // ── Voice (pitch periodicity) ── only voiced speech arms the gain.
        if (inp) {
            if (this.detector.push(inp, energyActive) && this.detector.score >= this.voicedThreshold) {
                this.voicedHoldSec = this.voiceHangoverSec;
                this.levelHoldSec = DEFAULT_LEVEL_VOICE_HOLD_SEC;
            }
        }
        if (this.voicedHoldSec > 0) this.voicedHoldSec = Math.max(0, this.voicedHoldSec - dt);
        if (this.levelHoldSec > 0) this.levelHoldSec = Math.max(0, this.levelHoldSec - dt);
        const speech = energyActive && this.voicedHoldSec > 0;

        // ── Fast level (any sound) ── fast attack, slower release.
        const tau = p > this.fastPower ? this.fastAttackSec : this.fastReleaseSec;
        this.fastPower += (p - this.fastPower) * (1 - Math.exp(-dt / tau));
        const fastDb = 10 * Math.log10(Math.max(this.fastPower, 1e-24));

        const targetDb = linearToDb(this.targetRms);
        const minDb = linearToDb(this.minGain);
        let gainDb = this.gainDb;

        if (speech) {
            this.activeSec += dt;
            // Level of active speech: P.56-flavoured - blocks far below the
            // running level (the tail of a word, a consonant in the hangover)
            // are not "active speech" and must not pull the estimate down.
            if (this.levelHoldSec > 0 && (this.levelPower <= 0 || p >= this.levelPower * 0.025)) {
                let aSlow = Math.max(1 - Math.exp(-dt / this.levelSmoothingSec), dt / this.activeSec);
                // A talker suddenly far louder than the estimate (turned up, leaned
                // in, shouting) is learned in ~0.25 s, not ~1.5 s: the estimate may
                // fall slowly but must RISE fast, or the guard alone holds the gain
                // for the first second of loud speech.
                if (this.levelPower > 0 && p > this.levelPower * this.louderJumpRatio) aSlow = Math.max(aSlow, 1 - Math.exp(-dt / this.louderJumpSec));
                this.levelPower = this.levelPower > 0 ? this.levelPower + (p - this.levelPower) * aSlow : p;
                this.levelEstimate = Math.sqrt(this.levelPower);
                this.levelStaleSec = 0;
            } else if (this.levelHoldSec > 0) {
                // Voiced, but too far under the estimate to be admitted (see DEFAULT_LEVEL_STALE_SEC).
                this.levelStaleSec += dt;
                if (this.levelStaleSec >= this.levelStaleLimitSec) {
                    this.levelPower = Math.max(
                        this.levelPower * dbToLinear(-DEFAULT_LEVEL_STALE_FALL_DB_PER_SEC * dt) ** 2,
                        1e-24,
                    );
                    this.levelEstimate = Math.sqrt(this.levelPower);
                }
            }
            const levelDb = 10 * Math.log10(Math.max(this.levelPower, 1e-24));

            // Never boost the noise past the limit; never "cap" below unity (a
            // noisy line is not a reason to attenuate speech).
            const noiseLimitDb = Math.max(this.outputNoiseLimitDb, targetDb - this.minSnrDb);
            const noiseCapDb = Math.max(0, noiseLimitDb - this.noiseFloorDb);
            const maxDb = Math.min(linearToDb(this.maxGain), noiseCapDb, this.quietBoostCapDb(levelDb, targetDb));
            const desiredDb = clamp(targetDb - levelDb, minDb, Math.max(minDb, maxDb));

            if (this.activeSec >= this.minEvidenceSec) {
                const mult = this.activeSec < this.bootstrapSec ? this.bootstrapRateMult : 1;
                // Headroom the loud-onset ceiling leaves above the current gain.
                const headroom = targetDb + this.fastMarginDb - (fastDb + gainDb);
                if (desiredDb > gainDb) {
                    gainDb += Math.min(desiredDb - gainDb, this.riseDbPerSec * mult * dt, Math.max(0, headroom));
                } else {
                    gainDb -= Math.min(gainDb - desiredDb, this.fallDbPerSec * mult * dt);
                }
            }
            // Follow the guard's cut down (hand-over from fast to slow).
            const over = targetDb + this.fastMarginDb - (fastDb + gainDb);
            if (over < 0) gainDb += Math.max(over, -this.fastFallDbPerSec * dt);
            gainDb = clamp(gainDb, minDb, linearToDb(this.maxGain));
        }
        this.gainDb = gainDb;

        // ── Loud-onset guard ── instantaneous, any sound, this very block.
        const cutDb = Math.min(0, targetDb + this.fastMarginDb - (fastDb + gainDb));
        this.cutDb = cutDb;

        const totalDb = gainDb + cutDb;
        this._applyGainAndLimiter(inp, out, this._appliedDb, totalDb, true);
        this._appliedDb = totalDb;
        this.gain = dbToLinear(totalDb);
        res.gain = this.gain;
        res.gainDb = totalDb;
        res.voiceActive = speech;
        return res;
    }

    /**
     * Gain, then a look-ahead peak limiter: the signal is delayed by
     * `lookahead` samples (1 ms), the limiter gain is steered by the loudest
     * sample in that window - i.e. it is already down when the peak arrives at
     * the output - and a hard clamp at the ceiling guarantees nothing exceeds
     * it even if the follower is momentarily late.
     *
     * The block's gain moves from `fromDb` to `toDb`: a cut takes effect within
     * FALL_RAMP_SAMPLES (0.3 ms), a boost ramps over the block (no zipper noise).
     */
    _applyGainAndLimiter(inp, out, fromDb, toDb, ramp) {
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

        const n = out.length;
        const fromLin = dbToLinear(fromDb);
        const toLin = dbToLinear(toDb);
        const falling = toLin < fromLin;
        const rampLen = !ramp ? 0 : falling ? Math.min(n, FALL_RAMP_SAMPLES) : n;
        const step = rampLen > 0 ? (toLin - fromLin) / rampLen : 0;
        let g = ramp ? fromLin : toLin;

        let cGain = this._compGain;
        let cStep = 0;
        for (let i = 0; i < n; i++) {
            if (ramp && i < rampLen) g += step;
            else g = toLin;
            let s = (inp ? inp[i] : 0) * g;

            if (comp) {
                const a = s < 0 ? -s : s;
                this.compEnv += (a - this.compEnv) * (a > this.compEnv ? cAtk : cRel);
                // The static curve (a log10 and a pow) is evaluated every 8th
                // sample (0.17 ms - far inside the 3 ms attack) and the gain is
                // ramped between evaluations: 8x fewer transcendentals per second.
                if ((i & 7) === 0) {
                    const over = 20 * Math.log10(Math.max(this.compEnv, 1e-9)) - this.compThresholdDb;
                    let grDb = 0;
                    if (over > halfKnee) grDb = slope * over;
                    else if (over > -halfKnee) grDb = (slope * (over + halfKnee) * (over + halfKnee)) / (2 * this.compKneeDb);
                    this.compReductionDb = grDb;
                    const next = grDb < 0 ? Math.pow(10, grDb / 20) : 1;
                    cStep = (next - cGain) / 8;
                }
                cGain += cStep;
                s *= cGain;
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
            // Guard against the limiter follower ever amplifying - it exists
            // only to reduce, never to boost above what the gain stage set.
            const o = delayed * Math.min(1, this.limiterGain);
            out[i] = o > ceiling ? ceiling : o < -ceiling ? -ceiling : o;
        }
        this._ringPos = pos;
        this._peak = peak;
        this._compGain = cGain;
    }
}
