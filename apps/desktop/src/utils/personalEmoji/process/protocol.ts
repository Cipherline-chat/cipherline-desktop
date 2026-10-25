import type { FrameMode } from './geometry';

/** Messages between the page and src/workers/personalEmoji.worker.ts. */
export interface EmojiProcessRequest {
    type: 'process';
    file: Blob;
    mode: FrameMode;
}

export type EmojiProcessErrorCode =
    | 'NOT_AN_IMAGE' | 'INPUT_TOO_LARGE' | 'IMAGE_TOO_LARGE' | 'TOO_COMPLEX' | 'UNSUPPORTED' | 'FAILED';

export type EmojiProcessResponse =
    | { type: 'progress'; fraction: number }
    | {
        type: 'done';
        bytes: Uint8Array;
        mime: 'image/webp';
        animated: boolean;
        frames: number;
        width: number;
        /** Playback length in ms (0 for a still). */
        durationMs: number;
        /** The source was animated but only its first frame could be read. */
        animationLost: boolean;
    }
    | { type: 'error'; code: EmojiProcessErrorCode; message: string };

/** Largest picture file the picker will even read. */
export const EMOJI_INPUT_MAX_BYTES = 25 * 1024 * 1024;
/** Largest source side. A 16k-square RGBA decode is 1 GB; refuse well before. */
export const EMOJI_SOURCE_MAX_SIDE = 8192;
/** Longest playback kept; the rest of a longer animation is cut. */
export const EMOJI_MAX_DURATION_MS = 6000;
/** Most source frames decoded. */
export const EMOJI_MAX_SOURCE_FRAMES = 200;
/** Most frames fed to the encoder (longer is thinned, keeping the duration). */
export const EMOJI_MAX_OUTPUT_FRAMES = 60;
/** Smallest display time a frame keeps; browsers treat 0-10 ms as 100 ms. */
export const EMOJI_MIN_FRAME_MS = 20;
