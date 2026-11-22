import { STICKER_TAG_RE } from '@cipherline/shared';

/** "wave, hi" -> ['wave', 'hi']; invalid tags are reported, not silently dropped. */
export function parseStickerTags(raw: string): { tags: string[]; bad: string[] } {
    const parts = raw.split(/[,\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
    const tags = [...new Set(parts.filter(t => STICKER_TAG_RE.test(t)))];
    const bad = parts.filter(t => !STICKER_TAG_RE.test(t));
    return { tags, bad };
}
