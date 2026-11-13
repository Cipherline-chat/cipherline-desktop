import { EMOJI_INPUT_MAX_BYTES } from './process/protocol';

/**
 * Why a picked file cannot become a personal emoji (shown next to the picker /
 * as a toast), or null when it can. The same rule everywhere a file is chosen:
 * Settings -> Activity & Style (My Emojis) and the emoji picker's "+" both go through here.
 */
export function emojiFileProblem(f: Pick<File, 'type' | 'size'>): string | null {
    if (!f.type.startsWith('image/') || f.type === 'image/svg+xml') return 'Pick a picture: PNG, JPG, GIF, WebP or similar.';
    if (f.size > EMOJI_INPUT_MAX_BYTES) return 'That file is bigger than 25 MB.';
    return null;
}
