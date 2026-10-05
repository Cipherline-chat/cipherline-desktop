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

    it('queries shorter than 2 characters return nothing', async () => {
        await loadEmojiData();
        expect(searchEmoji('s')).toEqual([]);
        expect(searchEmoji('')).toEqual([]);
    });
});
