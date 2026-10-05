import { describe, it, expect } from 'vitest';
import { EMOJI_RE, countEmojis, isEmojiOnly } from './emojiText';

/**
 * Emoji-only messages go jumbo (≤3 → 3em, ≤5 → 2em, ≤8 → 1.5em). The pattern
 * used to match only a pictographic base, so a skin-tone modifier was left
 * over (👍🏽 was "not emoji-only"), and a flag (two regional indicators) or a
 * keycap (digit + U+20E3) never matched at all — those messages rendered at
 * body size. Same cases as mobile's fix (cipherline-mobile
 * src/features/chat/logic/richText.ts, "emoji-only jumbo missed skin tones,
 * flags and keycaps").
 */
describe('isEmojiOnly / countEmojis', () => {
    it.each([
        ['😂', 1],
        ['👍🏽', 1],                // skin-tone modifier
        ['❤️', 1],                 // VS16 presentation selector
        ['🇺🇸', 1],                // flag: two regional indicators
        ['1️⃣', 1],                 // keycap: digit + VS16 + U+20E3
        ['#⃣', 1],                  // keycap without VS16
        ['👨‍👩‍👧', 1],               // ZWJ family
        ['👍🏽👍🏽👍🏽', 3],
        ['🇺🇸🇬🇧', 2],
        ['🏴󠁧󠁢󠁥󠁮󠁧󠁿', 1],           // subdivision flag: black flag + tag characters
        ['👩🏽‍💻', 1],                // modifier inside a ZWJ sequence
        ['😂 🇺🇸 1️⃣', 3],           // whitespace between emoji is fine
    ])('%s is emoji-only, counting %i', (text, n) => {
        expect(isEmojiOnly(text)).toBe(true);
        expect(countEmojis(text)).toBe(n);
    });

    it.each([
        ['hi 👍'],
        ['12'],                    // plain digits are not keycaps
        ['#1'],
        ['US'],
        ['👍 ok'],
        [''],
        ['   '],
    ])('%j is not emoji-only', text => {
        expect(isEmojiOnly(text)).toBe(false);
    });

    it('still counts a custom-emoji token like a glyph', () => {
        expect(isEmojiOnly('<:partyblob:e1> 🎉')).toBe(true);
        expect(countEmojis('<:partyblob:e1> 🎉')).toBe(2);
    });

    it('the inline sizer (renderSegmentWithEmojis) wraps a skin-toned emoji as ONE glyph', () => {
        // ChatPane builds `new RegExp(EMOJI_RE.source, 'gu')` and wraps each match;
        // a modifier left outside the match rendered as a separate, unsized box.
        const matches = [...'nice 👍🏽 and 🇬🇧'.matchAll(new RegExp(EMOJI_RE.source, 'gu'))].map(m => m[0]);
        expect(matches).toEqual(['👍🏽', '🇬🇧']);
    });
});

describe('ChatPane uses these helpers, not a private copy', () => {
    it('imports EMOJI_RE / isEmojiOnly / countEmojis from utils/emojiText and defines none itself', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');
        expect(src).toContain("from '../utils/emojiText'");
        expect(src).not.toMatch(/const EMOJI_RE\s*=/);
        expect(src).not.toMatch(/function isEmojiOnly\(/);
        expect(src).not.toMatch(/function countEmojis\(/);
    });
});
