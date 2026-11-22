/**
 * The Settings mic-volume slider (0..200, % of unity) as a gain: a perceptual power curve so the slider feels uniform.
 * At 100 the gain is exactly 1.0 (no surprise change for anyone who never touched it). Exponent 1.25 is gentler than the
 * per-user playback curve (1.5) because outgoing voice goes through levelling, which already nonlinearises things.
 * Shared by the legacy chain (a GainNode in front of the AGC) and the new audio engine (manual gain, in dB).
 */
export const MIC_GAIN_EXPONENT = 1.25;

export const micSliderToGain = (slider: number): number =>
    Math.pow(Math.max(0, slider) / 100, MIC_GAIN_EXPONENT);

/** The slider in dB (-120 at 0 %). */
export function micSliderToDb(slider: number): number {
    const g = micSliderToGain(slider);
    return g > 0 ? 20 * Math.log10(g) : -120;
}
