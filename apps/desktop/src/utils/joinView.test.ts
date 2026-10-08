import { describe, it, expect } from 'vitest';
import { displayHuddleCalls, voiceJoinPeers, type JoinView } from './joinView';
import type { HuddleCallInfo } from '../hooks/useServers';

const ME = 'me';
const call = (id: string, participants: string[], spawned = '2026-10-08T10:00:00Z'): HuddleCallInfo => ({
    call_id: id, huddle_id: 'h1', name: `Call ${id}`, spawner_user_id: 'x', spawned_at: spawned, participants,
});
const server = { h1: [call('c1', ['a', 'b'])] };

describe('displayHuddleCalls — joining an existing call', () => {
    const view: JoinView = { kind: 'huddle', huddleId: 'h1', callId: 'c1', renderKey: 'c1', spawnedAt: '' };

    it('puts you IN the call, after everyone already there (where the server appends you)', () => {
        const d = displayHuddleCalls(server, view, ME, null);
        expect(d.calls.h1[0].participants).toEqual(['a', 'b', ME]);
        expect(d.mineCallId).toBe('c1');
    });
    it('does not duplicate you once the server lists you', () => {
        const d = displayHuddleCalls({ h1: [call('c1', ['a', 'b', ME])] }, view, ME, 'c1');
        expect(d.calls.h1[0].participants).toEqual(['a', 'b', ME]);
    });
    it('touches no other call, and returns the same object when nothing changes', () => {
        const two = { h1: [call('c1', ['a']), call('c2', ['z'])] };
        const d = displayHuddleCalls(two, view, ME, null);
        expect(d.calls.h1[1]).toBe(two.h1[1]);
        const same = { h1: [call('c1', ['a', ME])] };
        expect(displayHuddleCalls(same, view, ME, 'c1').calls).toBe(same);
    });
    it('positive control: without a view or an active call nothing is added', () => {
        const d = displayHuddleCalls(server, null, ME, null);
        expect(d.calls).toBe(server);
        expect(d.mineCallId).toBeNull();
    });
    it('in a call (no view): you stay listed even if a server event lags', () => {
        const d = displayHuddleCalls(server, null, ME, 'c1');
        expect(d.calls.h1[0].participants).toEqual(['a', 'b', ME]);
    });
});

describe('displayHuddleCalls — starting a new call (client-side card)', () => {
    const spawn: JoinView = { kind: 'huddle', huddleId: 'h1', callId: null, renderKey: 'joining:h1:1', predictedName: "Me's Call", spawnedAt: '2026-10-08T10:05:00Z' };

    it('draws a call with just you in it, newest, under a stable key, not renamable yet', () => {
        const d = displayHuddleCalls(server, spawn, ME, null);
        const mine = d.calls.h1[1];
        expect(d.calls.h1).toHaveLength(2);
        expect(mine).toMatchObject({ call_id: 'joining:h1:1', render_key: 'joining:h1:1', participants: [ME], name: "Me's Call", spawner_user_id: '' });
        expect(d.mineCallId).toBe('joining:h1:1');
    });
    it('spawn returned but the server list has not caught up: same card, now the real id and name', () => {
        const d = displayHuddleCalls(server, { ...spawn, realCallId: 'c9', realName: 'General 2' }, ME, 'c9');
        const mine = d.calls.h1[1];
        expect(mine).toMatchObject({ call_id: 'c9', render_key: 'joining:h1:1', name: 'General 2', spawner_user_id: ME, participants: [ME] });
    });
    it('the server card arrives: it is drawn under the SAME key (becomes the card, no remount) and not twice', () => {
        const withReal = { h1: [...server.h1, call('c9', [ME], '2026-10-08T10:05:01Z')] };
        const d = displayHuddleCalls(withReal, { ...spawn, realCallId: 'c9' }, ME, 'c9');
        expect(d.calls.h1).toHaveLength(2);
        expect(d.calls.h1[1].render_key).toBe('joining:h1:1');
        expect(d.calls.h1[1].call_id).toBe('c9');
    });
    it('a huddle with no calls yet gets the card', () => {
        const d = displayHuddleCalls({}, spawn, ME, null);
        expect(d.calls.h1.map(c => c.call_id)).toEqual(['joining:h1:1']);
    });
});

describe('voiceJoinPeers', () => {
    it('everyone presence lists, minus you, in presence order, with names from the lookup', () => {
        const peers = voiceJoinPeers(['a', ME, 'b'], ME, uid => ({ name: uid.toUpperCase(), avatarId: null }));
        expect(peers.map(p => [p.userId, p.name])).toEqual([['a', 'A'], ['b', 'B']]);
    });
    it('an empty channel → nobody (a new call with just you)', () => {
        expect(voiceJoinPeers(undefined, ME, () => ({ name: '', avatarId: null }))).toEqual([]);
    });
});
