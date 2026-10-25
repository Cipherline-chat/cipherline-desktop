import { describe, it, expect } from 'vitest';
import { groupOfTwoTarget, groupOfTwoCopy, GROUP_OF_TWO_INSIST_LIMIT } from './groupOfTwo';
import { GROUP_OF_TWO_BODIES, GROUP_OF_TWO_TITLES, fillLine } from './eggPools';

const ann = { user_id: 'u-ann', username: 'Ann' };
const bob = { user_id: 'u-bob', username: 'Bob' };
const base = { selectedIds: ['u-ann'], people: [ann, bob], insistedCount: 0 };

describe('groupOfTwoTarget', () => {
    it('fires for exactly one other person, and returns who', () => {
        expect(groupOfTwoTarget(base)).toBe(ann);
    });
    it('zero picked is the ordinary validation path; two or more is a real group', () => {
        expect(groupOfTwoTarget({ ...base, selectedIds: [] })).toBeNull();
        expect(groupOfTwoTarget({ ...base, selectedIds: ['u-ann', 'u-bob'] })).toBeNull();
    });
    it('retires once the user has insisted often enough, not before', () => {
        expect(groupOfTwoTarget({ ...base, insistedCount: GROUP_OF_TWO_INSIST_LIMIT - 1 })).toBe(ann);
        expect(groupOfTwoTarget({ ...base, insistedCount: GROUP_OF_TWO_INSIST_LIMIT })).toBeNull();
    });
    it('stays quiet rather than guess when the picked person is unknown', () => {
        expect(groupOfTwoTarget({ ...base, selectedIds: ['u-ghost'] })).toBeNull();
    });
});

describe('groupOfTwoCopy', () => {
    it('opens with the owner’s line and names the other person', () => {
        const c = groupOfTwoCopy(0, 'Ann');
        expect(c.title).toBe('That’s… a DM with extra steps.');
        expect(c.body).toContain('Ann');
        expect(c.body).not.toContain('{name}');
    });
    it('rotates, never repeating consecutively, and wraps', () => {
        for (let i = 0; i < 6; i++) {
            expect(groupOfTwoCopy(i, 'Ann').title).not.toBe(groupOfTwoCopy(i + 1, 'Ann').title);
            expect(groupOfTwoCopy(i, 'Ann').body).not.toBe(groupOfTwoCopy(i + 1, 'Ann').body);
        }
        expect(groupOfTwoCopy(GROUP_OF_TWO_TITLES.length, 'Ann').title).toBe(GROUP_OF_TWO_TITLES[0]);
    });
    it('no body line leaves a raw placeholder behind once filled', () => {
        for (const b of GROUP_OF_TWO_BODIES) expect(fillLine(b, { name: 'Ann' })).not.toMatch(/[{}]/);
    });
});

describe('fillLine', () => {
    it('treats the name as text, never as a replacement pattern', () => {
        expect(fillLine('hi {name}', { name: '$& $1 {n}' })).toBe('hi $& $1 {n}');
    });
    it('fills every occurrence and leaves unknown placeholders alone', () => {
        expect(fillLine('{n} and {n}, {x}', { n: 3 })).toBe('3 and 3, {x}');
    });
});
