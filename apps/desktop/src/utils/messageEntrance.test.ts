import { describe, it, expect } from 'vitest';
import {
    assignRowKeys, createEntranceTracker, createRevealGate, messageRowKey, ENTRANCE_MAX_MS, type FeedRow,
} from './messageEntrance';
import { applySendPatch, adoptServerCopy } from './pendingSend';
import { sortChannelThread } from './messageOrder';

/**
 * Owner report: "When I send a message … I see the animation of it sending
 * like 3 times really fast." An instantly-sent message is touched several times
 * in its first few hundred ms (delivered patch, server echo adopting the server
 * id, server-time re-sort, history fold). The feed keyed rows and the entrance /
 * reveal decisions on `msg.id` (and `id::timestamp`), so each of those replayed
 * the animation. These tests run the REAL transitions (pendingSend, messageOrder)
 * and pin that the identity, the entrance and the reveal survive all of them.
 */

const ME_DEV = 'dev-me';
type Row = FeedRow & { id: string; content: { client_msg_id: string; type: string; text: string }; timestamp: string; send_state?: 'sending' | 'failed'; sender_user_id?: string | null };

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const history = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({
    id: `srv-old-${i}`,
    content: { client_msg_id: `peer-cid-${i}`, type: 'text', text: `m${i}` },
    sender_device_id: i % 2 ? ME_DEV : 'dev-peer',
    sender_user_id: i % 2 ? 'me' : 'peer',
    timestamp: iso(T0 - (n - i) * 60_000),
}));

const localSend = (cid: string, at: number): Row => ({
    id: cid,
    content: { client_msg_id: cid, type: 'text', text: 'hello' },
    sender_device_id: ME_DEV,
    sender_user_id: 'me',
    timestamp: iso(at),
    send_state: 'sending',
});

/** The channel lifecycle of one instant send, as Dashboard applies it. */
function channelLifecycle(serverSkewMs = 40) {
    const cid = 'cid-1';
    const sid = 'srv-new-1';
    const serverTs = iso(T0 + serverSkewMs);
    const s0 = [...history(5)];
    const s1 = [...s0, localSend(cid, T0)];                                   // handleChannelMessageSent
    const echo = adoptServerCopy(s1, { id: sid, content: s1[5].content, sender_user_id: 'me', timestamp: serverTs });
    const s2 = sortChannelThread(echo!);                                      // live echo adopts the server id
    const s3 = sortChannelThread(applySendPatch(s2, cid, { send_state: null, id: sid, sender_user_id: 'me', timestamp: serverTs })); // delivery patch
    const s4 = s3.map(m => ({ ...m }));                                       // history fold: fresh objects
    return { cid, sid, states: [s0, s1, s2, s3, s4] };
}

describe('messageRowKey / assignRowKeys — a row keeps one identity', () => {
    it('this device\'s channel send keeps its key through client-id → server-id adoption', () => {
        const { sid, states: [, s1, s2, s3, s4] } = channelLifecycle();
        const mine = (s: Row[]) => s.find(m => m.content.client_msg_id === 'cid-1')!;
        // Positive control: the id really does change (what remounted the row).
        expect(mine(s1).id).toBe('cid-1');
        expect(mine(s2).id).toBe(sid);
        const keys = [s1, s2, s3, s4].map(s => messageRowKey(mine(s), ME_DEV, 0));
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toBe('c:cid-1');
    });

    it('a DM send (id is the client id throughout) keeps its key through the server-time patch', () => {
        const t = [...history(3), localSend('dm-cid', T0)];
        const after = applySendPatch(t, 'dm-cid', { send_state: null, server_ts: iso(T0 - 5), timestamp: iso(T0 - 5) });
        const k = (s: Row[]) => messageRowKey(s.find(m => m.content.client_msg_id === 'dm-cid')!, ME_DEV, 0);
        expect(k(after)).toBe(k(t));
    });

    it('someone else\'s client_msg_id never becomes a key (their client chose it)', () => {
        const peer: Row = { id: 'srv-p', content: { client_msg_id: 'chosen', type: 'text', text: 'x' }, sender_device_id: 'dev-peer', timestamp: iso(T0) };
        expect(messageRowKey(peer, ME_DEV, 3)).toBe('srv-p');
        // And with no device id known, nothing is treated as ours.
        expect(messageRowKey(localSend('c', T0), null, 0)).toBe('c');
        expect(messageRowKey({ content: {} }, ME_DEV, 7)).toBe('i:7');
    });

    it('never hands React a duplicate key, even for colliding client ids', () => {
        const a = { ...localSend('dup', T0), id: 'srv-a' };
        const b = { ...localSend('dup', T0 + 1), id: 'srv-b' };
        const c = { ...localSend('dup', T0 + 2), id: 'srv-a' };
        const noId = { content: {}, sender_device_id: 'x' } as FeedRow;
        const keys = assignRowKeys([a, b, c, noId, noId], ME_DEV);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys[0]).toBe('c:dup');
    });
});

