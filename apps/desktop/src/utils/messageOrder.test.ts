import { describe, it, expect } from 'vitest';
import { compareServerOrder, placeByServerOrder, repositionByServerOrder, serverOrderIndex, sortChannelThread, type OrderRow } from './messageOrder';
import { applySendPatch } from './pendingSend';

type Row = Omit<OrderRow, 'send_state'> & { timestamp?: string; send_state?: 'sending' | 'failed' };
const at = (s: number) => new Date(Date.UTC(2026, 9, 7, 12, 0, s)).toISOString();
const confirmed = (id: string, s: number): Row => ({ id, server_ts: at(s), timestamp: at(s) });
const sending = (id: string): Row => ({ id, send_state: 'sending', timestamp: 'local' });
const ids = (t: Row[]) => t.map(r => r.id);

describe('serverOrderIndex / placeByServerOrder', () => {
    it('a confirmed row goes after everything the server stamped earlier', () => {
        const t = [confirmed('a', 1), confirmed('c', 3)];
        expect(ids(placeByServerOrder(t, confirmed('b', 2)))).toEqual(['a', 'b', 'c']);
        expect(ids(placeByServerOrder(t, confirmed('d', 4)))).toEqual(['a', 'c', 'd']);
    });

    it('rows still being sent stay below every confirmed row', () => {
        const t = [confirmed('a', 1), sending('mine')];
        expect(ids(placeByServerOrder(t, confirmed('b', 2)))).toEqual(['a', 'b', 'mine']);
    });

    it('never moves anything past a row with no server stamp (history from before, a failed send)', () => {
        const legacy: Row = { id: 'old', timestamp: at(50) };
        const failed: Row = { id: 'f', send_state: 'failed', timestamp: at(60) };
        expect(ids(placeByServerOrder([confirmed('a', 1), legacy], confirmed('b', 0)))).toEqual(['a', 'old', 'b']);
        expect(ids(placeByServerOrder([confirmed('a', 1), failed], confirmed('b', 0)))).toEqual(['a', 'f', 'b']);
    });

    it('a row without a server stamp of its own simply appends', () => {
        const t = [confirmed('a', 5), sending('s')];
        expect(serverOrderIndex(t, { id: 'x' })).toBe(2);
    });

    it('ties are broken by id, so every device picks the same order', () => {
        const t = [confirmed('m', 1)];
        expect(ids(placeByServerOrder(t, confirmed('a', 1)))).toEqual(['a', 'm']);
        expect(ids(placeByServerOrder(t, confirmed('z', 1)))).toEqual(['m', 'z']);
        expect(compareServerOrder(confirmed('a', 1), confirmed('a', 1))).toBe(0);
    });

    it('does not mutate its input', () => {
        const t = [confirmed('a', 1)];
        placeByServerOrder(t, confirmed('b', 2));
        expect(ids(t)).toEqual(['a']);
    });

    it('repositionByServerOrder moves a just-confirmed row up past later rows', () => {
        const t = [confirmed('a', 1), confirmed('c', 3), { ...confirmed('mine', 2) }];
        expect(ids(repositionByServerOrder(t, 2))).toEqual(['a', 'mine', 'c']);
    });
});

/**
 * The bug the owner reported: two people typing at once saw the messages in
 * different orders. Each device is simulated with exactly the operations the
 * app performs — the sender's instant row (pending), the server confirmation
 * (applySendPatch with server_ts), and an incoming pulled row
 * (placeByServerOrder, as applyIncomingDmMessages does).
 */
describe('every device converges on the server order', () => {
    // Alice sends "a1"; while it is in flight Bob's "b1" reaches the server.
    // `aTs` is when the server stored a1, relative to b1 at t=10.
    function run(aTs: number) {
        // Alice's device
        let alice: Row[] = [sending('a1')];
        alice = placeByServerOrder(alice, confirmed('b1', 10));                 // Bob's arrives by pull
        alice = applySendPatch(alice, 'a1', { send_state: null, server_ts: at(aTs) }); // a1 confirmed
        // Bob's device
        let bob: Row[] = [sending('b1')];
        bob = applySendPatch(bob, 'b1', { send_state: null, server_ts: at(10) });
        bob = placeByServerOrder(bob, confirmed('a1', aTs));                    // Alice's arrives by pull
        // A third member who only receives
        let carol: Row[] = [];
        for (const r of [confirmed('b1', 10), confirmed('a1', aTs)].sort(() => -1)) carol = placeByServerOrder(carol, r);
        return { alice: ids(alice), bob: ids(bob), carol: ids(carol) };
    }

    it('a1 stored AFTER b1: all three show b1, a1', () => {
        const { alice, bob, carol } = run(11);
        expect(alice).toEqual(['b1', 'a1']);
        expect(bob).toEqual(['b1', 'a1']);
        expect(carol).toEqual(['b1', 'a1']);
    });

    it('a1 stored BEFORE b1 (its confirmation just arrived later): all three show a1, b1', () => {
        const { alice, bob, carol } = run(9);
        expect(alice).toEqual(['a1', 'b1']);
        expect(bob).toEqual(['a1', 'b1']);
        expect(carol).toEqual(['a1', 'b1']);
    });

    // Positive control: the previous behaviour — append on arrival, never move
    // the sender's row — produces exactly the disagreement that was reported.
    it('control: arrival-order append makes Alice and Bob disagree', () => {
        const alice = ['a1', 'b1'];        // hers went in at Enter, his arrived later
        const bob = ['b1', 'a1'];          // his went in at Enter, hers arrived later
        expect(alice).not.toEqual(bob);
    });

    it('a burst from one sender keeps its order when confirmations land interleaved with an incoming row', () => {
        let t: Row[] = [sending('m1'), sending('m2'), sending('m3')];
        t = applySendPatch(t, 'm1', { send_state: null, server_ts: at(1) });
        t = placeByServerOrder(t, confirmed('other', 2));
        t = applySendPatch(t, 'm2', { send_state: null, server_ts: at(3) });
        t = applySendPatch(t, 'm3', { send_state: null, server_ts: at(4) });
        expect(ids(t)).toEqual(['m1', 'other', 'm2', 'm3']);
    });
});

describe('sortChannelThread', () => {
    it('orders by timestamp and is stable for equal ones', () => {
        const t = [{ id: 'b', timestamp: at(2) }, { id: 'a1', timestamp: at(1) }, { id: 'a2', timestamp: at(1) }];
        expect(sortChannelThread(t).map(r => r.id)).toEqual(['a1', 'a2', 'b']);
    });
});
