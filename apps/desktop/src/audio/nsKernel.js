/**
 * NsOutputRing — the noise-suppression output jitter buffer, extracted as
 * plain dependency-free JS so it can run in two places from one source of
 * truth:
 *
 *   1. Concatenated (via `?raw` import) into the AudioWorklet processor
 *      source string in rnnoiseWorkletSource.ts, where it does the actual
 *      work on the realtime audio thread.
 *   2. Imported directly into nsKernel.test.ts for deterministic Vitest
 *      coverage — no AudioContext, no Worker, no real time involved.
 *
 * Plain .js (not .ts) on purpose: code destined for a Blob-URL AudioWorklet
 * module must be directly executable JS with no build-step transform, the
 * same way GATE_WORKLET_SOURCE and the rest of the worklet sources already
 * are.
 *
 * ── The bug this replaces ──────────────────────────────────────────────
 * The previous ring buffer had no prebuffer and, on any underrun (the
 * RNNoise Worker falling behind — normal under CPU load from a game),
 * substituted raw mic audio for the whole quantum AND discarded every
 * sample of processed audio it had buffered (`outR = outW`). Under
 * sustained load the Worker misses deadlines constantly, so output
 * oscillated between processed and raw audio every ~2.67 ms — audible as
 * a "helicopter blades" artifact, made worse because the raw splices
 * carried none of RNNoise's compensation gain while everything around them
 * did.
 *
 * This version:
 *   - Primes a ~20 ms cushion before ever switching to processed output,
 *     so a single early hiccup can't immediately re-trigger a splice.
 *   - On a partial underrun, only the missing samples are raw-filled — the
 *     ring's read pointer is NOT reset, so nothing buffered is thrown away
 *     and the next quantum picks up exactly where it left off.
 *   - Crossfades the raw→processed transition over one render quantum
 *     instead of hard-cutting.
 *   - Applies the post-RNNoise compensation gain only to samples that were
 *     actually processed — raw-passthrough samples get unity gain, so a
 *     splice is a discontinuity in content, not also a ~3.5 dB level jump.
 *   - Trips into an explicit BYPASS state (raw passthrough, no ring
 *     activity) with hysteresis + backoff when the underrun rate is high
 *     enough that "briefly unprocessed" would otherwise become "constantly
 *     flickering" — the load-adaptive auto-bypass Discord/Krisp use.
 */

// RNNoise operates on 480-sample frames (10 ms at 48 kHz) — not negotiable,
// see RNNOISE_SAMPLE_RATE in voiceProcessor.ts.
export const RNNOISE_FRAME = 480;

// Ring buffer sized for 8 frames of headroom (~80 ms) — generous margin for
// Worker round-trip jitter under load without growing unbounded.
export const RING_FRAMES = 8;
export const RING_SIZE = RNNOISE_FRAME * RING_FRAMES;

// Phase 3 (in-worklet synchronous RNNoise): the max number of accumulated
// 480-sample frames the inline worklet will run processFrame() on within a
// single 128-sample process() call. Steady-state, a new frame becomes ready
// roughly every 3.75 quanta, so most calls process zero or one — this only
// matters for catch-up bursts (e.g. right after RNNoise finishes loading, or
// after a real-time-thread hiccup let input pile up). Bounding it caps the
// worst case per-call cost at 2x a normal frame instead of draining an
// entire multi-frame backlog in one call, which is its own way to blow the
// render-quantum deadline. Deliberately NOT a wall-clock timeout — see
// NsOutputRing's underrun/hysteresis machinery below, which already detects
// "can't keep the output ring topped up" from pure sample counting and
// degrades to bypass, exactly like it did for the old Worker-fed design.
export const MAX_INLINE_FRAMES_PER_QUANTUM = 2;

// Prebuffer target before ever switching from raw to processed output: two
// RNNoise frames (~20 ms). Below this, a single Worker hiccup empties the
// ring immediately and we're right back to flip-flopping every quantum.
export const PREBUFFER_SAMPLES = RNNOISE_FRAME * 2;

// Crossfade length when priming completes and we switch raw → processed —
// one 128-sample render quantum. Long enough to hide the splice as a level
// blend rather than a click; short enough to be inaudible as a "swoosh".
export const CROSSFADE_SAMPLES = 128;

