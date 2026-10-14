import { describe, it, expect, vi } from 'vitest';
import {
    unreadConversationIds, readEventFor, restoreCounts, markConversationsRead,
    MARK_READ_BURST, type MarkAllReadOptions,
} from './markAllRead';
import { clearCountsForIds, type CountMap } from './unreadBadges';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const kinds: Record<string, 'dm' | 'group'> = { d1: 'dm', d2: 'dm', d3: 'dm', g1: 'group', g2: 'group' };
const classify = (id: string) => kinds[id];

describe('unreadConversationIds', () => {
    const unread: CountMap = { d1: 2, d2: 0, g1: 5, g2: 1, orphan: 3 };
    const mentions: CountMap = { d3: 1, g1: 1 };

    it('scopes to the button: DMs get dm + unclassifiable orphans, groups get groups only', () => {
        expect(unreadConversationIds(unread, mentions, classify, 'dm').sort()).toEqual(['d1', 'd3', 'orphan']);
        expect(unreadConversationIds(unread, mentions, classify, 'group').sort()).toEqual(['g1', 'g2']);
    });
    it('skips zero counts and lists an id once even when it has unread AND mentions', () => {
        const ids = unreadConversationIds(unread, mentions, classify, 'group');
        expect(ids.filter(i => i === 'g1')).toHaveLength(1);
        expect(unreadConversationIds({ d1: 0 }, {}, classify, 'dm')).toEqual([]);
    });
    it('is empty when nothing is unread', () => {
        expect(unreadConversationIds({}, {}, classify, 'dm')).toEqual([]);
        expect(unreadConversationIds({}, {}, classify, 'group')).toEqual([]);
    });
});

describe('readEventFor (mirrors what opening a chat sends)', () => {
    const msgs = [{ id: U(1), content: { type: 'text' } }, { id: U(2), content: { type: 'text' } }, { id: 'system-1', content: { type: 'system' } }];
    it('names the newest REAL message, with a visible receipt when receipts are on', () => {
        expect(readEventFor({ messages: msgs, isSelfChat: false, showReadReceipts: true })).toEqual({ id: U(2), selfOnly: false });
    });
    it('is self-only when receipts are off', () => {
        expect(readEventFor({ messages: msgs, isSelfChat: false, showReadReceipts: false })).toEqual({ id: U(2), selfOnly: true });
    });
    it('is always self-only for a self chat', () => {
        expect(readEventFor({ messages: msgs, isSelfChat: true, showReadReceipts: true })).toEqual({ id: U(2), selfOnly: true });
    });
    it('is null when there is no real message to name', () => {
        expect(readEventFor({ messages: [], isSelfChat: false, showReadReceipts: true })).toBeNull();
        expect(readEventFor({ messages: undefined, isSelfChat: false, showReadReceipts: true })).toBeNull();
        expect(readEventFor({ messages: [{ id: 'system-1', content: { type: 'system' } }], isSelfChat: false, showReadReceipts: true })).toBeNull();
    });
});

describe('restoreCounts', () => {
    it('adds the snapshot back on top of what arrived meanwhile, only for the named ids', () => {
        expect(restoreCounts({ a: 1 }, { a: 4, b: 2, c: 9 }, ['a', 'b'])).toEqual({ a: 5, b: 2 });
    });
    it('returns the same object when nothing needed restoring', () => {
        const cur = { a: 1 };
        expect(restoreCounts(cur, { a: 0 }, ['a', 'zzz'])).toBe(cur);
    });
});

