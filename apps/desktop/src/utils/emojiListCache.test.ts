import { describe, it, expect } from 'vitest';
import { dedupeEmojis, upsertEmoji, emojiListCache } from './emojiListCache';
import type { ServerEmoji } from '../hooks/useServerEmojis';

const e = (id: string, name: string): ServerEmoji => ({
    emoji_id: id, server_id: 's', name, attachment_id: `a-${id}`, key_b64: 'k', nonce_b64: 'n',
    animated: false, created_by: null, created_at: '2026-01-01T00:00:00Z',
});

describe('emoji list helpers', () => {
    it('upsertEmoji appends a new emoji and replaces an existing one by id (never twice)', () => {
        const base = [e('1', 'a'), e('2', 'b')];
        expect(upsertEmoji(base, e('3', 'c')).map(x => x.name)).toEqual(['a', 'b', 'c']);
        expect(upsertEmoji(base, e('2', 'renamed')).map(x => x.name)).toEqual(['a', 'renamed']);
        // create response arriving AFTER the refetch its own realtime event triggered:
        const refetched = [e('1', 'a'), e('3', 'c')];
        expect(upsertEmoji(refetched, e('3', 'c'))).toHaveLength(2);
    });

    it('dedupeEmojis keeps the first of each id and returns the same array when already clean', () => {
        const clean = [e('1', 'a'), e('2', 'b')];
        expect(dedupeEmojis(clean)).toBe(clean);
        expect(dedupeEmojis([e('1', 'a'), e('1', 'a'), e('2', 'b')]).map(x => x.emoji_id)).toEqual(['1', '2']);
    });

    it('the cache never stores a duplicate, whoever writes it', () => {
        emojiListCache.set('srv-dup', [e('1', 'a'), e('1', 'a')]);
        expect(emojiListCache.get('srv-dup')).toHaveLength(1);
        emojiListCache.clear();
    });

    it('only a LOCAL write moves the epoch a background fetch compares against', () => {
        emojiListCache.clear();
        expect(emojiListCache.epoch('srv-ep')).toBe(0);
        emojiListCache.set('srv-ep', [e('1', 'a')]);
        expect(emojiListCache.epoch('srv-ep')).toBe(0);
        emojiListCache.setLocal('srv-ep', [e('1', 'b')]);
        expect(emojiListCache.epoch('srv-ep')).toBe(1);
        expect(emojiListCache.get('srv-ep')![0].name).toBe('b');
        emojiListCache.clear();
    });
});
