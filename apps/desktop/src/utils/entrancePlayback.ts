import { entranceSoundUrl } from './entranceSounds';
import { playGeneratedSound, previewSound, type SoundsPrefs } from './notificationSounds';

/** Where entrance sounds sit on the loudness ladder: ambient peer actions (join/leave are 0.7). */
export const ENTRANCE_VOLUME = 0.6;

/** Someone else's entrance sound, through the app's sound path (output device + master volume). */
export function playEntranceSound(id: string, prefs?: SoundsPrefs | null): void {
    const url = entranceSoundUrl(id);
    if (url) playGeneratedSound(url, ENTRANCE_VOLUME, prefs);
}

/** The picker's Preview button: always audible (like the notification "Test"), at the master level. */
export function previewEntranceSound(id: string, prefs?: SoundsPrefs | null): void {
    const url = entranceSoundUrl(id);
    if (url) previewSound(url, ENTRANCE_VOLUME * (prefs?.master_volume ?? 0.8));
}

/**
 * Listener-side volume for a CUSTOM entrance sound: the built-in level times
 * the gain measured on decode (utils/customEntranceSound/playbackGain.ts),
 * clamped to 0..1, so a custom sound is never played louder than a built-in
 * one at the same master volume. Exported for tests.
 */
export function customEntranceVolume(gain: number): number {
    const g = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 0;
    return ENTRANCE_VOLUME * g;
}

/** Someone else's custom entrance sound (a verified, cached blob: URL), through the same path as a built-in one. */
export function playCustomEntranceSound(url: string, gain: number, prefs?: SoundsPrefs | null): void {
    const v = customEntranceVolume(gain);
    if (url && v > 0) playGeneratedSound(url, v, prefs);
}

/** Preview YOUR custom sound in Settings (always audible, at the master level, same cap). */
export function previewCustomEntranceSound(url: string, gain: number, prefs?: SoundsPrefs | null): void {
    const v = customEntranceVolume(gain);
    if (url && v > 0) previewSound(url, v * (prefs?.master_volume ?? 0.8));
}
