import { describe, it, expect, beforeEach } from 'vitest';
import {
    HOME_CALLS_COLLAPSED_LIMIT, HOME_CALLS_TWO_COL_MIN_WIDTH, applyCallOrder, callColumns, compareCalls, foldCalls, friendsInCall,
    getHomeCallsExpanded, membershipSignature, needsFold, nextCallOrder, resetHomeCallsExpandedForTests,
    setHomeCallsExpanded, soloStack, sortCalls, stackParticipants, stackSlotWidth, stackWidth, type RankableCall,
} from './homeCallsList';

const call = (key: string, participantIds: string[], o: Partial<RankableCall> = {}): RankableCall =>
    ({ key, participantIds, name: key, startedAt: null, ...o });
const keys = (cs: readonly { key: string }[]) => cs.map(c => c.key);
const NO_FRIENDS = new Set<string>();

describe('compareCalls / sortCalls — relevance order', () => {
    it('your own call first, whatever else is true', () => {
        const cs = [call('big', ['a', 'b', 'c', 'd']), call('mine', ['me']), call('friendly', ['f1', 'f2'])];
        const out = sortCalls(cs, { mineKey: 'mine', friendIds: new Set(['f1', 'f2']) });
        expect(keys(out)[0]).toBe('mine');
    });

    it('then by number of friends in the call, beating raw size', () => {
        const cs = [call('big', ['a', 'b', 'c', 'd', 'e']), call('one', ['f1', 'x']), call('two', ['f1', 'f2'])];
        // f1 can't be in two calls really, but the comparator only counts.
        const out = sortCalls(cs, { mineKey: null, friendIds: new Set(['f1', 'f2']) });
        expect(keys(out)).toEqual(['two', 'one', 'big']);
    });

    it('then by participant count', () => {
        const cs = [call('s', ['a']), call('l', ['a', 'b', 'c']), call('m', ['a', 'b'])];
        expect(keys(sortCalls(cs, { mineKey: null, friendIds: NO_FRIENDS }))).toEqual(['l', 'm', 's']);
    });

    it('then most recently started, a known start beating an unknown one', () => {
        const cs = [
            call('voice', ['a']), // no start time (always-on voice channel)
            call('old', ['a'], { startedAt: 1_000 }),
            call('new', ['a'], { startedAt: 5_000 }),
        ];
        expect(keys(sortCalls(cs, { mineKey: null, friendIds: NO_FRIENDS }))).toEqual(['new', 'old', 'voice']);
    });

    it('is total and deterministic: name, then key, break the last ties', () => {
        const cs = [call('k2', ['a'], { name: 'Same' }), call('k1', ['a'], { name: 'Same' }), call('k0', ['a'], { name: 'Alpha' })];
        const ctx = { mineKey: null, friendIds: NO_FRIENDS };
        expect(keys(sortCalls(cs, ctx))).toEqual(['k0', 'k1', 'k2']);
        expect(keys(sortCalls([...cs].reverse(), ctx))).toEqual(['k0', 'k1', 'k2']);
        expect(compareCalls(cs[0], cs[0], ctx)).toBe(0);
    });

    it('does not mutate its input', () => {
        const cs = [call('a', ['x']), call('b', ['x', 'y'])];
        sortCalls(cs, { mineKey: null, friendIds: NO_FRIENDS });
        expect(keys(cs)).toEqual(['a', 'b']);
    });

    it('friendsInCall counts only friends', () => {
        expect(friendsInCall(call('c', ['f1', 'x', 'f2']), new Set(['f1', 'f2', 'f3']))).toBe(2);
    });
});

describe('nextCallOrder — stable between membership changes', () => {
    const ctx = { mineKey: null, friendIds: NO_FRIENDS };

    it('presence churn inside existing calls does NOT reorder (same identity back)', () => {
        const first = nextCallOrder(null, [call('a', ['1', '2', '3']), call('b', ['1'])], ctx);
        expect(first.keys).toEqual(['a', 'b']);
        // b grows past a — but no call came or went.
        const again = nextCallOrder(first, [call('a', ['1']), call('b', ['1', '2', '3', '4'])], ctx);
        expect(again).toBe(first);
        expect(again.keys).toEqual(['a', 'b']);
    });

    it('a call starting re-ranks the whole list', () => {
        const first = nextCallOrder(null, [call('a', ['1', '2', '3']), call('b', ['1'])], ctx);
        const next = nextCallOrder(first, [call('a', ['1']), call('b', ['1', '2', '3', '4']), call('c', ['1', '2'])], ctx);
        expect(next).not.toBe(first);
        expect(next.keys).toEqual(['b', 'c', 'a']);
    });

    it('a call ending re-ranks', () => {
        const first = nextCallOrder(null, [call('a', ['1', '2']), call('b', ['1']), call('c', ['1'])], ctx);
        const next = nextCallOrder(first, [call('b', ['1']), call('c', ['1', '2', '3'])], ctx);
        expect(next.keys).toEqual(['c', 'b']);
    });

    it('joining a call (your call changes) re-ranks so yours jumps to the top', () => {
        const cs = [call('a', ['1', '2', '3']), call('b', ['1'])];
        const first = nextCallOrder(null, cs, ctx);
        const next = nextCallOrder(first, cs, { mineKey: 'b', friendIds: NO_FRIENDS });
        expect(next.keys).toEqual(['b', 'a']);
    });

    it('the signature ignores input order', () => {
        expect(membershipSignature([call('a', []), call('b', [])], null))
            .toBe(membershipSignature([call('b', []), call('a', [])], null));
        expect(membershipSignature([call('a', [])], 'a')).not.toBe(membershipSignature([call('a', [])], null));
    });
});

