/**
 * GateCutMeter - is the (fixed) voice gate closing on the user's own voice?
 *
 * Owner 2026-11-17: "we should find a way to detect if people are talking and the noise gate is cutting them out to
 * prompt for it". Detection only: nothing here ever moves the threshold (the automatic gate was removed the same day).
 *
 * Runs inside the gate worklet, on the signal the gate decides on (after noise suppression, before mic volume and AGC),
 * once per 128-sample block. A block is VOICE when the pitch detector the AGC uses (VoiceDetector, voiced = periodic at
 * 70-500 Hz) has scored at least GC_SCORE on GC_MIN_RUN analyses in a row (12 ms apart) - one voiced frame on its own is
 * not enough: Light's fan residual produces isolated "voiced" frames (8.4 % of them, 82 % alone, audit 2026-11-17) while
 * speech syllables run ~14. The meter counts, per report interval:
 *   voiced   blocks of voice;
 *   gated    ... of which the gate passed less than half (gain < 0.5 at the end of the block);
 *   vms      sum of the voiced blocks' mean-square (their level);
 *   starts   phrase starts: the first voice after GC_PHRASE_GAP_SEC without any;
 *   clipped  ... of which the gate was closed on at least half of the first GC_START_BLOCKS voice blocks;
 *   closes   mid-phrase cuts: the gate closed within GC_CLOSE_AFTER_VOICE_SEC of voice and voice came back within
 *            GC_CLOSE_RESUME_SEC still under the gate (the talker was cut inside a phrase; a pause that the next word
 *            reopens is not counted);
 *   blocks   all blocks of the interval (while the gate is on);
 *   noise    blocks the gate PASSED (gain >= 0.5) that are audible (>= GC_MIN_DB) and more than GC_NOISE_AFTER_VOICE_SEC
 *            from any voice: key clicks, a loud room, a TV - sound that is not the talker and that the AGC then lifts with
 *            the talker's gain (owner report 5ffa77e6, 2026-11-18). Read by the background-noise prompt
 *            (utils/noiseFloorPrompt.ts), not by the gate-cut decision;
 *   bursts   sounds that crossed the threshold away from voice and were not followed by voice within
 *            GC_BURST_CONFIRM_SEC (a phrase start is followed by voice, a key click is not): typing, knocks.
 * Numbers only, never audio. The decision (is that "cutting you off"?) is made on the main thread from a window of
 * these (utils/gateCut.ts), so it can be tested on its own.
 *
 * Needs VoiceDetector (agcKernel.js) in the same scope: the worklet source inlines both, tests import both.
 */
import { VoiceDetector } from './agcKernel.js';

/** Quietest block (dBFS RMS) the pitch analysis runs on: under it there is nothing a listener would miss. */
export const GC_MIN_DB = -62;
export const GC_SCORE = 0.55;
export const GC_MIN_RUN = 2;
/** Voiced analyses further apart than this do not form a run; a block is voice for this long after the last one. */
export const GC_RUN_GAP_SEC = 0.05;
export const GC_PHRASE_GAP_SEC = 0.3;
/** Voice blocks (2.7 ms each) at a phrase start that decide "clipped" (about 21 ms). */
export const GC_START_BLOCKS = 8;
/** A gate close counts as mid-phrase when voice was heard this recently before it ... */
export const GC_CLOSE_AFTER_VOICE_SEC = 0.15;
/** ... and voice comes back this soon after it. */
export const GC_CLOSE_RESUME_SEC = 0.5;
/** Passed sound this long after the last voice block is not the talker's (their word tail + the gate's 150 ms hold +
 *  50 ms release are inside it). A phrase start before its first voiced analysis (~20-40 ms) still counts: small. */
export const GC_NOISE_AFTER_VOICE_SEC = 0.3;
/** A threshold crossing away from voice is a phrase start if voice follows within this, else a burst (a key click). */
export const GC_BURST_CONFIRM_SEC = 0.12;