// ── Hysteresis clock ─────────────────────────────────────────────────────
// Render quanta (128 samples @ 48 kHz ≈ 2.667 ms each) double as a clock so
// the trip/cooldown/backoff timers are exact and reproducible in tests
// without depending on Date.now()/performance.now() (neither is reliably
// available inside AudioWorkletGlobalScope, and both are unavailable in
// workflow scripts — quanta counting sidesteps the whole question).
const QUANTUM_MS = (128 / 48000) * 1000; // ≈2.667 ms
export function quantaFor(ms) {
    return Math.round(ms / QUANTUM_MS);
}

// More than this many underrun quanta within the rolling window trips
// auto-bypass.
export const UNDERRUN_TRIP_COUNT = 20;
export const UNDERRUN_WINDOW_QUANTA = quantaFor(3000); // 3 s rolling window
export const BYPASS_COOLDOWN_QUANTA = quantaFor(10000); // 10 s before first retry
export const BYPASS_BACKOFF_QUANTA = quantaFor(60000); // 60 s after a fast repeat failure

// CRITICAL FIX (found while building Phase 3): rnnoiseWorkletSource.ts's
// _reportStats referenced a bare `STATS_INTERVAL_QUANTA` that was never
// defined anywhere in scope — nsKernel.js didn't export it, and nothing else
// in the concatenated worklet source declared it either. That reference is
// evaluated unconditionally on every process() call
// (`if (this.statsQuantaSinceReport >= STATS_INTERVAL_QUANTA)`), so it threw
// `ReferenceError: STATS_INTERVAL_QUANTA is not defined` on the very first
// render quantum of every call using this worklet — i.e. noise suppression
// was very likely completely broken (uncaught exception in process() marks
// an AudioWorkletProcessor inactive per spec). Untestable via Vitest (which
// only covers NsOutputRing's pure logic, not the assembled worklet source's
// runtime correctness), so nothing caught it. Defined here (after
// quantaFor/QUANTUM_MS, which it depends on), matching agcWorkletSource.ts's
// "~1/s" throttling intent via the same quanta-counting approach as
// everything else in this file.
export const STATS_INTERVAL_QUANTA = quantaFor(1000);

export const NsState = Object.freeze({
    PRIMING: 'priming',
    ACTIVE: 'active',
    BYPASS: 'bypass',
});

/**
 * Owns the processed-audio ring buffer, the priming/crossfade state
 * machine, and the underrun-hysteresis auto-bypass logic. One instance per
 * RNNoise worklet node (local mic chain, or one per remote participant with
 * per-user NS enabled).
 */
export class NsOutputRing {
    constructor(opts) {
        opts = opts || {};
        this.size = opts.ringSize || RING_SIZE;
        this.buf = new Float32Array(this.size);
        this.w = 0;
        this.r = 0;
        this.prebufferSamples = opts.prebufferSamples || PREBUFFER_SAMPLES;
        this.crossfadeSamples = opts.crossfadeSamples || CROSSFADE_SAMPLES;
        this.compGain = opts.compGain != null ? opts.compGain : 1.0;
        this.state = NsState.PRIMING;
        this.fadeRemaining = 0;
        this.quanta = 0;
        this.underrunLog = [];
        this.bypassUntilQuanta = 0;
        this.consecutiveFastTrips = 0;
        this.lastTripQuanta = -Infinity;
        // Reused for every process() call: this runs ~375 times a second on
        // the real-time audio thread, where every allocation is future GC
        // work on the one thread that must never stall.
        this._result = { underrun: false, bypassTripped: false, bypassRecovered: false };
    }

    /** Drop all buffered audio and restart priming from empty. */
    reset() {
        this.w = 0;
        this.r = 0;
        this.state = NsState.PRIMING;
        this.fadeRemaining = 0;
    }

    setCompGain(gain) {
        this.compGain = gain;
    }

    available() {
        return this.w - this.r;
    }

    /** Push one processed sample (from a Worker-returned frame) into the ring. */
    push(sample) {
        this.buf[this.w % this.size] = sample;
        this.w++;
    }