describe('applyCallOrder', () => {
    it('lays the CURRENT objects (live counts) out in the kept order', () => {
        const order = { sig: 'x', keys: ['b', 'a'] };
        const live = [call('a', ['1', '2']), call('b', ['1', '2', '3'])];
        const out = applyCallOrder(live, order);
        expect(keys(out)).toEqual(['b', 'a']);
        expect(out[0]).toBe(live[1]);
    });

    it('never drops a row: unknown keys are appended, stale keys skipped', () => {
        const out = applyCallOrder([call('a', []), call('new', [])], { sig: 'x', keys: ['gone', 'a'] });
        expect(keys(out)).toEqual(['a', 'new']);
    });
});

describe('foldCalls / needsFold', () => {
    const list = ['1', '2', '3', '4', '5', '6', '7', '8'];

    it('collapsed: at most `limit` rows, the rest counted as hidden', () => {
        expect(foldCalls(list, false, HOME_CALLS_COLLAPSED_LIMIT)).toEqual({ shown: ['1', '2', '3'], hidden: 5 });
    });

    it('expanded: everything, nothing hidden', () => {
        expect(foldCalls(list, true, 3)).toEqual({ shown: list, hidden: 0 });
    });

    it('boundary: exactly `limit` rows needs no fold; limit+1 folds one', () => {
        expect(foldCalls(list.slice(0, 3), false, 3)).toEqual({ shown: ['1', '2', '3'], hidden: 0 });
        expect(needsFold(3, 3)).toBe(false);
        expect(foldCalls(list.slice(0, 4), false, 3)).toEqual({ shown: ['1', '2', '3'], hidden: 1 });
        expect(needsFold(4, 3)).toBe(true);
        expect(foldCalls([], false, 3)).toEqual({ shown: [], hidden: 0 });
    });
});

describe('callColumns', () => {
    it('two across only when wide AND more calls than one folded column shows', () => {
        expect(callColumns(HOME_CALLS_TWO_COL_MIN_WIDTH, 4)).toBe(2);
        expect(callColumns(HOME_CALLS_TWO_COL_MIN_WIDTH, 3)).toBe(1); // no stranded Join / half-empty line
        expect(callColumns(HOME_CALLS_TWO_COL_MIN_WIDTH, 1)).toBe(1);
        expect(callColumns(HOME_CALLS_TWO_COL_MIN_WIDTH - 1, 8)).toBe(1);
        expect(callColumns(0, 8)).toBe(1);
    });
});

describe('stackParticipants', () => {
    it('friends first, roster order within each group, capped', () => {
        expect(stackParticipants(['x', 'f2', 'y', 'f1', 'z'], new Set(['f1', 'f2']))).toEqual(['f2', 'f1', 'x']);
        expect(stackParticipants(['x'], NO_FRIENDS)).toEqual(['x']);
    });
});

describe('stackWidth / stackSlotWidth — avatar slot sized to what is drawn', () => {
    it('20px discs overlapping by 6px', () => {
        expect(stackWidth(0)).toBe(0);
        expect(stackWidth(1)).toBe(20);
        expect(stackWidth(2)).toBe(34);
        expect(stackWidth(3)).toBe(48);
    });
    it('the slot is the widest SHOWN stack, never a fixed three-avatar width', () => {
        expect(stackSlotWidth([1])).toBe(20);
        expect(stackSlotWidth([1, 1, 1])).toBe(20);
        expect(stackSlotWidth([2, 1])).toBe(34);
        expect(stackSlotWidth([1, 3, 2])).toBe(48);
        expect(stackSlotWidth([])).toBe(0);
    });
});

describe('soloStack — the single-call layout bigger stack', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
    it('everyone when they fit in 4 discs, no chip', () => {
        expect(soloStack(ids(1), NO_FRIENDS)).toEqual({ ids: ['u0'], extra: 0 });
        expect(soloStack(ids(4), NO_FRIENDS)).toEqual({ ids: ids(4), extra: 0 });
    });
    it('past 4: three avatars and "+N" for the rest (never wider than 4 discs)', () => {
        expect(soloStack(ids(5), NO_FRIENDS)).toEqual({ ids: ['u0', 'u1', 'u2'], extra: 2 });
        expect(soloStack(ids(12), NO_FRIENDS)).toEqual({ ids: ['u0', 'u1', 'u2'], extra: 9 });
    });
    it('friends first', () => {
        expect(soloStack(ids(6), new Set(['u5'])).ids[0]).toBe('u5');
    });
    it('empty roster: nothing drawn', () => {
        expect(soloStack([], NO_FRIENDS)).toEqual({ ids: [], extra: 0 });
    });
});

describe('session-only expanded memory', () => {
    beforeEach(() => resetHomeCallsExpandedForTests());
    it('defaults to collapsed and remembers a toggle', () => {
        expect(getHomeCallsExpanded()).toBe(false);
        setHomeCallsExpanded(true);
        expect(getHomeCallsExpanded()).toBe(true);
    });
});
