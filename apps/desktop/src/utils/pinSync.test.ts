import { describe, it, expect } from 'vitest';
import { applyPinOp, applyPinOps, localPinOp, pruneLedger, type PinState } from './pinSync';

/**
 * Pins sync device-to-device over a store-and-forward envelope, so ops arrive
 * in arbitrary order and can arrive twice. Everything here is about the two
 * failure modes that produces: two devices settling on different answers, and
 * a redelivered envelope flipping a pin back.
 */

const empty = (): PinState => ({ pins: {}, ledger: {} });
const op = (container: string, target: string, action: 'add' | 'remove', at: number) =>
    ({ container_id: container, target_id: target, action, at });

describe('applyPinOp — basics', () => {
    it('adds a pin', () => {
        const s = applyPinOp(empty(), op('c1', 'm1', 'add', 100));
        expect(s.pins.c1).toEqual(['m1']);
    });

    it('removes a pin', () => {
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 100));
        s = applyPinOp(s, op('c1', 'm1', 'remove', 200));
        expect(s.pins.c1).toBeUndefined();   // container dropped, not left as []
    });

    it('keeps containers independent', () => {
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 100));
        s = applyPinOp(s, op('c2', 'm2', 'add', 100));
        expect(s.pins.c1).toEqual(['m1']);
        expect(s.pins.c2).toEqual(['m2']);
    });

    it('does not crash on an op for a container it has never seen', () => {
        const s = applyPinOp(empty(), op('unknown', 'm9', 'remove', 100));
        expect(s.pins.unknown).toBeUndefined();
    });

    it('ignores a malformed op rather than corrupting state', () => {
        const base = applyPinOp(empty(), op('c1', 'm1', 'add', 100));
        expect(applyPinOp(base, op('', 'm1', 'add', 200))).toBe(base);
        expect(applyPinOp(base, op('c1', '', 'add', 200))).toBe(base);
        expect(applyPinOp(base, op('c1', 'm1', 'add', NaN))).toBe(base);
    });
});

describe('last-write-wins', () => {
    it('a newer op wins', () => {
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 100));
        s = applyPinOp(s, op('c1', 'm1', 'remove', 200));
        expect(s.pins.c1).toBeUndefined();
    });

    it('an older op arriving late is ignored', () => {
        // The unpin happened at t=200 and already landed; a pin stamped t=100
        // shows up afterwards because it took the slow path through a device
        // that was offline. It must NOT resurrect the pin.
        let s = applyPinOp(empty(), op('c1', 'm1', 'remove', 200));
        s = applyPinOp(s, op('c1', 'm1', 'add', 100));
        expect(s.pins.c1).toBeUndefined();
    });

    it('converges regardless of arrival order', () => {
        const a = op('c1', 'm1', 'add', 100);
        const b = op('c1', 'm1', 'remove', 200);
        const forward = applyPinOps(empty(), [a, b]);
        const reverse = applyPinOps(empty(), [b, a]);
        expect(forward.pins).toEqual(reverse.pins);
        expect(forward.pins.c1).toBeUndefined();
    });

    it('converges for remove-then-add too', () => {
        const a = op('c1', 'm1', 'remove', 100);
        const b = op('c1', 'm1', 'add', 200);
        const forward = applyPinOps(empty(), [a, b]);
        const reverse = applyPinOps(empty(), [b, a]);
        expect(forward.pins).toEqual(reverse.pins);
        expect(forward.pins.c1).toEqual(['m1']);
    });

    it('is idempotent — a redelivered envelope is a no-op, not a flip', () => {
        const o = op('c1', 'm1', 'add', 100);
        const once = applyPinOp(empty(), o);
        const twice = applyPinOp(once, o);
        expect(twice).toBe(once);            // identity: no re-render, no write
        expect(twice.pins.c1).toEqual(['m1']);
    });

    it('an equal timestamp does not flip the value', () => {
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 100));
        s = applyPinOp(s, op('c1', 'm1', 'remove', 100));
        expect(s.pins.c1).toEqual(['m1']);
    });

    it('records a timestamp even when the id set does not move', () => {
        // Two devices both pin the same message. The second op changes
        // nothing visible, but if its timestamp were dropped a later, older
        // unpin would find no ledger entry and get applied.
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 100));
        s = applyPinOp(s, op('c1', 'm1', 'add', 300));
        s = applyPinOp(s, op('c1', 'm1', 'remove', 200));   // older than 300
        expect(s.pins.c1).toEqual(['m1']);
    });

    it('does not duplicate an id that is already pinned', () => {
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 100));
        s = applyPinOp(s, op('c1', 'm1', 'add', 200));
        expect(s.pins.c1).toEqual(['m1']);
    });
});

