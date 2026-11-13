import { describe, it, expect } from 'vitest';
import data from '@emoji-mart/data';
import type { EmojiMartData } from '@emoji-mart/data';
import { buildNativeShortcodeIndex, lookupNativeShortcode } from './nativeEmojiShortcodes';
import { searchEmoji } from '../components/emojiSearch';

// The REAL emoji-mart dataset, so the names the owner types are the names that exist.
const idx = buildNativeShortcodeIndex(data as unknown as EmojiMartData);
const find = (n: string) => lookupNativeShortcode(idx, n);

describe('standard emoji shortcodes (real dataset)', () => {
    it(':red_heart: is the red heart, as are :heart: and every old spelling', () => {
        const heart = '❤️';
        for (const n of ['red_heart', 'heart', 'Red Heart', 'red heart', 'red-heart', 'RED_HEART']) expect(find(n)).toBe(heart);
    });
    it('multi-word names with punctuation', () => {
        expect(find('face_with_tears_of_joy')).toBe('\u{1F602}');
        expect(find('man_beard')).toBeTruthy();
        expect(find('united_states_flag')).toBe(find('us'));
    });
    it('ids that contain dashes work both ways, and +1 / -1 survive', () => {
        expect(find('man-walking')).toBe(find('man_walking'));
        expect(find('man_walking')).toBeTruthy();
        expect(find('+1')).toBe('\u{1F44D}');
        expect(find('-1')).toBe('\u{1F44E}');
    });
    it('aliases resolve', () => expect(find('satisfied')).toBe(find('laughing')));
    it('unknown and empty names do not', () => {
        expect(find('definitely_not_an_emoji')).toBeUndefined();
        expect(find('')).toBeUndefined();
        expect(lookupNativeShortcode(null, 'smile')).toBeUndefined();
    });
    it('every entry maps to a non-empty glyph, and every key is lowercase', () => {
        for (const [k, g] of idx.byName) { expect(g.length).toBeGreaterThan(0); expect(k).toBe(k.toLowerCase()); }
    });
});

describe('autocomplete search speaks underscores', () => {
    // searchEmoji needs the dataset loaded; load it through the module's own loader.
    it('red_heart / red_he / "red heart" all find the red heart, labelled :red_heart:', async () => {
        const { loadEmojiData } = await import('../components/emojiSearch');
        await loadEmojiData();
        for (const q of ['red_heart', 'red_he', 'red-he', 'red he']) {
            const hit = searchEmoji(q).find(s => s.id === 'heart');
            expect(hit, q).toBeTruthy();
            expect(hit!.shortcode).toBe('red_heart');
        }
        expect(searchEmoji('red_heart')[0].shortcode).toBe('red_heart');
    });
    it('no suggestion label contains a space', async () => {
        const { loadEmojiData } = await import('../components/emojiSearch');
        await loadEmojiData();
        for (const q of ['face', 'flag', 'man', 'heart']) for (const s of searchEmoji(q, 30)) expect(s.shortcode).not.toMatch(/[\s-]/);
    });
});