describe('createEntranceTracker — one send animates exactly once', () => {
    const run = (states: Row[][], now: number[] = states.map((_, i) => T0 + i * 100)) => {
        const tr = createEntranceTracker();
        return states.map((s, i) => {
            const keys = assignRowKeys(s, ME_DEV);
            return { keys, entering: tr.decide(s, keys, now[i]), tr };
        });
    };

    it('the sent row enters once and stays entering (same key) through echo, patch, re-sort and history fold', () => {
        const { states } = channelLifecycle();
        const r = run(states);
        expect(r[0].entering.size).toBe(0);                // first populated render: no cascade
        expect([...r[1].entering]).toEqual(['c:cid-1']);
        for (const step of r.slice(2)) expect([...step.entering]).toEqual(['c:cid-1']);
    });

    it('after its animationend it never animates again, whatever happens to the row', () => {
        const { states } = channelLifecycle();
        const tr = createEntranceTracker();
        const decide = (s: Row[], now: number) => tr.decide(s, assignRowKeys(s, ME_DEV), now);
        decide(states[0], T0);
        expect(decide(states[1], T0 + 10).has('c:cid-1')).toBe(true);
        tr.finish('c:cid-1');
        for (const s of states.slice(2)) expect(decide(s, T0 + 500).size).toBe(0);
    });

    it('positive control: the old msg.id bookkeeping DID see the adopted row as a new message', () => {
        // Same transitions, keyed the old way: the server id is not among the
        // ids "seen" so far, so it qualified for a second entrance.
        const { sid, states: [s0, s1, s2] } = channelLifecycle();
        const seenIds = new Set([...s0, ...s1].map(m => m.id));
        expect(s2.some(m => m.id === sid && !seenIds.has(m.id))).toBe(true);
        // …whereas its identity was already known.
        const seenKeys = new Set(assignRowKeys(s1, ME_DEV));
        expect(assignRowKeys(s2, ME_DEV).every(k => seenKeys.has(k))).toBe(true);
    });

    it('keeps entering even when the server time lands >1s before the compose time (clock skew)', () => {
        const { states } = channelLifecycle(-3000);
        const r = run(states);
        for (const step of r.slice(1)) expect(step.entering.has('c:cid-1')).toBe(true);
    });

    it('older rows paginated in at the top never animate; a peer message appended does', () => {
        const tr = createEntranceTracker();
        const base = history(4);
        tr.decide(base, assignRowKeys(base, ME_DEV), T0);
        const older: Row = { ...history(1)[0], id: 'srv-older', timestamp: iso(T0 - 99 * 60_000) };
        const withOlder = [older, ...base];
        expect(tr.decide(withOlder, assignRowKeys(withOlder, ME_DEV), T0 + 1).size).toBe(0);
        const peer: Row = { id: 'srv-peer-new', content: { client_msg_id: 'p', type: 'text', text: 'hi' }, sender_device_id: 'dev-peer', timestamp: iso(T0) };
        const withPeer = [...withOlder, peer];
        expect([...tr.decide(withPeer, assignRowKeys(withPeer, ME_DEV), T0 + 2)]).toEqual(['srv-peer-new']);
    });

    it('a row whose animationend never arrives stops entering after ENTRANCE_MAX_MS, and never restarts', () => {
        const tr = createEntranceTracker();
        const base = history(2);
        tr.decide(base, assignRowKeys(base, ME_DEV), T0);
        const s = [...base, localSend('c9', T0)];
        const keys = assignRowKeys(s, ME_DEV);
        expect(tr.decide(s, keys, T0).has('c:c9')).toBe(true);
        expect(tr.decide(s, keys, T0 + ENTRANCE_MAX_MS - 1).has('c:c9')).toBe(true);
        expect(tr.decide(s, keys, T0 + ENTRANCE_MAX_MS).has('c:c9')).toBe(false);
        expect(tr.decide(s, keys, T0 + ENTRANCE_MAX_MS + 1).size).toBe(0);
    });

    it('reset() starts a fresh conversation (seeds again, animates nothing)', () => {
        const tr = createEntranceTracker();
        const a = history(2);
        tr.decide(a, assignRowKeys(a, ME_DEV), T0);
        tr.reset();
        const b = [...history(3), localSend('z', T0)];
        expect(tr.decide(b, assignRowKeys(b, ME_DEV), T0).size).toBe(0);
    });
});

