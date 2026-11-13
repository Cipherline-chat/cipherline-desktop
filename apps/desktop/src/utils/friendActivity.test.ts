import { describe, it, expect } from 'vitest';
import {
    addEntry, deriveFriendCalls, diffListening, diffPresence, entryVerb, FEED_MAX, FEED_TTL_MS, longAgo, observation,
    pruneEntries, selectActiveNow, selectFeed, shortAgo, todaysAnniversaries,
    type FriendActivityEntry, type ListeningObservation, type PresenceSnapshot,
} from './friendActivity';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const e = (userId: string, kind: FriendActivityEntry['kind'], at: number, extra: Partial<FriendActivityEntry> = {}) =>
    ({ userId, kind, at, ...extra });

describe('addEntry — dedupe, bounds, ordering', () => {
    it('keeps newest first', () => {
        let s: FriendActivityEntry[] = [];
        s = addEntry(s, e('a', 'online', T0), T0);
        s = addEntry(s, e('b', 'online', T0 + MIN), T0 + MIN);
        s = addEntry(s, e('c', 'playing', T0 + 2 * MIN, { title: 'Hades' }), T0 + 2 * MIN);
        expect(s.map(x => x.userId)).toEqual(['c', 'b', 'a']);
    });

    it('one entry per friend per kind: a newer one replaces the older', () => {
        let s: FriendActivityEntry[] = [];
        s = addEntry(s, e('a', 'playing', T0, { title: 'Hades' }), T0);
        s = addEntry(s, e('a', 'online', T0 + MIN), T0 + MIN);
        s = addEntry(s, e('a', 'playing', T0 + 2 * MIN, { title: 'Celeste' }), T0 + 2 * MIN);
        expect(s).toHaveLength(2);
        expect(s[0]).toMatchObject({ id: 'a:playing', title: 'Celeste', at: T0 + 2 * MIN });
        expect(s.filter(x => x.kind === 'playing')).toHaveLength(1);
    });

    it('ignores an entry older than the one it would replace (out-of-order delivery)', () => {
        let s = addEntry([], e('a', 'playing', T0 + MIN, { title: 'New' }), T0 + MIN);
        s = addEntry(s, e('a', 'playing', T0, { title: 'Old' }), T0 + MIN);
        expect(s).toHaveLength(1);
        expect(s[0].title).toBe('New');
    });

    it(`caps at FEED_MAX (${FEED_MAX}), dropping the oldest`, () => {
        let s: FriendActivityEntry[] = [];
        for (let i = 0; i < FEED_MAX + 7; i++) s = addEntry(s, e(`u${i}`, 'online', T0 + i), T0 + i);
        expect(s).toHaveLength(FEED_MAX);
        expect(s[0].userId).toBe(`u${FEED_MAX + 6}`);
        expect(s.some(x => x.userId === 'u0')).toBe(false);
    });

    it('drops anything at or past the 24 h TTL', () => {
        let s = addEntry([], e('old', 'online', T0), T0);
        s = addEntry(s, e('new', 'online', T0 + FEED_TTL_MS - 1), T0 + FEED_TTL_MS);
        expect(s.map(x => x.userId)).toEqual(['new']);
        expect(pruneEntries(s, T0 + 2 * FEED_TTL_MS)).toEqual([]);
    });

    it('high fives merge into a count instead of stacking rows', () => {
        let s = addEntry([], e('a', 'high_five', T0, { count: 1 }), T0);
        s = addEntry(s, e('a', 'high_five', T0 + MIN, { count: 1 }), T0 + MIN);
        s = addEntry(s, e('a', 'high_five', T0 + 2 * MIN, { count: 1 }), T0 + 2 * MIN);
        expect(s).toHaveLength(1);
        expect(s[0].count).toBe(3);
        expect(entryVerb(s[0])).toBe('high-fived you ×3');
    });

    it('drops an entry stamped far in the future (clock nonsense)', () => {
        expect(pruneEntries([{ ...e('a', 'online', T0 + 10 * MIN), id: 'a:online' }], T0)).toEqual([]);
    });
});

