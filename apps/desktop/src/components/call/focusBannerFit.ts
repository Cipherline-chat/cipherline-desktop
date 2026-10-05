/**
 * focusBannerFit — the auto-fit arithmetic behind the docked focused-stream
 * banner, extracted from FocusedStreamBanner so it can be tested without a
 * DOM, a LiveKit Room, or a real <video> element.
 *
 * The banner's job when a stream is focused is to become exactly as tall as
 * that stream needs to be at the column's current width: no crop, no black
 * bar. Everything is derived from the video's INTRINSIC size
 * (HTMLVideoElement.videoWidth / videoHeight) — never from an assumed 16:9 —
 * which is what lets it serve a camera and a screen share with the same
 * arithmetic. A shared screen can be 16:10, 21:9, 4:3 or a single portrait
 * window, and the only thing that changes is the number that comes out.
 */

/** Floor: below this the banner stops being a video and starts being a
 *  sliver, so a very wide stream (ultrawide monitor, 21:9) letterboxes
 *  slightly rather than collapsing. */
export const MIN_BANNER_HEIGHT = 150;
/** Ceiling, as a fraction of window height: the chat below the banner has to
 *  remain usable, so a very tall stream (a portrait window share, a rotated
 *  phone camera) letterboxes at the sides rather than eating the pane. */
export const MAX_BANNER_RATIO = 0.75;

export interface FocusFitInput {
    /** Current inner width of the banner's video host, in CSS px. */
    availableWidth: number;
    /** HTMLVideoElement.videoWidth. */
    videoWidth: number;
    /** HTMLVideoElement.videoHeight. */
    videoHeight: number;
    /** window.innerHeight — the ratio's denominator, so the stored value
     *  survives an OS window resize the way the sidebar ratios do. */
    windowHeight: number;
}

/**
 * The banner height, in px, that makes the stream fill `availableWidth`
 * exactly — clamped into [MIN_BANNER_HEIGHT, MAX_BANNER_RATIO × window].
 *
 * Returns null when the inputs are not yet meaningful: a <video> with no
 * metadata reports 0×0, and a host that has not been laid out reports width
 * 0. Callers must leave the previous height alone in that case rather than
 * fitting to garbage — an early 0 is what used to strand the banner on its
 * default ratio for the rest of a focus.
 */
export function fitBannerHeight(input: FocusFitInput): number | null {
    const { availableWidth, videoWidth, videoHeight, windowHeight } = input;
    if (!(videoWidth >= 2) || !(videoHeight >= 2)) return null;
    if (!(availableWidth >= 2)) return null;
    if (!(windowHeight >= 1)) return null;
    const desired = Math.round(availableWidth * (videoHeight / videoWidth));
    return clampBannerHeight(desired, windowHeight);
}

/** Shared clamp, so the auto-fit path and the drag path cannot drift apart. */
export function clampBannerHeight(height: number, windowHeight: number): number {
    return Math.max(MIN_BANNER_HEIGHT, Math.min(Math.round(windowHeight * MAX_BANNER_RATIO), Math.round(height)));
}

/** The same fit expressed as the ratio-of-window-height the banner stores. */
export function fitBannerRatio(input: FocusFitInput): number | null {
    const height = fitBannerHeight(input);
    return height === null ? null : height / input.windowHeight;
}
