/**
 * The impact landing runs ONCE, for the local user's own just-sent message,
 * as that row's entrance — driven through the real entrance tracker and row
 * keys the feed uses (utils/messageEntrance.ts), exactly as ChatPane composes
 * them: `impacting = impactSlot.isImpacting(rowKey, entering)`.
 */
import { describe, it, expect } from 'vitest';
import { assignRowKeys, createEntranceTracker, type FeedRow } from './messageEntrance';
import { createImpactSlot, ownRowKey } from './composerFun';

const ME_DEV = 'dev-me';
const msg = (id: string, ts: number, dev: string, cid?: string): FeedRow => ({
    id, timestamp: ts, sender_device_id: dev, content: { type: 'text', ...(cid ? { client_msg_id: cid } : {}) },
});

function render(rows: FeedRow[], tracker: ReturnType<typeof createEntranceTracker>, slot: ReturnType<typeof createImpactSlot>, now: number) {
    const keys = assignRowKeys(rows, ME_DEV);
    const entering = tracker.decide(rows, keys, now);
    return keys.filter(k => slot.isImpacting(k, entering.has(k)));
}

describe('impact landing', () => {
    it('history load never impacts, even with the slot armed for a row in it', () => {
        const tracker = createEntranceTracker();
        const slot = createImpactSlot();
        const history = [msg('a', 1000, 'other'), msg('b', 2000, ME_DEV, 'cid-b')];
        slot.arm(ownRowKey('cid-b'));
        expect(render(history, tracker, slot, 5000)).toEqual([]);
    });

    it('own just-sent message impacts on its first render, through the id swap, then never again', () => {
        const tracker = createEntranceTracker();
        const slot = createImpactSlot();
        const history = [msg('a', 1000, 'other')];
        render(history, tracker, slot, 5000);                      // first populated render: seeds

        slot.arm(ownRowKey('cid-1'));
        const local = msg('cid-1', 3000, ME_DEV, 'cid-1');         // instant send, client id
        expect(render([...history, local], tracker, slot, 5100)).toEqual(['c:cid-1']);

        // Delivery swaps in the server id + server time — same row, still entering.
        const confirmed = msg('srv-77', 3005, ME_DEV, 'cid-1');
        expect(render([...history, confirmed], tracker, slot, 5300)).toEqual(['c:cid-1']);

        // animationend → finish + spend (what the row's onAnimationEnd does).
        tracker.finish('c:cid-1');
        slot.spend('c:cid-1');
        expect(slot.armed()).toBeNull();
        expect(render([...history, confirmed], tracker, slot, 5400)).toEqual([]);
        expect(render([...history, confirmed, msg('x', 9000, 'other')], tracker, slot, 9100)).toEqual([]);
    });

    it('someone else\'s new message never impacts, even if it reuses the armed client id', () => {
        const tracker = createEntranceTracker();
        const slot = createImpactSlot();
        render([msg('a', 1000, 'other')], tracker, slot, 5000);
        slot.arm(ownRowKey('cid-2'));
        const theirs = msg('t1', 3000, 'other', 'cid-2');           // a foreign client_msg_id
        expect(render([msg('a', 1000, 'other'), theirs], tracker, slot, 5100)).toEqual([]);
    });

    it('an ordinary own send (slot not armed) gets the normal entrance only', () => {
        const tracker = createEntranceTracker();
        const slot = createImpactSlot();
        render([msg('a', 1000, 'other')], tracker, slot, 5000);
        expect(render([msg('a', 1000, 'other'), msg('cid-3', 3000, ME_DEV, 'cid-3')], tracker, slot, 5100)).toEqual([]);
    });
});