describe('markConversationsRead', () => {
    const instant = () => Promise.resolve();
    function harness(over: Partial<MarkAllReadOptions> = {}, start?: { unread: CountMap; mentions: CountMap }) {
        const state = { unread: { ...(start?.unread ?? { d1: 2, d3: 1, g1: 5, g2: 1 }) }, mentions: { ...(start?.mentions ?? { d3: 1, g1: 1 }) } };
        const snapshot = { unread: { ...state.unread }, mentions: { ...state.mentions } };
        const markRead = vi.fn<(id: string) => boolean>(() => true);
        const onFailure = vi.fn();
        const opts: MarkAllReadOptions = {
            ids: unreadConversationIds(state.unread, state.mentions, classify, 'group'),
            unread: snapshot.unread, mentions: snapshot.mentions,
            clearLocal: ids => { state.unread = clearCountsForIds(state.unread, ids); state.mentions = clearCountsForIds(state.mentions, ids); },
            restoreLocal: (prior, ids) => { state.unread = restoreCounts(state.unread, prior.unread, ids); state.mentions = restoreCounts(state.mentions, prior.mentions, ids); },
            markRead, onFailure, sleep: instant,
            ...over,
        };
        return { state, opts, markRead, onFailure };
    }

    it('clears only the in-scope conversations and runs the per-conversation mark-read for each', async () => {
        const h = harness();
        const out = await markConversationsRead(h.opts);
        expect(h.markRead.mock.calls.map(c => c[0]).sort()).toEqual(['g1', 'g2']);
        expect(out).toEqual({ sent: expect.arrayContaining(['g1', 'g2']), failed: [] });
        // groups cleared (unread AND mentions); DMs untouched
        expect(h.state.unread).toEqual({ d1: 2, d3: 1 });
        expect(h.state.mentions).toEqual({ d3: 1 });
        expect(h.onFailure).not.toHaveBeenCalled();
    });

    it('does nothing at all for an empty scope', async () => {
        const clearLocal = vi.fn();
        const h = harness({ ids: [], clearLocal });
        await markConversationsRead(h.opts);
        expect(clearLocal).not.toHaveBeenCalled();
        expect(h.markRead).not.toHaveBeenCalled();
    });

    it('clears optimistically BEFORE the first send', async () => {
        const order: string[] = [];
        const h = harness({
            clearLocal: () => { order.push('clear'); },
            markRead: () => { order.push('send'); return true; },
        });
        await markConversationsRead(h.opts);
        expect(order[0]).toBe('clear');
        expect(order.filter(o => o === 'send')).toHaveLength(2);
    });

    it('rolls back only the conversations that failed, keeps messages that arrived meanwhile, and reports once', async () => {
        const h = harness();
        h.markRead.mockImplementation((id: string) => id !== 'g1');
        // a new message lands in g1 while the request is in flight
        const origClear = h.opts.clearLocal;
        h.opts.clearLocal = ids => { origClear(ids); h.state.unread = { ...h.state.unread, g1: 2 }; };
        const out = await markConversationsRead(h.opts);
        expect(out.failed).toEqual(['g1']);
        expect(h.state.unread.g1).toBe(5 + 2);     // restored on top of the new arrivals
        expect(h.state.mentions.g1).toBe(1);
        expect(h.state.unread.g2).toBeUndefined(); // sent fine: stays cleared
        expect(h.onFailure).toHaveBeenCalledTimes(1);
        expect(h.onFailure).toHaveBeenCalledWith(['g1']);
    });

    it('treats a throwing sender as a failure and rolls back everything', async () => {
        const h = harness();
        h.markRead.mockImplementation(() => { throw new Error('socket closed'); });
        const out = await markConversationsRead(h.opts);
        expect(out.failed.sort()).toEqual(['g1', 'g2']);
        expect(h.state.unread).toEqual({ d1: 2, d3: 1, g1: 5, g2: 1 });
        expect(h.state.mentions).toEqual({ d3: 1, g1: 1 });
        expect(h.onFailure).toHaveBeenCalledWith(expect.arrayContaining(['g1', 'g2']));
    });

    it('sends the first burst synchronously (a dead socket rolls back inside one tick) and paces the rest', async () => {
        const n = MARK_READ_BURST + 3;
        const ids = Array.from({ length: n }, (_, i) => `c${i}`);
        const unread: CountMap = Object.fromEntries(ids.map(i => [i, 1]));
        const sleeps: number[] = [];
        const h = harness({ ids, unread, mentions: {}, paceMs: 125, sleep: async ms => { sleeps.push(ms); } }, { unread, mentions: {} });
        const p = markConversationsRead(h.opts);
        // before any await resolves, the burst has already gone out
        expect(h.markRead).toHaveBeenCalledTimes(MARK_READ_BURST);
        await p;
        expect(h.markRead).toHaveBeenCalledTimes(n);
        expect(sleeps).toEqual([125, 125, 125]);
    });

    it('de-duplicates ids', async () => {
        const h = harness({ ids: ['g1', 'g1', 'g2'] });
        await markConversationsRead(h.opts);
        expect(h.markRead).toHaveBeenCalledTimes(2);
    });
});
