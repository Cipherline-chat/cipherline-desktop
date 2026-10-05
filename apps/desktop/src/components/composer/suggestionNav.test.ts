import { describe, it, expect } from 'vitest';
import { nextSuggestionIndex, resolveCustomEmojiHint } from './suggestionNav';

describe('nextSuggestionIndex', () => {
    it('moves down within bounds', () => {
        expect(nextSuggestionIndex(0, 3, 'down')).toBe(1);
        expect(nextSuggestionIndex(1, 3, 'down')).toBe(2);
    });

    it('moves up within bounds', () => {
        expect(nextSuggestionIndex(2, 3, 'up')).toBe(1);
        expect(nextSuggestionIndex(1, 3, 'up')).toBe(0);
    });

    it('wraps downward past the last item to the first', () => {
        expect(nextSuggestionIndex(2, 3, 'down')).toBe(0);
    });

    it('wraps upward past the first item to the last', () => {
        expect(nextSuggestionIndex(0, 3, 'up')).toBe(2);
    });

    it('stays put on a single-item list in either direction', () => {
        expect(nextSuggestionIndex(0, 1, 'up')).toBe(0);
        expect(nextSuggestionIndex(0, 1, 'down')).toBe(0);
    });

    it('returns 0 for an empty list rather than dividing by zero', () => {
        expect(nextSuggestionIndex(0, 0, 'up')).toBe(0);
        expect(nextSuggestionIndex(0, 0, 'down')).toBe(0);
    });
});

describe('resolveCustomEmojiHint', () => {
    const servers = [
        { server_id: 's1', name: 'Cipherline HQ' },
        { server_id: 's2', name: 'Off-Topic' },
    ];

    it('resolves the owning server name by id', () => {
        expect(resolveCustomEmojiHint('s1', servers)).toBe('Cipherline HQ');
        expect(resolveCustomEmojiHint('s2', servers)).toBe('Off-Topic');
    });

    it('falls back to "Custom" when the server id is not in the list', () => {
        expect(resolveCustomEmojiHint('unknown-server', servers)).toBe('Custom');
    });

    it('falls back to "Custom" when no server id is given', () => {
        expect(resolveCustomEmojiHint(null, servers)).toBe('Custom');
        expect(resolveCustomEmojiHint(undefined, servers)).toBe('Custom');
    });

    it('falls back to "Custom" against an empty servers list', () => {
        expect(resolveCustomEmojiHint('s1', [])).toBe('Custom');
    });
});