describe('createRevealGate — the new-message reveal fires once per message', () => {
    const lastKey = (s: Row[]) => (s.length ? messageRowKey(s[s.length - 1], ME_DEV, 'no-id') : null);

    it('one send → exactly one reveal, through echo, patch, re-sort and history fold', () => {
        const { states } = channelLifecycle();
        const g = createRevealGate();
        const fired = states.map(s => g.check('chan', lastKey(s)));
        expect(fired).toEqual([false, true, false, false, false]);
    });

    it('positive control: the old `${id}::${timestamp}` key changed on every one of those updates', () => {
        const { states: [, s1, s2, s3] } = channelLifecycle();
        const oldKey = (s: Row[]) => { const l = s[s.length - 1]; return `${l.id}::${l.timestamp}`; };
        expect(oldKey(s2)).not.toBe(oldKey(s1));
        // A DM send: no id change, but the server time alone changed the old key.
        const t = [...history(2), localSend('dm', T0)];
        const after = applySendPatch(t, 'dm', { send_state: null, server_ts: iso(T0 + 9), timestamp: iso(T0 + 9) });
        expect(oldKey(after)).not.toBe(oldKey(t));
        expect(lastKey(after)).toBe(lastKey(t));
        expect(s3.length).toBe(s2.length);
    });

    it('a genuinely new message reveals again; a re-sort that puts an older row last does not', () => {
        const g = createRevealGate();
        const base = history(3);
        g.check('c', lastKey(base));
        const a = [...base, localSend('a', T0)];
        expect(g.check('c', lastKey(a))).toBe(true);
        const peer: Row = { id: 'srv-p', content: { client_msg_id: 'p', type: 'text', text: 'p' }, sender_device_id: 'dev-peer', timestamp: iso(T0 + 1) };
        const b = [...a, peer];
        expect(g.check('c', lastKey(b))).toBe(true);
        // Our row's server time sorts it after the peer's: it is last again, but
        // it was already revealed.
        expect(g.check('c', lastKey([...base, peer, a[a.length - 1]]))).toBe(false);
    });

    it('a chat switch only records — the chat-switch snap owns that', () => {
        const g = createRevealGate();
        expect(g.check('c1', lastKey(history(2)))).toBe(false);
        expect(g.check('c2', lastKey([...history(2), localSend('q', T0)]))).toBe(false);
        expect(g.check('c2', null)).toBe(false);
    });
});