describe('selectFeed — privacy filters', () => {
    const entries = [
        { ...e('friend', 'online', T0), id: 'friend:online' },
        { ...e('blocked', 'playing', T0, { title: 'x' }), id: 'blocked:playing' },
        { ...e('exfriend', 'online', T0), id: 'exfriend:online' },
    ];
    it('only current friends, never blocked, never a former friend', () => {
        const out = selectFeed(entries, { friendIds: new Set(['friend', 'blocked']), blockedIds: new Set(['blocked']), now: T0 + MIN });
        expect(out.map(x => x.userId)).toEqual(['friend']);
    });
    it('expired entries never render even if still in memory', () => {
        expect(selectFeed(entries, { friendIds: new Set(['friend']), blockedIds: new Set(), now: T0 + FEED_TTL_MS })).toEqual([]);
    });
});

describe('diffPresence', () => {
    const on = (game: string | null = null, text: string | null = null, emoji: string | null = null) => observation(true, game, text, emoji);
    const off = observation(false, 'Hades', 'secret', '🙂');

    it('an offline observation carries nothing (no game / status leak)', () => {
        expect(off).toEqual({ present: false, game: null, customText: null, customEmoji: null });
    });

    it('offline -> present = came online', () => {
        expect(diffPresence({ a: off }, { a: on() }, T0)).toEqual([{ userId: 'a', kind: 'online', at: T0 }]);
    });

    it('a first sighting is a baseline, not news', () => {
        expect(diffPresence({}, { a: on('Hades', 'hi') }, T0)).toEqual([]);
    });

    it('invisible / appear-offline friends never produce anything', () => {
        // From here "appear offline" IS offline: the server sends offline with nothing attached.
        const prev: PresenceSnapshot = { inv: observation(false, null, null, null) };
        const next: PresenceSnapshot = { inv: observation(false, 'Hades', 'up to something', '🎮') };
        expect(diffPresence(prev, next, T0)).toEqual([]);
    });

    it('going offline, stopping a game or clearing a status is not news', () => {
        expect(diffPresence({ a: on('Hades', 'hi') }, { a: off }, T0)).toEqual([]);
        expect(diffPresence({ a: on('Hades') }, { a: on(null) }, T0)).toEqual([]);
        expect(diffPresence({ a: on(null, 'hi') }, { a: on(null, null) }, T0)).toEqual([]);
    });

    it('a new game and a new status are news', () => {
        const out = diffPresence({ a: on('Hades') }, { a: on('Celeste', 'brb', '🍕') }, T0);
        expect(out).toEqual([
            { userId: 'a', kind: 'playing', at: T0, title: 'Celeste' },
            { userId: 'a', kind: 'status', at: T0, title: 'brb', emoji: '🍕' },
        ]);
    });

    it('coming back online with an unchanged status does not re-announce it', () => {
        const out = diffPresence({ a: off }, { a: on(null, 'brb') }, T0);
        expect(out.map(x => x.kind)).toEqual(['online']);
    });

    it('whitespace-only game / status counts as none', () => {
        expect(observation(true, '  ', ' ', '')).toEqual({ present: true, game: null, customText: null, customEmoji: null });
    });
});

describe('diffListening', () => {
    const l = (track: string, kind: ListeningObservation['kind'] = 'listening'): ListeningObservation => ({ kind, track, artist: 'Artist' });
    it('a new track or video is news; the same one is not', () => {
        const prev = new Map([['a', l('One')], ['b', l('Vid', 'watching')]]);
        const next = new Map([['a', l('Two')], ['b', l('Vid', 'watching')], ['c', l('Clip', 'watching')]]);
        expect(diffListening(prev, next, T0)).toEqual([
            { userId: 'a', kind: 'listening', at: T0, title: 'Two', detail: 'Artist' },
            { userId: 'c', kind: 'watching', at: T0, title: 'Clip', detail: 'Artist' },
        ]);
    });
    it('stopping is not news', () => {
        expect(diffListening(new Map([['a', l('One')]]), new Map(), T0)).toEqual([]);
    });
});

