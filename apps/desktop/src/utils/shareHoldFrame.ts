/**
 * The last frame of a share a viewer is watching, kept on screen across a
 * republish (utils/shareHold.ts).
 *
 * It is decrypted E2EE content. It lives in one canvas in memory, on this device,
 * for the length of the hold: never uploaded, never written to disk, never logged
 * (the call log only records THAT a frame was held). Nothing runs during normal
 * playback; this is one drawImage at the moment a hold is announced.
 */

export interface HeldFrame {
    canvas: HTMLCanvasElement;
    /** The picture's real size, for placing corner chrome and the fit clip. */
    width: number;
    height: number;
}

/** No screen needs more from a placeholder that is up for a few seconds. */
const MAX_EDGE_PX = 2560;

/**
 * Bigger than the blank frames the SFU sends when it closes a down track (8x8 was
 * measured; a receiver can also open with 2x2). Those are not a picture to hold,
 * and the first of them is not the new stream arriving.
 */
const BLANK_FRAME_MAX_PX = 16;
export const isRealFrameSize = (width: number, height: number): boolean =>
    width > BLANK_FRAME_MAX_PX && height > BLANK_FRAME_MAX_PX;

/**
 * What to draw at: the tile's size on screen, never above the source, with the
 * source's own shape, so `object-fit: contain` places it where the video was.
 */
export function heldFrameSize(
    videoWidth: number, videoHeight: number, boxWidth: number, boxHeight: number, dpr: number,
): { width: number; height: number } {
    const fit = (w: number, h: number) => Math.min(1, w / videoWidth, h / videoHeight);
    const scale = boxWidth > 0 && boxHeight > 0
        ? fit(Math.min(boxWidth * dpr, MAX_EDGE_PX), Math.min(boxHeight * dpr, MAX_EDGE_PX))
        : fit(MAX_EDGE_PX, MAX_EDGE_PX);
    return {
        width: Math.max(1, Math.round(videoWidth * scale)),
        height: Math.max(1, Math.round(videoHeight * scale)),
    };
}

/** Null when there is no decoded frame to take; the placeholder then has no picture. */
export function captureHeldFrame(
    video: HTMLVideoElement | null,
    box: { width: number; height: number } | null,
    dpr: number,
): HeldFrame | null {
    // HAVE_CURRENT_DATA: a frame exists. A tile paused off-screen, or a subscribe
    // still in flight, has none.
    if (!video || video.readyState < 2 || !isRealFrameSize(video.videoWidth, video.videoHeight)) return null;
    const size = heldFrameSize(video.videoWidth, video.videoHeight, box?.width ?? 0, box?.height ?? 0, dpr);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.className = 'block w-full h-full object-contain';
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    try {
        ctx.drawImage(video, 0, 0, size.width, size.height);
    } catch {
        return null;
    }
    return { canvas, width: video.videoWidth, height: video.videoHeight };
}

/** Let go of the pixels now rather than whenever the canvas is collected. */
export function releaseHeldFrame(frame: HeldFrame | null): void {
    if (!frame) return;
    frame.canvas.remove();
    frame.canvas.width = 0;
    frame.canvas.height = 0;
}
