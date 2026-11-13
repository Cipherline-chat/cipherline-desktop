/**
 * Messages between the page and src/workers/animatedCrop.worker.ts, plus the
 * limits both sides (and the cropper UI) agree on.
 */

/** Largest animated file the cropper will read. The STORED result is far smaller (see below). */
export const ANIM_CROP_INPUT_MAX_BYTES = 25 * 1024 * 1024;
/** Largest decoded frame side. A 16k-square RGBA frame is 1 GB; refuse well before. */
export const ANIM_CROP_SOURCE_MAX_SIDE = 4096;
/** Most source frames walked. */
export const ANIM_CROP_MAX_SOURCE_FRAMES = 600;
/** Longest playback kept; the rest of a longer animation is cut (and the user is told). */
export const ANIM_CROP_MAX_DURATION_MS = 15_000;
/** Most frames fed to the encoder (a longer animation is thinned, keeping its playback length). */
export const ANIM_CROP_MAX_OUTPUT_FRAMES = 100;
/** Smallest display time a frame keeps. */
export const ANIM_CROP_MIN_FRAME_MS = 20;
/**
 * Ceiling on the stored result. The API accepts up to 10 MiB for an avatar /
 * banner / server image, but every distinct animated picture is downloaded and
 * decrypted in full before a list can show even its first frame, so the crop
 * aims far lower. An animation that cannot fit even after the lossiest rung is
 * refused with a message instead of being stored oversize.
 */
export const ANIM_CROP_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Pixel size an animated crop is stored at: the still preset (512x512 /
 * 1200x480) capped to 320 px (square) / 800 px (wide). The biggest place an
 * animated avatar or icon draws is ~160 CSS px and a banner ~360, so this
 * still covers 2x displays; every extra pixel is multiplied by the frame count.
 */
export function animatedOutputSize(outW: number, outH: number): { width: number; height: number } {
    const maxLong = outW / outH >= 1.6 ? 800 : 320;
    const k = Math.min(1, maxLong / Math.max(outW, outH));
    return { width: Math.max(1, Math.round(outW * k)), height: Math.max(1, Math.round(outH * k)) };
}

export interface AnimatedCropRequest {
    type: 'crop';
    file: Blob;
    /** The crop frame in SOURCE pixels (utils/imageCrop `cropSourceRect`). */
    rect: { sx: number; sy: number; sw: number; sh: number };
    /** Size of the image `rect` was computed against (the <img> natural size). */
    naturalW: number;
    naturalH: number;
    /** The size the cropped frames are stored at (`animatedOutputSize` of the still preset). */
    outW: number;
    outH: number;
}

export type AnimatedCropErrorCode =
    | 'NOT_ANIMATED' | 'NOT_AN_IMAGE' | 'INPUT_TOO_LARGE' | 'IMAGE_TOO_LARGE' | 'TOO_COMPLEX' | 'UNSUPPORTED' | 'FAILED';

export interface AnimatedCropDone {
    type: 'done';
    bytes: Uint8Array;
    mime: 'image/webp';
    frames: number;
    width: number;
    height: number;
    /** Playback length in ms. */
    durationMs: number;
    /** The source ran longer than ANIM_CROP_MAX_DURATION_MS (or had more than the frame cap) and was cut. */
    trimmed: boolean;
}

export type AnimatedCropResponse =
    | { type: 'progress'; fraction: number }
    | AnimatedCropDone
    | { type: 'error'; code: AnimatedCropErrorCode; message: string };
