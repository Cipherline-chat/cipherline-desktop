import { describe, it, expect } from 'vitest';
import { resolveEmojiGlyphState } from './emojiGlyphState';

/**
 * The three-way branch every custom-emoji fallback site in ChatPane.tsx
 * shares (reaction glyph, inline message text, jumbo standalone-emoji) —
 * see the module doc. This is the piece a future change is most likely to
 * collapse by accident: conflating 'loading' with 'unavailable' flashes the
 * "no longer available" placeholder on every custom emoji on first paint,
 * before the server's emoji list has loaded.
 */
describe('resolveEmojiGlyphState', () => {
    it('resolves when the token is found in the list, regardless of loading state', () => {
        expect(resolveEmojiGlyphState({ some: 'record' }, true)).toBe('resolved');
        expect(resolveEmojiGlyphState({ some: 'record' }, false)).toBe('resolved');
        expect(resolveEmojiGlyphState({ some: 'record' }, undefined)).toBe('resolved');
    });

    it('is "loading" when not found but the list has not finished loading yet', () => {
        expect(resolveEmojiGlyphState(undefined, true)).toBe('loading');
    });

    it('is "unavailable" when not found and the list has finished loading', () => {
        expect(resolveEmojiGlyphState(undefined, false)).toBe('unavailable');
    });

    it('treats an omitted loading flag as "not loading" -> unavailable, never loading', () => {
        // A caller with no server context at all (DMs/groups) doesn't pass
        // emojisLoading — must not get stuck showing a permanent skeleton.
        expect(resolveEmojiGlyphState(undefined, undefined)).toBe('unavailable');
    });

    it('never conflates loading and unavailable for the same "not found" input', () => {
        const loading = resolveEmojiGlyphState(undefined, true);
        const doneLoading = resolveEmojiGlyphState(undefined, false);
        expect(loading).not.toBe(doneLoading);
    });
});
