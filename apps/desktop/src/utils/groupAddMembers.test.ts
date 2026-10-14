import { describe, it, expect } from 'vitest';
import {
    GROUP_MAX_MEMBERS, remainingGroupSlots, canAddGroupMembers, buildGroupMemberList, mergeAddedGroupMembers,
} from './groupAddMembers';

describe('canAddGroupMembers (mirrors the server: any active member, not role-gated)', () => {
    const base = { chatType: 'group', selfUserId: 'me', memberIds: ['me', 'a'], membersLoading: false };

    it('a member of a loaded group may add', () => {
        expect(canAddGroupMembers(base)).toBe(true);
    });
    it('NEGATIVE: not a member of the roster -> no', () => {
        expect(canAddGroupMembers({ ...base, memberIds: ['a', 'b'] })).toBe(false);
    });
    it('NEGATIVE: a DM -> no', () => {
        expect(canAddGroupMembers({ ...base, chatType: 'dm' })).toBe(false);
    });
    it('NEGATIVE: hidden while the roster is loading', () => {
        expect(canAddGroupMembers({ ...base, membersLoading: true })).toBe(false);
    });
    it('NEGATIVE: no signed-in user -> no', () => {
        expect(canAddGroupMembers({ ...base, selfUserId: null })).toBe(false);
    });
});

describe('remainingGroupSlots', () => {
    it('counts down to the 200 cap and never goes negative', () => {
        expect(GROUP_MAX_MEMBERS).toBe(200);
        expect(remainingGroupSlots(3)).toBe(197);
        expect(remainingGroupSlots(200)).toBe(0);
        expect(remainingGroupSlots(250)).toBe(0);
    });
});

describe('buildGroupMemberList', () => {
    it('dedupes per-device rows into one entry per user', () => {
        const out = buildGroupMemberList([
            { user_id: 'a', username: 'A', avatar_url: 'x' },
            { user_id: 'a', username: 'A', avatar_url: 'x' },
            { user_id: 'b', username: 'B' },
        ], { user_id: 'a', username: 'A' });
        expect(out.map(m => m.user_id)).toEqual(['a', 'b']);
    });
    it('seeds the signed-in user when the endpoint omitted them', () => {
        const out = buildGroupMemberList([{ user_id: 'b', username: 'B' }], { user_id: 'me', username: null, avatar_url: 'av' });
        expect(out).toContainEqual({ user_id: 'me', username: 'You', avatar_url: 'av' });
    });
    it('ignores rows without a user_id', () => {
        expect(buildGroupMemberList([{ username: 'ghost' }], null)).toEqual([]);
    });
});

describe('mergeAddedGroupMembers', () => {
    it('appends new people', () => {
        const out = mergeAddedGroupMembers([{ user_id: 'a' }], [{ user_id: 'b', username: 'B' }]);
        expect(out.map(m => m.user_id)).toEqual(['a', 'b']);
    });
    it('NEGATIVE: never duplicates someone already on the roster', () => {
        const out = mergeAddedGroupMembers([{ user_id: 'a' }, { user_id: 'b' }], [{ user_id: 'b', username: 'B' }]);
        expect(out.map(m => m.user_id)).toEqual(['a', 'b']);
    });
});
