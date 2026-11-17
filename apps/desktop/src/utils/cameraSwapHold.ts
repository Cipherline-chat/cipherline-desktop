/**
 * A remote camera tile that keeps its last picture across a track SWAP.
 *
 * Why (report 2026-11-16, "friend's camera keeps going grey and disappearing before
 * returning to normal"): a camera publication is replaced in place several ways - the
 * sender's make-before-break republish (H.265 retry / drift fallback / layering change),
 * a resubscribe after a reconnect. The tile re-attaches to the new track, and
 * `track.detach(el)` clears the <video> at once, so the picture is gone until the new
 * track has delivered a keyframe (E2EE adds its decrypt on top): a grey tile for as long
 * as the swap takes, and when the new publication is itself silent (an H.265 sender that
 * fell back to OpenH264 sends the SFU nothing the viewer can use) for several seconds.
 *
 * Screen shares already hold their last frame, but they are told by the sender
 * (utils/shareHold.ts). A camera has no announcement, so this is receiver-only: take the
 * frame the instant the tile is about to detach, keep it up, and let go when the new track
 * paints a real frame - or after CAMERA_HOLD_MAX_MS.
 *
 * PRIVACY: the hold is ONLY for a swap. When someone turns their camera off (muted, or
 * unpublished with no replacement) or leaves, their face must leave every viewer's screen
 * at once. So a frame is SHOWN only once a replacement for the same participant and source
 * is KNOWN: already there when the old track detaches, or arriving within
 * CAMERA_HOLD_GRACE_MS. During that grace the tile shows its normal placeholder; the
 * captured frame stays hidden and is dropped if nothing arrives. Mute, unpublish with no
 * replacement and disconnect clear it on the spot (cameraHoldClears).
 *
 * The frame is decrypted E2EE content: one canvas in memory for the length of the hold
 * (utils/shareHoldFrame.ts), never uploaded, written or logged.
 */
import { isRealFrameSize } from './shareHoldFrame';

/**
 * Longest a frame is held. Sized to the worst measured swap: an H.265 publication that
 * carries nothing until the drift check republishes as H.264 (3.8 - 5.5 s in the report),
 * plus the second track's keyframe.
 */
export const CAMERA_HOLD_MAX_MS = 8_000;

/** How long to wait for a replacement before concluding the camera is simply gone. */
export const CAMERA_HOLD_GRACE_MS = 250;

export type CameraHoldEnd = 'painted' | 'timeout' | 'gone' | 'cleared';

export interface CaptureInput {
    /** The tile is still the same participant + source after the swap (not a recycled tile). */
    sameTile: boolean;
    /** HTMLMediaElement.readyState of the <video> about to be detached. */
    readyState: number;
    videoWidth: number;
    videoHeight: number;
    /** A frame is already held (an earlier swap in the same gap): keep the older real picture. */
    alreadyHeld: boolean;
    /** The camera is muted right now (publication.isMuted): it is OFF, not swapping. */
    muted: boolean;
    /** A non-muted replacement track for the same participant + source already exists. */
    replacementKnown: boolean;
}

/**
 * What to do with the element about to be detached:
 *  - 'show'    a replacement is known: hold the frame visibly;
 *  - 'pending' none yet: keep the frame hidden for CAMERA_HOLD_GRACE_MS (the placeholder shows);
 *  - 'none'    take no frame at all (muted, blank element, recycled tile, one already held).
 */
export function decideCameraHold(i: CaptureInput): 'show' | 'pending' | 'none' {
    if (!i.sameTile || i.alreadyHeld || i.muted) return 'none';
    // HAVE_CURRENT_DATA: a frame exists. A tile paused off-screen, or a subscribe still in flight, has none.
    if (!(i.readyState >= 2 && isRealFrameSize(i.videoWidth, i.videoHeight))) return 'none';
    return i.replacementKnown ? 'show' : 'pending';
}

export type CameraHoldSignal =
    | { type: 'muted' }
    | { type: 'unpublished'; replacementExists: boolean }
    | { type: 'disconnected' }
    | { type: 'grace_expired'; replacementArrived: boolean };

/** Whether a signal drops the held / pending frame on the spot. */
export function cameraHoldClears(sig: CameraHoldSignal): boolean {
    switch (sig.type) {
        case 'muted':
        case 'disconnected':
            return true;
        case 'unpublished':
            return !sig.replacementExists;
        case 'grace_expired':
            return !sig.replacementArrived;
    }
}

/** ms of the hold left (0 = release now). */
export function cameraHoldRemainingMs(startedAt: number, now: number): number {
    return Math.max(0, CAMERA_HOLD_MAX_MS - (now - startedAt));
}