    /**
     * Process one render quantum in place.
     *
     * @param raw   Float32Array of live input samples for this quantum (or
     *              null/undefined if no input is connected — filled with 0).
     * @param out   Float32Array to write output into; `raw` and `out` must
     *              be the same length.
     * @param opts.bypassed  Force raw passthrough regardless of ring state
     *              (used when NS is toggled off entirely by the user). The
     *              quanta clock still advances so hysteresis timers stay
     *              correct across a manual bypass window, but no underrun
     *              is recorded — this is an intentional off state, not the
     *              ring falling behind.
     *
     * @returns {{ underrun: boolean, bypassTripped: boolean, bypassRecovered: boolean }}
     *          The SAME object on every call (no per-quantum allocation on
     *          the audio thread) — read it before calling process() again.
     */
    process(raw, out, opts) {
        this.quanta++;
        const result = this._result;
        result.underrun = false;
        result.bypassTripped = false;
        result.bypassRecovered = false;

        if (opts && opts.bypassed) {
            for (let i = 0; i < out.length; i++) out[i] = raw ? raw[i] : 0;
            return result;
        }

        if (this.state === NsState.BYPASS) {
            if (this.quanta < this.bypassUntilQuanta) {
                for (let i = 0; i < out.length; i++) out[i] = raw ? raw[i] : 0;
                return result;
            }
            // Cooldown elapsed — drop anything stale that queued up during the
            // bypass window and retry priming clean.
            this.state = NsState.PRIMING;
            this.r = this.w;
            result.bypassRecovered = true;
        }

        if (this.state === NsState.PRIMING) {
            if (this.available() >= this.prebufferSamples) {
                this.state = NsState.ACTIVE;
                this.fadeRemaining = this.crossfadeSamples;
            } else {
                for (let i = 0; i < out.length; i++) out[i] = raw ? raw[i] : 0;
                return result;
            }
        }

        // state === ACTIVE
        const avail = this.available();
        const take = Math.min(avail, out.length);
        if (take < out.length) result.underrun = true;

        for (let i = 0; i < out.length; i++) {
            let sample;
            if (i < take) {
                sample = this.buf[this.r % this.size] * this.compGain;
                this.r++;
                if (this.fadeRemaining > 0) {
                    const mix = 1 - this.fadeRemaining / this.crossfadeSamples;
                    const rawSample = raw ? raw[i] : 0;
                    sample = rawSample * (1 - mix) + sample * mix;
                    this.fadeRemaining--;
                }
            } else {
                // Deficit: pass the live input through unprocessed, unity gain,
                // WITHOUT touching the ring's read pointer — nothing buffered is
                // lost or time-shifted, and the ring simply resumes from where
                // it left off as soon as the Worker catches up.
                sample = raw ? raw[i] : 0;
            }
            out[i] = sample;
        }

        if (result.underrun) {
            this.underrunLog.push(this.quanta);
            this._pruneUnderrunLog();
            if (this.underrunLog.length >= UNDERRUN_TRIP_COUNT) {
                this.state = NsState.BYPASS;
                result.bypassTripped = true;
                const fastRepeat =
                    this.quanta - this.lastTripQuanta <
                    (UNDERRUN_WINDOW_QUANTA + BYPASS_COOLDOWN_QUANTA) * 2;
                this.consecutiveFastTrips = fastRepeat ? this.consecutiveFastTrips + 1 : 0;
                this.lastTripQuanta = this.quanta;
                const cooldown =
                    this.consecutiveFastTrips >= 1 ? BYPASS_BACKOFF_QUANTA : BYPASS_COOLDOWN_QUANTA;
                this.bypassUntilQuanta = this.quanta + cooldown;
                this.underrunLog = [];
                // We've given up for the cooldown window — the ring's remaining
                // contents will be stale (by the cooldown duration) by the time
                // we'd resume it, so drop them rather than play back a chunk of
                // audio that's now seconds behind the raw passthrough we've
                // been emitting.
                this.r = this.w;
            }
        }

        return result;
    }

    _pruneUnderrunLog() {
        const cutoff = this.quanta - UNDERRUN_WINDOW_QUANTA;
        while (this.underrunLog.length && this.underrunLog[0] < cutoff) this.underrunLog.shift();
    }
}
