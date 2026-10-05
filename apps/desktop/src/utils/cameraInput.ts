/**
 * Camera device selection — the video counterpart to audioInput.ts's mic
 * helpers. Kept as a separate small file rather than folding into
 * audioInput.ts (which is deliberately mic-scoped, per its own header
 * comment, and has its own pinned test file) even though the logic mirrors
 * `pickMicDeviceId`/`resolveMicDeviceId` closely — `hasRealDeviceInfo` is
 * already kind-agnostic and is reused directly from audioInput.ts rather
 * than duplicated.
 *
 * Why this exists: before this, camera hot-swap had none of the
 * reliability engineering the mic path got. LiveKit's own
 * `selectDefaultDevices()` explicitly EXCLUDES video from its "fall back to
 * first available device" branch (a library-level choice, true in every
 * browser), and its `handleTrackEnded` restart path for a dead video track
 * reuses the SAME (now-unplugged) camera's deviceId non-`exact` rather than
 * overriding to a fallback the way it does for audio — so camera hot-swap
 * recovery has to be handled at the app level, the same way mic hot-swap
 * already is via syncMicDevice in SidebarConference.tsx.
 */

/**
 * Chromium synthesises a 'default' videoinput entry the same way it does for
 * audioinput — see DEFAULT_AUDIO_INPUT_ID in audioInput.ts for the full
 * explanation of why this differs from omitting deviceId entirely.
 */
export const DEFAULT_CAMERA_ID = 'default';

/** Resolve a stored settings value to a device id usable as a getUserMedia
 *  constraint. '' / null / undefined all mean "follow the system default". */
export function resolveCameraDeviceId(stored: string | null | undefined): string {
    return stored ? stored : DEFAULT_CAMERA_ID;
}

/**
 * Pick the camera we should actually be capturing from, given what the user
 * asked for and what currently exists. Same reasoning as pickMicDeviceId:
 * an explicitly-chosen device wins only while it still exists; a stored id
 * pointing at a now-unplugged camera falls back to following the system
 * default rather than pinning to a device that's gone.
 */
export function pickCameraDeviceId(
    stored: string | null | undefined,
    availableInputs: readonly MediaDeviceInfo[],
): string {
    if (stored && availableInputs.some(d => d.deviceId === stored)) return stored;
    return DEFAULT_CAMERA_ID;
}
