/**
 * mediaSelfStop - decide whether OUR camera / screen share stopped on its own,
 * and say why. Pure logic, LiveKit-free; components/call/LocalMediaStopGuard
 * does the Room plumbing.
 *
 * Why it exists (staging.229 reports, one tester): "camera randomly turns off
 * with no audio to indicate it shut off", "screenshare stopped itself". The
 * evidence was share_power restore/apply pairs (the webcam went not-live and
 * came back) with NOTHING saying why. Three silences stacked:
 *   - CallPane skips the LOCAL camera's TrackMuted event for sounds (the press
 *     plays camera_off itself - toggleCamera), so a mute nobody pressed made no
 *     sound;
 *   - livekit-client mutes a camera whose MediaStreamTrack `ended` and could not
 *     be restarted (Room handleTrackEnded: restartTrack, else track.mute()) without
 *     a word to the app;
 *   - nothing logged a track `ended`, a mute, or an unexpected unpublish.
 *
 * A stop is "unprompted" when no press (toggleCamera / its keybind) happened
 * just before it and no deliberate republish is under way.
 */

/** A press this recent explains a camera mute (the track events arrive a few hundred ms after the press). */
export const USER_INTENT_WINDOW_MS = 5_000;
/** A track `ended` this long before a mute is taken as the cause of it. */
export const ENDED_CAUSE_WINDOW_MS = 15_000;
/** A camera / share unpublish with no new publication this soon after is a stop, not a republish. */
export const UNPUBLISH_SETTLE_MS = 3_000;

let lastUserCameraAt = Number.NEGATIVE_INFINITY;

/** The user pressed the camera button / keybind (SidebarConference.toggleCamera). */
export function noteUserCameraAction(now: number = Date.now()): void { lastUserCameraAt = now; }
export function userCameraActionRecent(now: number = Date.now(), windowMs: number = USER_INTENT_WINDOW_MS): boolean {
    return now - lastUserCameraAt >= 0 && now - lastUserCameraAt < windowMs;
}

/** A stop or restart of the share the APP or the user asked for explains the unpublish that follows. */
export const DELIBERATE_SHARE_WINDOW_MS = 15_000;
let lastDeliberateShareAt = Number.NEGATIVE_INFINITY;
export function noteDeliberateShareChange(now: number = Date.now()): void { lastDeliberateShareAt = now; }
export function deliberateShareChangeRecent(now: number = Date.now(), windowMs: number = DELIBERATE_SHARE_WINDOW_MS): boolean {
    return now - lastDeliberateShareAt >= 0 && now - lastDeliberateShareAt < windowMs;
}
export function __resetMediaSelfStopForTests(): void {
    lastUserCameraAt = Number.NEGATIVE_INFINITY;
    lastDeliberateShareAt = Number.NEGATIVE_INFINITY;
}

export type CameraStopReason = 'device_ended' | 'muted_unprompted' | 'unpublished_unprompted';

export interface CameraStopFacts {
    /** What LiveKit reported: the publication was muted, or unpublished. */
    event: 'muted' | 'unpublished';
    /** The user pressed the camera control just before. */
    userRecent: boolean;
    /** A deliberate make-before-break republish is in flight (cameraPublish.isCameraRepublishing). */
    republishing: boolean;
    /** ms since the capture track last fired `ended`, or null if it has not. */
    sinceEndedMs: number | null;
    /** The room is connected (a leave unpublishes everything and is not a self-stop). */
    roomConnected: boolean;
    /** For 'unpublished': a camera publication exists again after the settle window. */
    replacementPresent?: boolean;
}

/** The reason, or null when this is NOT an unprompted stop (a press, a republish, a leave, a swap that landed). */
export function classifyCameraStop(f: CameraStopFacts): CameraStopReason | null {
    if (!f.roomConnected || f.userRecent) return null;
    if (f.event === 'muted') {
        if (f.sinceEndedMs !== null && f.sinceEndedMs >= 0 && f.sinceEndedMs < ENDED_CAUSE_WINDOW_MS) return 'device_ended';
        return 'muted_unprompted';
    }
    if (f.republishing || f.replacementPresent) return null;
    return 'unpublished_unprompted';
}

export type ShareEndReason = 'capture_ended' | 'unpublished_unprompted';

export interface ShareEndFacts {
    roomConnected: boolean;
    /** The user pressed stop, or the app is restarting the share on purpose (a start in flight, a hold armed). */
    deliberate: boolean;
    /** Another screen-share publication is present after the settle window (a swap landed). */
    replacementPresent: boolean;
    /** ms since a screen-share capture track fired `ended`, or null. */
    sinceEndedMs: number | null;
}

export function classifyShareEnd(f: ShareEndFacts): ShareEndReason | null {
    if (!f.roomConnected || f.deliberate || f.replacementPresent) return null;
    if (f.sinceEndedMs !== null && f.sinceEndedMs >= 0 && f.sinceEndedMs < ENDED_CAUSE_WINDOW_MS) return 'capture_ended';
    return 'unpublished_unprompted';
}

/** The user-facing line for each stop (no device or app names). */
export function cameraStopNotice(reason: CameraStopReason): string {
    return reason === 'device_ended'
        ? 'Your camera stopped (the device was disconnected or taken by another app). Turn it back on to continue.'
        : 'Your camera turned off by itself. Turn it back on to continue.';
}
export function shareEndNotice(reason: ShareEndReason): string {
    return reason === 'capture_ended'
        ? 'Your screen share ended because the screen or window stopped being captured. Share again to continue.'
        : 'Your screen share ended unexpectedly. Share again to continue.';
}