export class GateCutMeter {
    constructor(sampleRate) {
        this.sampleRate = sampleRate;
        this.vd = new VoiceDetector(sampleRate);
        this.minRms = Math.pow(10, GC_MIN_DB / 20);
        this.run = 0;
        this.sinceVoiced = Infinity; // seconds since the last voiced analysis
        this.sinceVoice = Infinity;  // seconds since the last voice block
        this.startLeft = 0;          // voice blocks of the current phrase start still to judge
        this.startGated = 0;
        this.passed = true;          // the gate's state on the previous block
        this.pendingClose = 0;       // seconds left for voice to come back after a close that followed voice
        this.wasOver = false;        // the previous block was over the gate threshold
        this.pendingBurst = 0;       // seconds left for voice to follow a crossing away from voice
        this.reset();
    }

    reset() {
        this.voiced = 0;
        this.gated = 0;
        this.vms = 0;
        this.starts = 0;
        this.clipped = 0;
        this.closes = 0;
        this.blocks = 0;
        this.noise = 0;
        this.bursts = 0;
    }

    /** Forget the talker state (gate switched off / on, a new call). Counts are kept until take(). */
    clearState() {
        this.run = 0;
        this.sinceVoiced = Infinity;
        this.sinceVoice = Infinity;
        this.startLeft = 0;
        this.startGated = 0;
        this.passed = true;
        this.pendingClose = 0;
        this.wasOver = false;
        this.pendingBurst = 0;
    }

    /**
     * One block. `rms` = the block's RMS (the gate computes it anyway), `passed` = the gate let it through
     * (gain >= 0.5 at the end of the block), `over` = the block was over the gate threshold.
     */
    push(block, rms, passed, over = false) {
        const dt = block.length / this.sampleRate;
        this.blocks++;
        this.sinceVoiced += dt;
        this.sinceVoice += dt;
        if (this.sinceVoiced > GC_RUN_GAP_SEC) this.run = 0;
        if (this.pendingClose > 0) this.pendingClose -= dt;
        if (this.pendingBurst > 0) { this.pendingBurst -= dt; if (this.pendingBurst <= 0) this.bursts++; }
        if (over && !this.wasOver && this.sinceVoice > GC_NOISE_AFTER_VOICE_SEC && this.pendingBurst <= 0) this.pendingBurst = GC_BURST_CONFIRM_SEC;
        this.wasOver = over;
        if (this.passed && !passed && this.sinceVoice <= GC_CLOSE_AFTER_VOICE_SEC) this.pendingClose = GC_CLOSE_RESUME_SEC;
        this.passed = passed;
        if (this.vd.push(block, rms >= this.minRms)) {
            if (this.vd.score >= GC_SCORE) { this.run++; this.sinceVoiced = 0; } else this.run = 0;
        }
        const voice = this.run >= GC_MIN_RUN && this.sinceVoiced <= GC_RUN_GAP_SEC && rms >= this.minRms;
        if (!voice) {
            if (passed && rms >= this.minRms && this.sinceVoice > GC_NOISE_AFTER_VOICE_SEC) this.noise++;
            return;
        }
        if (this.sinceVoice > GC_PHRASE_GAP_SEC) {
            if (this.startLeft > 0) this.closeStart(); // a start shorter than GC_START_BLOCKS
            this.starts++;
            this.startLeft = GC_START_BLOCKS;
            this.startGated = 0;
        }
        this.sinceVoice = 0;
        this.pendingBurst = 0; // voice followed the crossing: a phrase start, not a burst
        // a close is a cut only if the voice that comes back is still under the gate (not a pause the next word reopens)
        if (this.pendingClose > 0) { if (!passed) this.closes++; this.pendingClose = 0; }
        this.voiced++;
        this.vms += rms * rms;
        if (!passed) this.gated++;
        if (this.startLeft > 0) {
            if (!passed) this.startGated++;
            if (--this.startLeft === 0) this.closeStart();
        }
    }

    closeStart() {
        // judged on the blocks it had (GC_START_BLOCKS unless the phrase was shorter)
        const seen = GC_START_BLOCKS - this.startLeft;
        if (seen > 0 && this.startGated * 2 >= seen) this.clipped++;
        this.startLeft = 0;
        this.startGated = 0;
    }

    /** The counts since the last take(), and a fresh interval. */
    take() {
        const r = { voiced: this.voiced, gated: this.gated, vms: this.vms, starts: this.starts, clipped: this.clipped, closes: this.closes, blocks: this.blocks, noise: this.noise, bursts: this.bursts };
        this.reset();
        return r;
    }
}
