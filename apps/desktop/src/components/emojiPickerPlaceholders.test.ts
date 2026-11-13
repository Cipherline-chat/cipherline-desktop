// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CUSTOM_EMOJI_PLACEHOLDER_SRC, fillResolvedPlaceholders, placeholderSrcFor } from './emojiPickerPlaceholders';

const grid = (...srcs: string[]) => {
    const root = document.createElement('div');
    for (const src of srcs) {
        const img = document.createElement('img');
        img.setAttribute('src', src);
        root.appendChild(img);
    }
    return root;
};
const srcs = (root: Element) => [...root.querySelectorAll('img')].map(i => i.getAttribute('src'));

describe('filling custom emoji tiles drawn before their image was ready', () => {
    it('swaps the resolved image onto exactly that emoji tile', () => {
        const root = grid(placeholderSrcFor('a'), placeholderSrcFor('b'));
        fillResolvedPlaceholders(root, id => (id === 'b' ? 'blob:b' : undefined));
        expect(srcs(root)).toEqual([placeholderSrcFor('a'), 'blob:b']);
    });

    it('survives ids that need escaping', () => {
        const id = 'we:ird/id #1';
        const root = grid(placeholderSrcFor(id));
        fillResolvedPlaceholders(root, got => (got === id ? 'blob:x' : undefined));
        expect(srcs(root)).toEqual(['blob:x']);
    });

    it('leaves every other image alone: a real image, a native sprite, the empty-tab tile', () => {
        const real = 'blob:already';
        const other = 'data:image/svg+xml,<svg/>';
        const root = grid(real, other, CUSTOM_EMOJI_PLACEHOLDER_SRC);
        fillResolvedPlaceholders(root, () => 'blob:wrong');
        expect(srcs(root)).toEqual([real, other, CUSTOM_EMOJI_PLACEHOLDER_SRC]);
    });

    it('the tagged placeholder still draws the same picture', () => {
        expect(placeholderSrcFor('a').startsWith(`${CUSTOM_EMOJI_PLACEHOLDER_SRC}#`)).toBe(true);
    });
});