/**
 * Convergence for the "a deleted message unpins itself everywhere" fix
 * (dmInbound.deletedDmTargets / channelHistoryMerge.deletedChannelTargetIds):
 * every device that learns of the delete broadcasts its OWN unpin op for the
 * same target, independently and with its own clock. These document that the
 * ledger absorbs that without flapping or resurrecting the pin.
 */
describe('multi-device convergence for a delete-triggered unpin', () => {
    it('an unpin op for an already-unpinned id is a harmless no-op', () => {
        // Device A already processed the delete and unpinned at t=100.
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 0));
        s = applyPinOp(s, op('c1', 'm1', 'remove', 100));
        // Device B's copy of the SAME delete arrives late and broadcasts its
        // own unpin op, stamped later still.
        const again = applyPinOp(s, op('c1', 'm1', 'remove', 150));
        expect(again.pins.c1).toBeUndefined();
        expect(again.ledger.c1.m1).toBe(150);   // ledger still advances...
        // ...but re-applying with an identical-or-older timestamp changes nothing.
        expect(applyPinOp(again, op('c1', 'm1', 'remove', 150))).toBe(again);
    });

    it('two devices each unpinning the same delete converge regardless of which broadcasts first', () => {
        const unpinFromDeviceA = op('c1', 'm1', 'remove', 100);
        const unpinFromDeviceB = op('c1', 'm1', 'remove', 105);
        const base = applyPinOp(empty(), op('c1', 'm1', 'add', 0));
        const aThenB = applyPinOps(base, [unpinFromDeviceA, unpinFromDeviceB]);
        const bThenA = applyPinOps(base, [unpinFromDeviceB, unpinFromDeviceA]);
        expect(aThenB.pins).toEqual(bThenA.pins);
        expect(aThenB.pins.c1).toBeUndefined();
    });

    it('a stale pin op that predates the delete cannot resurrect it', () => {
        // The user pinned at t=50, the message was deleted and every device's
        // unpin lands at t=200. A slow-arriving copy of the ORIGINAL pin op
        // (e.g. a redelivered envelope, or a device that was offline since
        // before the delete) must not bring the pin back.
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 50));
        s = applyPinOp(s, op('c1', 'm1', 'remove', 200));
        const late = applyPinOp(s, op('c1', 'm1', 'add', 50));
        expect(late.pins.c1).toBeUndefined();
        expect(late).toBe(s);   // identity: the stale op changed nothing at all
    });
});

describe('localPinOp', () => {
    it('stamps the given clock and round-trips through applyPinOp', () => {
        const o = localPinOp('c1', 'm1', 'add', 1234);
        expect(o).toEqual({ container_id: 'c1', target_id: 'm1', action: 'add', at: 1234 });
        expect(applyPinOp(empty(), o).pins.c1).toEqual(['m1']);
    });

    it('a local op beats an older remote one', () => {
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 100));
        s = applyPinOp(s, localPinOp('c1', 'm1', 'remove', 500));
        expect(s.pins.c1).toBeUndefined();
    });
});

describe('pruneLedger', () => {
    const DAY = 86_400_000;

    it('drops stale entries for ids that are no longer pinned', () => {
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 0));
        s = applyPinOp(s, op('c1', 'm1', 'remove', 1));
        const pruned = pruneLedger(s, 30 * DAY, 7 * DAY);
        expect(pruned.ledger.c1).toBeUndefined();
    });

    it('never drops an entry for a currently-pinned id, however old', () => {
        const s = applyPinOp(empty(), op('c1', 'm1', 'add', 0));
        const pruned = pruneLedger(s, 365 * DAY, 7 * DAY);
        expect(pruned.ledger.c1.m1).toBe(0);
        expect(pruned.pins.c1).toEqual(['m1']);
    });

    it('keeps a recent unpin so a slow duplicate cannot resurrect it', () => {
        let s = applyPinOp(empty(), op('c1', 'm1', 'add', 0));
        s = applyPinOp(s, op('c1', 'm1', 'remove', 1000));
        const pruned = pruneLedger(s, 2000, 7 * DAY);
        expect(pruned.ledger.c1.m1).toBe(1000);
    });

    it('returns the same object when nothing needed pruning', () => {
        const s = applyPinOp(empty(), op('c1', 'm1', 'add', 0));
        expect(pruneLedger(s, 1000, 7 * DAY)).toBe(s);
    });
});
