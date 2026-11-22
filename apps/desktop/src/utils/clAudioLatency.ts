/**
 * Latency of the new call-audio engine ('v2' audio engine), in samples at 48 kHz, per profile. Boot-safe (no worklet /
 * WASM imports), like nsLatency.ts.
 *
 * Three parts add up (audio/clAudioWorklet.js, crates/cl-audio):
 *   prime:   the worklet answers in 128-sample render quanta but the engine answers in 480-sample bursts; the output
 *            FIFO is primed with 448 samples (the worst shortfall, max(128k mod 480)) so a quantum can never find it
 *            empty. Every profile pays this.
 *   engine:  what cla_delay_samples() reports: 480 for Light (RNNoise's analysis window), 0 for Off and original sound.
 *   rest:    ~45 samples the engine does not report (its 80 Hz high-pass and the AGC2 limiter's look-ahead). Original
 *            sound skips them (bit-exact bypass).
 *
 * The numbers below are MEASURED end to end (cross-correlating synthetic speech in and out of the real worklet running
 * the real wasm) by clAudioWorklet.test.ts, which fails if they drift: Light is nonlinear, so its correlation peak is
 * good to a few samples (LATENCY_TOLERANCE_SAMPLES), and so is Off (the high-pass has frequency-dependent delay); original
 * sound is exact.
 *   light:  448 + 480 + ~43 = 971 samples = 20.2 ms   (the legacy 'strong' chain is 1855 = 38.7 ms, 'light' 128 = 2.7 ms)
 *   off:    448 +   0 + ~46 = 494 samples = 10.3 ms
 *   bypass: 448 samples = 9.3 ms
 */
export const CL_AUDIO_SAMPLE_RATE = 48000;
export const CL_AUDIO_PRIME_SAMPLES = 448;
export const CL_AUDIO_ENGINE_DELAY_SAMPLES = { light: 480, off: 0, bypass: 0 } as const;

export type ClAudioLatencyKind = 'light' | 'off' | 'bypass';

export const CL_AUDIO_LATENCY_SAMPLES: Record<ClAudioLatencyKind, number> = {
    light: 971,
    off: 494,
    bypass: 448,
};

/** Light's and Off's correlation peaks move by a few samples with the signal; bypass is exact. */
export const LATENCY_TOLERANCE_SAMPLES = 4;

export function clAudioLatencyMs(kind: ClAudioLatencyKind = 'light'): number {
    return (CL_AUDIO_LATENCY_SAMPLES[kind] / CL_AUDIO_SAMPLE_RATE) * 1000;
}

/**
 * Strong (FastEnhancer B+S in a worker thread, utils/clAudioNative.ts). Its own delay is much longer than Light's: the two
 * models work on 32 ms windows of 16 kHz audio and the engine reports 3072 samples (64 ms) for it. The worklet keeps its own
 * Light engine running as a safety net and, so that a late Strong frame can be replaced by the SAME moment of Light audio, delays
 * Light's content to match (audio/clAudioWorklet.js, "TIME ALIGNMENT"). On top of that come whole 10 ms frames of playout delay
 * for the hand-off: frame f plays at output sample (448 + 480 * jitterFrames + 480 * f). Three frames: the models need about
 * 3 ms of a 10 ms frame on an ordinary PC and the answer crosses two thread hops; a late answer costs nothing audible (the
 * aligned Light frame of the same slot plays instead).
 *
 *   strong: 448 + 480 * 3 + 3072 + ~45 = 5005 samples = 104 ms    (Light: 971 samples = 20 ms)
 *
 * `~45` is the high-pass / limiter look-ahead the engine does not report (the same in every profile). The figure is measured end
 * to end by audio/clAudioWorkletAlign.test.ts with the real worklet and the real engine.
 */
export const CL_NATIVE_JITTER_FRAMES = 3;
export const CL_NATIVE_FRAME_SAMPLES = 480;
/** What the Strong engine reports as its algorithmic delay (cla_delay_samples with noise = Strong). The worklet needs it up front to
 *  line Light up with it, the worker repeats it when it is ready, and clAudioWorkletAlign.test.ts checks it against the real wasm. */
export const CL_STRONG_ENGINE_DELAY_SAMPLES = 3072;
/** The look-ahead both engines have beyond what they report (see the file header: "rest"). */
export const CL_AUDIO_UNREPORTED_SAMPLES = 45;

/** Mic-to-network delay of Strong in samples. */
export function clNativeStrongLatencySamples(jitterFrames: number = CL_NATIVE_JITTER_FRAMES): number {
    return CL_AUDIO_PRIME_SAMPLES + CL_NATIVE_FRAME_SAMPLES * jitterFrames + CL_STRONG_ENGINE_DELAY_SAMPLES + CL_AUDIO_UNREPORTED_SAMPLES;
}
export function clNativeStrongLatencyMs(jitterFrames: number = CL_NATIVE_JITTER_FRAMES): number {
    return (clNativeStrongLatencySamples(jitterFrames) / CL_AUDIO_SAMPLE_RATE) * 1000;
}
