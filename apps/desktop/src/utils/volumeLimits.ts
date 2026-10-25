/**
 * The ceiling on every volume / gain control: 200%.
 *
 * Input (mic volume) and output (speaker / master volume) are stored as a
 * percentage, 100 = unity; per-participant volume (mic and screen-share audio)
 * is stored as a linear multiplier, 1 = unity, so its ceiling is 2. They used
 * to run to 300% / 400%, which was loud enough to clip and hurt; stored values
 * above the ceiling are clamped on READ so an existing user at 300% comes down
 * to 200% without any migration step.
 */
export const MAX_VOLUME_PERCENT = 200;
/** Per-participant (mic + screen-share audio) multiplier ceiling, 1 = 100%. */
export const MAX_PER_USER_VOLUME = MAX_VOLUME_PERCENT / 100;
/** Per-participant volume default: unity (1 = 100%). Matches usePersistentVolume
 *  and useParticipantAudio's persisted-volume fallback. */
export const DEFAULT_PER_USER_VOLUME = 1;

/** A percentage clamped to 0..200; a non-number becomes `fallback`. */
export function clampVolumePercent(v: unknown, fallback = 100): number {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(MAX_VOLUME_PERCENT, v)) : fallback;
}

/** A per-participant multiplier clamped to 0..2; a non-number becomes `fallback`. */
export function clampPerUserVolume(v: unknown, fallback = 1): number {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(MAX_PER_USER_VOLUME, v)) : fallback;
}
