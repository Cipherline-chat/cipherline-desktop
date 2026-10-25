/**
 * Light (Speex) noise-suppression tuning, and how much latency each noise
 * suppression mode adds - the numbers Settings shows next to the mode picker.
 *
 * Boot-safe on purpose (no worklet source / WASM imports): Settings imports this
 * statically, the worklet source imports the tuning constants from here, and
 * noiseSuppressionWorklets.test.ts drives the REAL processors and fails if the
 * latencies below stop matching what they actually add.
 */

/** Sample rate the numbers are expressed at (the voice chain is pinned to 48 kHz). */
export const NS_SAMPLE_RATE = 48000;

/** Speex frame size in samples. One 128-sample render quantum, so a frame is
 *  denoised in the very call that received it. See speexLightWorkletSource.ts. */
export const SPEEX_FRAME = 128;

/** Maximum noise attenuation passed to Speex, in dB (negative). */
export const SPEEX_NOISE_SUPPRESS_DB = -40;

export type NoiseSuppressionMode = 'strong' | 'light';
export const NS_MODES: readonly NoiseSuppressionMode[] = ['strong', 'light'];

/**
 * Samples of delay each mode adds to the mic signal, measured end to end through
 * the real worklet processors at 128-sample render quanta (a speech-like signal,
 * cross-correlated input vs output).
 *   light:  Speex delays its output by exactly one frame -> SPEEX_FRAME.
 *   strong: RNNoise's own 10 ms window + the 480-sample frame accumulation + the
 *           two-frame (20 ms) output prebuffer that keeps it glitch-free under
 *           CPU load (nsKernel.js).
 */
export const NS_LATENCY_SAMPLES: Record<NoiseSuppressionMode, number> = {
    light: SPEEX_FRAME,
    strong: 1855,
};

export function nsLatencyMs(mode: NoiseSuppressionMode): number {
    return (NS_LATENCY_SAMPLES[mode] / NS_SAMPLE_RATE) * 1000;
}

/** "2.7 ms" / "39 ms" - one decimal below 10 ms, whole numbers above. */
export function formatLatencyMs(ms: number): string {
    return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export function isNoiseSuppressionMode(v: unknown): v is NoiseSuppressionMode {
    return v === 'strong' || v === 'light';
}

/** The one line under the Settings → Noise suppression cards: how Light and Strong differ. */
export function nsDifferenceLine(): string {
    return `Light only removes steady noise and adds almost no delay. Strong is an AI model that also catches sudden noise, but adds ${formatLatencyMs(nsLatencyMs('strong'))}.`;
}

/** The head-to-head the Settings picker shows. */
export function nsLatencyComparison() {
    const strongMs = nsLatencyMs('strong');
    const lightMs = nsLatencyMs('light');
    return { strongMs, lightMs, savedMs: strongMs - lightMs, ratio: strongMs / lightMs };
}
