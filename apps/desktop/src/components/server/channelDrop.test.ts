import { describe, it, expect } from 'vitest';
import { resolveDropCategoryId, moveChannelToEndOfContainer, UNCATEGORIZED_END_ID } from './channelDrop';

describe('resolveDropCategoryId', () => {
    const channels = [
        { channel_id: 'a', parent_category_id: null },
        { channel_id: 'b', parent_category_id: 'cat-1' },
    ];

    it('resolves a `ch:` id to that channel\'s category', () => {
        expect(resolveDropCategoryId('ch:b', channels)).toBe('cat-1');
    });

    it('resolves a `ch:` id pointing at an uncategorized channel to null', () => {
        expect(resolveDropCategoryId('ch:a', channels)).toBeNull();
    });

    it('resolves a `cat:` id to the category id directly', () => {
        expect(resolveDropCategoryId('cat:cat-2', channels)).toBe('cat-2');
    });

    it('resolves the end-of-uncategorized sentinel to null (uncategorized)', () => {
        expect(resolveDropCategoryId(UNCATEGORIZED_END_ID, channels)).toBeNull();
    });

    it('returns undefined for a `ch:` id that no longer exists (no change)', () => {
        expect(resolveDropCategoryId('ch:missing', channels)).toBeUndefined();
    });

    it('returns undefined for an unrecognized id shape (no change)', () => {
        expect(resolveDropCategoryId('bogus', channels)).toBeUndefined();
    });
});

describe('moveChannelToEndOfContainer', () => {
    const container = [
        { channel_id: 'a', position: 1000 },
        { channel_id: 'b', position: 2000 },
        { channel_id: 'c', position: 3000 },
    ];

    it('moves the first channel to the last position, renumbering everyone', () => {
        const result = moveChannelToEndOfContainer(container, 'a');
        expect(result.map(c => c.channel_id)).toEqual(['b', 'c', 'a']);
        expect(result.map(c => c.position)).toEqual([1000, 2000, 3000]);
    });

    it('preserves the relative order of the untouched channels', () => {
        const result = moveChannelToEndOfContainer(container, 'b');
        expect(result.map(c => c.channel_id)).toEqual(['a', 'c', 'b']);
    });

    it('is a no-op (by value) when the channel is already last', () => {
        const result = moveChannelToEndOfContainer(container, 'c');
        expect(result.map(c => c.channel_id)).toEqual(['a', 'b', 'c']);
        expect(result.map(c => c.position)).toEqual([1000, 2000, 3000]);
    });

    it('returns the input unchanged when the channel id is not found', () => {
        const result = moveChannelToEndOfContainer(container, 'missing');
        expect(result).toBe(container);
    });

    it('handles a single-channel container', () => {
        const single = [{ channel_id: 'only', position: 1000 }];
        const result = moveChannelToEndOfContainer(single, 'only');
        expect(result).toEqual([{ channel_id: 'only', position: 1000 }]);
    });

    it('handles an empty container gracefully', () => {
        const result = moveChannelToEndOfContainer([], 'x');
        expect(result).toEqual([]);
    });
});
