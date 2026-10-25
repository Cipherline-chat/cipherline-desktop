/**
 * Listener-side loudness cap for custom entrance sounds.
 *
 * The sender's device normalizes a custom sound (TARGET_LUFS, true peak under
 * -1 dBTP), but a modified client could send anything. So the LISTENER
 * measures what it actually decoded and scales it down - never up - until it
 * is no louder than the built-in entrance sounds:
 *
 *   gain = min(1, BUILTIN_PEAK / truePeak, 10^((LISTENER_MAX_LUFS - lufs) / 20))
 *
 * and plays it at ENTRANCE_VOLUME * gain * master volume, i.e. through the
 * same element volume as a built-in sound, times a factor <= 1.
 *
 * Reference points (measured with process.ts on the built-in catalog):
 * built-ins are normalized to a 0.8 sample peak and integrate between about
 * -21 and -11 LUFS. A custom sound is capped at the 0.8 peak and at -16 LUFS,
 * so it is never above the built-ins' peak and never louder than the
 * middle of their loudness range.
 */

import { TARGET_LUFS } from './constants';
import { downmix, integratedLoudness, truePeak } from './process';

export const BUILTIN_PEAK = 0.8;
export const LISTENER_MAX_LUFS = TARGET_LUFS;
/** A decoded sound quieter than this is not worth playing (and its gain would be meaningless). */
const MIN_PEAK = 1e-4;

/** Gain 0..1 for decoded channels at `sampleRate`; 0 = do not play. */
export function listenerGain(channels: readonly Float32Array[], sampleRate: number): number {
    const mono = downmix(channels);
    if (mono.length === 0) return 0;
    // Peak over every channel, so a hot side of a stereo file is not averaged away.
    let tp = 0;
    for (const ch of channels) tp = Math.max(tp, truePeak(ch));
    if (!(tp > MIN_PEAK)) return 0;
    const lufs = integratedLoudness(mono, sampleRate);
    const byPeak = BUILTIN_PEAK / tp;
    const byLoudness = Number.isFinite(lufs) ? Math.pow(10, (LISTENER_MAX_LUFS - lufs) / 20) : 1;
    return Math.max(0, Math.min(1, byPeak, byLoudness));
}
