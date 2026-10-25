import { describe, it, expect } from 'vitest';
import { moveItem } from './moveItem';

describe('moveItem', () => {
    it('moves forward and back, leaves the input alone', () => {
        const a = ['a', 'b', 'c', 'd'];
        expect(moveItem(a, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
        expect(moveItem(a, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
        expect(a).toEqual(['a', 'b', 'c', 'd']);
    });
    it('out-of-range or same index is a copy, unchanged', () => {
        expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
        expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
        expect(moveItem(['a', 'b'], 0, 2)).toEqual(['a', 'b']);
    });
});
