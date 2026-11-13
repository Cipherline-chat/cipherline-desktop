import { describe, it, expect } from 'vitest';
import { buildInviteFriends, recentInviteFriends, searchInviteFriends, RECENT_INVITE_LIMIT, type InviteFriendSource } from './inviteFriends';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const f = (id: string, username: string, sinceAgo: number | null, discriminator: number | null = 1): InviteFriendSource =>
    ({ user_id: id, username, discriminator, avatar_url: null, friends_since: sinceAgo === null ? null : ago(sinceAgo) });
const dm = (id: string, other: string) => ({ conversation_id: id, type: 'dm', other_user_id: other });
const ids = (l: { userId: string }[]) => l.map(x => x.userId);

describe('buildInviteFriends: recency', () => {
    it('a friend added an hour ago outranks one last messaged yesterday', () => {
        const out = buildInviteFriends({
            now: NOW,
            friends: [f('old', 'Old', 400 * D), f('new', 'New', H)],
            conversations: [dm('c-old', 'old')],
            lastActivityAt: { 'c-old': NOW - D },
        });
        expect(ids(out)).toEqual(['new', 'old']);
        expect(out[0].recentReason).toBe('new-friend');
        expect(out[1].recentReason).toBe('message');
    });

    it('a message 5 minutes ago outranks a friend added an hour ago', () => {
        const out = buildInviteFriends({
            now: NOW,
            friends: [f('new', 'New', H), f('chat', 'Chat', 400 * D)],
            conversations: [dm('c-chat', 'chat')],
            lastActivityAt: { 'c-chat': NOW - 5 * MIN },
        });
        expect(ids(out)).toEqual(['chat', 'new']);
        expect(out[0].recentAt).toBe(NOW - 5 * MIN);
    });

    it('takes the LATER of the two signals for one friend (and reports which won)', () => {
        const chatWins = buildInviteFriends({ now: NOW, friends: [f('a', 'A', 2 * D)], conversations: [dm('c', 'a')], lastActivityAt: { c: NOW - H } })[0];
        expect(chatWins.recentAt).toBe(NOW - H);
        expect(chatWins.recentReason).toBe('message');
        const addWins = buildInviteFriends({ now: NOW, friends: [f('a', 'A', H)], conversations: [dm('c', 'a')], lastActivityAt: { c: NOW - 2 * D } })[0];
        expect(addWins.recentAt).toBe(NOW - H);
        expect(addWins.recentReason).toBe('new-friend');
    });

    it('ties and signal-less friends fall back to A-Z', () => {
        const out = buildInviteFriends({ now: NOW, friends: [f('z', 'zed', null), f('b', 'Bea', null), f('a', 'amy', null)], conversations: [] });
        expect(ids(out)).toEqual(['a', 'b', 'z']);
        expect(out.every(x => x.recentAt === 0 && x.recentReason === null)).toBe(true);
    });

    it('only counts DMs with that friend: groups, self-chats and other people\'s DMs are ignored', () => {
        const out = buildInviteFriends({
            now: NOW,
            friends: [f('a', 'Amy', 300 * D)],
            conversations: [{ conversation_id: 'g', type: 'group', other_user_id: 'a' }, { conversation_id: 's', type: 'dm', other_user_id: 'a', is_self: true }, dm('x', 'someone-else')],
            lastActivityAt: { g: NOW - MIN, s: NOW - MIN, x: NOW - MIN },
        });
        expect(out[0].recentAt).toBe(NOW - 300 * D);
        expect(out[0].recentReason).toBe('new-friend');
    });

    it('drops blocked people, yourself and duplicate rows', () => {
        const out = buildInviteFriends({
            now: NOW,
            friends: [f('a', 'Amy', H), f('blk', 'Blocked', H), f('me', 'Me', H), f('a', 'Amy again', H)],
            conversations: [],
            blockedIds: new Set(['blk']),
            myUserId: 'me',
        });
        expect(ids(out)).toEqual(['a']);
    });

    it('ignores garbage times: unparseable, zero, and far-future stamps are "no signal"', () => {
        const out = buildInviteFriends({
            now: NOW,
            friends: [{ user_id: 'a', username: 'A', friends_since: 'not a date' }, f('b', 'B', -30 * D), f('c', 'C', 400 * D)],
            conversations: [dm('cb', 'b')],
            lastActivityAt: { cb: Number.NaN },
        });
        expect(out.find(x => x.userId === 'a')!.recentAt).toBe(0);
        expect(out.find(x => x.userId === 'b')!.recentAt).toBe(0);
        expect(ids(out)[0]).toBe('c');
    });

    it('a friend with no username still gets a row', () => {
        expect(buildInviteFriends({ now: NOW, friends: [{ user_id: 'a' }], conversations: [] })[0].username).toBe('Unknown');
    });
});

describe('recentInviteFriends', () => {
    const many = Array.from({ length: 9 }, (_, i) => f(`u${i}`, `User${i}`, (i + 1) * H));
    it('is the first RECENT_INVITE_LIMIT with a signal, newest first', () => {
        const list = buildInviteFriends({ now: NOW, friends: many, conversations: [] });
        const recent = recentInviteFriends(list);
        expect(recent).toHaveLength(RECENT_INVITE_LIMIT);
        expect(ids(recent)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4']);
    });
    it('omits friends with no signal at all', () => {
        const list = buildInviteFriends({ now: NOW, friends: [f('a', 'A', null), f('b', 'B', H)], conversations: [] });
        expect(ids(recentInviteFriends(list))).toEqual(['b']);
    });
});

describe('searchInviteFriends', () => {
    const list = buildInviteFriends({
        now: NOW,
        friends: [f('1', 'Alice', 10 * D, 12), f('2', 'Malik', 1 * D, 345), f('3', 'alina', 5 * H, 7), f('4', 'Bob', 2 * H, 12), f('5', 'Al', 300 * D, 99)],
        conversations: [],
    });
    it('empty query returns nothing (the caller shows the recent list instead)', () => {
        expect(searchInviteFriends(list, '   ')).toEqual([]);
    });
    it('ranks exact, then prefix, then anywhere; ties go to the more recent friend', () => {
        // "al": exact = Al; prefix = Alice, alina (alina is more recent); anywhere = Malik.
        expect(ids(searchInviteFriends(list, 'al'))).toEqual(['5', '3', '1', '2']);
    });
    it('is case-insensitive and matches inside names', () => {
        expect(ids(searchInviteFriends(list, 'LIK'))).toEqual(['2']);
    });
    it('searches the whole list, including friends with no recent signal', () => {
        expect(ids(searchInviteFriends(buildInviteFriends({ now: NOW, friends: [f('x', 'Quiet', null)], conversations: [] }), 'qui'))).toEqual(['x']);
    });
    it('name#tag narrows by the discriminator (padded to 4 digits), and #tag alone searches by tag', () => {
        expect(ids(searchInviteFriends(list, 'ali#12'))).toEqual(['1']);
        expect(ids(searchInviteFriends(list, 'alice#0012'))).toEqual(['1']);
        expect(ids(searchInviteFriends(list, 'alice#99'))).toEqual([]);
        expect(ids(searchInviteFriends(list, '#0012')).sort()).toEqual(['1', '4']);
    });
    it('no match → empty', () => {
        expect(searchInviteFriends(list, 'zzz')).toEqual([]);
    });
});