describe('deriveFriendCalls', () => {
    const channels = [
        { channel_id: 'v1', server_id: 's1', name: 'Lounge' },
        { channel_id: 'h1', server_id: 's1', name: 'Calls' },
    ];
    const servers = [{ server_id: 's1', name: 'Deep Sea Club' }];
    it('maps friends to the call they are in; strangers are ignored', () => {
        const m = deriveFriendCalls(new Set(['f1', 'f2']), { v1: ['f1', 'stranger'] }, { h1: [{ call_id: 'c9', name: 'Raid night', participants: ['f2'] }] }, channels, servers, null);
        expect(m.get('f1')).toMatchObject({ kind: 'voice', channelName: 'Lounge', serverName: 'Deep Sea Club', mine: false });
        expect(m.get('f2')).toMatchObject({ kind: 'huddle', id: 'c9', channelName: 'Raid night' });
        expect(m.has('stranger')).toBe(false);
    });
    it('a call in a channel this client was never sent (not visible) is skipped', () => {
        const m = deriveFriendCalls(new Set(['f1']), { hidden: ['f1'] }, {}, channels, servers, null);
        expect(m.size).toBe(0);
    });
    it('marks the call this client is in', () => {
        const m = deriveFriendCalls(new Set(['f1']), { v1: ['f1'] }, {}, channels, servers, { voiceChannelId: 'v1', huddleCallId: null });
        expect(m.get('f1')?.mine).toBe(true);
    });
});

describe('selectActiveNow', () => {
    const friends = [{ user_id: 'zed', username: 'Zed' }, { user_id: 'amy', username: 'Amy' }, { user_id: 'bo', username: 'Bo' }, { user_id: 'inv', username: 'Inv' }, { user_id: 'blk', username: 'Blk' }];
    const call = { kind: 'voice' as const, id: 'v1', channelId: 'v1', channelName: 'Lounge', serverId: 's', serverName: 'S', participantIds: ['bo'], mine: false };
    const media = { kind: 'listening' as const, track: 'T', artist: 'A', source: 'spotify', startedAt: 0, durationMs: null };
    const out = selectActiveNow(friends, {
        isPresent: id => id !== 'inv',
        gameOf: id => (id === 'zed' || id === 'inv' || id === 'blk' ? 'Hades' : null),
        mediaOf: id => (id === 'amy' || id === 'inv' ? media : null),
        calls: new Map([['bo', call]]),
        blockedIds: new Set(['blk']),
    });
    it('calls first, then games, then music; idle friends are not cards', () => {
        expect(out.map(c => c.userId)).toEqual(['bo', 'zed', 'amy']);
    });
    it('an offline / invisible friend never gets a card, even with a stale game or track', () => {
        expect(out.some(c => c.userId === 'inv')).toBe(false);
    });
    it('a blocked person never gets a card', () => {
        expect(out.some(c => c.userId === 'blk')).toBe(false);
    });
});

describe('todaysAnniversaries / times', () => {
    it('lists friends whose anniversary is today, skipping blocked', () => {
        const yrs = (s: string | null | undefined) => (s === 'yes' ? 2 : 0);
        expect(todaysAnniversaries([{ user_id: 'a', friends_since: 'yes' }, { user_id: 'b', friends_since: 'no' }, { user_id: 'c', friends_since: 'yes' }], new Set(['c']), yrs))
            .toEqual([{ userId: 'a', years: 2 }]);
    });
    it('short / long relative times', () => {
        expect(shortAgo(T0, T0 + 10_000)).toBe('now');
        expect(shortAgo(T0, T0 + 12 * MIN)).toBe('12m');
        expect(shortAgo(T0, T0 + 3 * 60 * MIN)).toBe('3h');
        expect(longAgo(T0, T0 + MIN)).toBe('1 minute ago');
        expect(longAgo(T0, T0 + 2 * 60 * MIN)).toBe('2 hours ago');
    });
});
