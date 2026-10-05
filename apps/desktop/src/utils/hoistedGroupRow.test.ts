import { describe, it, expect } from 'vitest';
import { getGroupRowPosition, getGroupRowRoundingClass } from './hoistedGroupRow';

describe('getGroupRowPosition', () => {
    it('a single-member group is "single"', () => {
        expect(getGroupRowPosition(0, 1)).toBe('single');
    });

    it('the first row of a multi-member group is "first"', () => {
        expect(getGroupRowPosition(0, 4)).toBe('first');
    });

    it('the last row of a multi-member group is "last"', () => {
        expect(getGroupRowPosition(3, 4)).toBe('last');
    });

    it('interior rows are "middle"', () => {
        expect(getGroupRowPosition(1, 4)).toBe('middle');
        expect(getGroupRowPosition(2, 4)).toBe('middle');
    });

    it('a two-member group has a first and a last, never middle', () => {
        expect(getGroupRowPosition(0, 2)).toBe('first');
        expect(getGroupRowPosition(1, 2)).toBe('last');
    });

    it('total <= 1 is always "single" regardless of index', () => {
        expect(getGroupRowPosition(0, 0)).toBe('single');
    });
});

describe('getGroupRowRoundingClass', () => {
    it('single rounds all corners', () => {
        expect(getGroupRowRoundingClass('single')).toBe('rounded-lg');
    });

    it('first rounds only the top', () => {
        expect(getGroupRowRoundingClass('first')).toBe('rounded-t-lg rounded-b-none');
    });

    it('last rounds only the bottom', () => {
        expect(getGroupRowRoundingClass('last')).toBe('rounded-b-lg rounded-t-none');
    });

    it('middle rows are square so they butt flush against their neighbours', () => {
        expect(getGroupRowRoundingClass('middle')).toBe('rounded-none');
    });
});
