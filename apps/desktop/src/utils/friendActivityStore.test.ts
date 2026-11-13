import { describe, it, expect, beforeEach } from 'vitest';
import { FriendActivityRecorder } from './friendActivityStore';
import { observation, SETTLE_MS } from './friendActivity';

const T0 = 1_800_000_000_000;
const on = (game: string | null = null) => observation(true, game, null, null);
const off = observation(false, null, null, null);
const friends = (...ids: string[]) => new Set(ids);
const none = new Set<string>();

let r: FriendActivityRecorder;
beforeEach(() => { r = new FriendActivityRecorder(); });

describe('FriendActivityRecorder', () => {
    it('the burst right after a (re)connect is a baseline, not a flood of "came online"', () => {
        r.setFriends(friends('a', 'b'), none, T0);
        r.beginSettle(T0);
        r.observePresence({ a: off, b: off }, T0);          // friends-list seed: everyone offline
        r.observePresence({ a: on(), b: on('Hades') }, T0 + 500); // status batch lands
        expect(r.getSnapshot()).toEqual([]);
        // After the window, a real change is news.
        r.observePresence({ a: on('Celeste'), b: on('Hades') }, T0 + SETTLE_MS + 1);
        expect(r.getSnapshot().map(e => `${e.userId}:${e.kind}:${e.title}`)).toEqual(['a:playing:Celeste']);
    });

    it('only friends are recorded', () => {
        r.setFriends(friends('a'), none, T0);
        r.observePresence({ a: off, stranger: off }, T0);
        r.observePresence({ a: on(), stranger: on() }, T0 + 1);
        r.record({ userId: 'stranger', kind: 'avatar', at: T0 + 2 }, T0 + 2);
        expect(r.getSnapshot().map(e => e.userId)).toEqual(['a']);
    });

    it('unfriending or blocking purges that person from the timeline', () => {
        r.setFriends(friends('a', 'b'), none, T0);
        r.record({ userId: 'a', kind: 'avatar', at: T0 }, T0);
        r.record({ userId: 'b', kind: 'avatar', at: T0 }, T0);
        r.setFriends(friends('a', 'b'), friends('b'), T0 + 1);
        expect(r.getSnapshot().map(e => e.userId)).toEqual(['a']);
        r.setFriends(friends(), none, T0 + 2);
        expect(r.getSnapshot()).toEqual([]);
    });

    it('a re-added friend starts from a fresh baseline', () => {
        r.setFriends(friends('a'), none, T0);
        r.observePresence({ a: on() }, T0);
        r.setFriends(friends(), none, T0 + 1);
        r.setFriends(friends('a'), none, T0 + 2);
        // Not "came online": we have no earlier picture of them any more.
        r.observePresence({ a: on() }, T0 + 3);
        expect(r.getSnapshot().map(e => e.kind)).toEqual(['new_friend']);
    });

    it('a friend added after the first loaded list is "new friend"; the first list is not', () => {
        r.setFriends(friends(), none, T0, false);  // initial empty state, not loaded
        r.setFriends(friends('a', 'b'), none, T0 + 1, true);
        expect(r.getSnapshot()).toEqual([]);
        r.setFriends(friends('a', 'b', 'c'), none, T0 + 2, true);
        expect(r.getSnapshot().map(e => `${e.userId}:${e.kind}`)).toEqual(['c:new_friend']);
    });

    it('listening: new tracks of friends after the settle window', () => {
        r.setFriends(friends('a'), none, T0);
        r.observeListening(new Map([['a', { kind: 'listening', track: 'One', artist: 'X' }]]), T0);
        r.observeListening(new Map([['a', { kind: 'listening', track: 'Two', artist: 'X' }], ['me', { kind: 'listening', track: 'Mine', artist: 'Y' }]]), T0 + 1);
        expect(r.getSnapshot().map(e => `${e.userId}:${e.title}`)).toEqual(['a:Two']);
    });

    it('clear() forgets everything (account switch / sign-out)', () => {
        r.setFriends(friends('a'), none, T0);
        r.record({ userId: 'a', kind: 'high_five', at: T0, count: 1 }, T0);
        r.clear();
        expect(r.getSnapshot()).toEqual([]);
        r.record({ userId: 'a', kind: 'high_five', at: T0, count: 1 }, T0);
        expect(r.getSnapshot()).toEqual([]); // not a friend of the new account (yet)
    });

    it('notifies subscribers on change only', () => {
        let n = 0;
        const off_ = r.subscribe(() => { n++; });
        r.setFriends(friends('a'), none, T0);
        r.record({ userId: 'a', kind: 'avatar', at: T0 }, T0);
        r.record({ userId: 'zz', kind: 'avatar', at: T0 }, T0);
        off_();
        r.record({ userId: 'a', kind: 'online', at: T0 + 1 }, T0 + 1);
        expect(n).toBe(1);
    });
});
