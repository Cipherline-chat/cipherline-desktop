import { describe, it, expect } from 'vitest';
import { searchEmoji, loadEmojiData, getLoadedEmojiData } from './emojiSearch';

describe('emojiSearch (dataset loads on demand, results unchanged once loaded)', () => {
    it('before the dataset has loaded: returns nothing and starts the load', async () => {
        expect(getLoadedEmojiData()).toBeNull();
        expect(searchEmoji('smile')).toEqual([]);
        const data = await loadEmojiData();
        expect(getLoadedEmojiData()).toBe(data);
    });

    it('after loading: exact id first, then prefix matches, capped at the limit', async () => {
        await loadEmojiData();
        const r = searchEmoji('smile', 5);
        expect(r.length).toBeGreaterThan(0);
        expect(r.length).toBeLessThanOrEqual(5);
        expect(r[0].id).toBe('smile');
        expect(r[0].native).toBe('😄');
    });

    it('never offers a custom emoji emoji-mart registered into the shared dataset (no blank duplicate row)', async () => {
        const data = await loadEmojiData();
        // What emoji-mart's init({ custom }) does when the picker opens with My Emojis.
        const emojis = data.emojis as Record<string, unknown>;
        emojis['tough_ass_emoji_x1'] = {
            id: 'tough_ass_emoji_x1', name: 'tough_ass_emoji', keywords: ['tough_ass_emoji'],
            skins: [{ src: 'blob:fake' }], version: 1,
        };
        try {
            expect(searchEmoji('tough_ass_emoji')).toEqual([]);
            expect(searchEmoji('smile', 3)[0].native).toBe('😄');
        } finally {
            delete emojis['tough_ass_emoji_x1'];
        }
    });

    it('queries shorter than 2 characters return nothing', async () => {
        await loadEmojiData();
        expect(searchEmoji('s')).toEqual([]);
        expect(searchEmoji('')).toEqual([]);
    });
});
