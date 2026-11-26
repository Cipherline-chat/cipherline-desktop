import { describe, it, expect } from 'vitest';
import {
    classifySubmit,
    decideViewportAction,
    correctedScrollTop,
    shouldFollow,
    followAfterScroll,
    countsAsUnseen,
    appendedRows,
    newMessagesLabel,
    FOLLOW_ENGAGE_PX,
    FOLLOW_RELEASE_PX,
    type FeedChangeCause,
} from './feedScrollDecision';

/**
 * The reported bug: "When you edit a message that you have to scroll up for,
 * when you submit the edit it takes you down to the bottom again."
 *
 * ChatPane runs ONE submit handler for sends and edits, and it forced the feed
 * to the bottom on both. These tests pin the decision that separates them.
 */

describe('classifySubmit — is this submit new content or an edit in place?', () => {
    it('a plain text send is new content', () => {
        expect(classifySubmit({ editingId: null, stagedFileCount: 0 })).toBe('new-message');
    });

    it('a send with staged files is new content', () => {
        expect(classifySubmit({ editingId: null, stagedFileCount: 3 })).toBe('new-message');
    });

    it('submitting an edit with no attachments is an in-place edit — THE BUG', () => {
        expect(classifySubmit({ editingId: 'msg-42', stagedFileCount: 0 })).toBe('in-place-edit');
    });

    it('an edit submitted alongside staged files is new content, not an in-place edit', () => {
        // The uploads append real messages to the end of the feed; the user
        // expects to see them, so this submit keeps the follow-to-bottom.
        expect(classifySubmit({ editingId: 'msg-42', stagedFileCount: 1 })).toBe('new-message');
    });

    it('treats an empty-string editingId as "not editing" (falsy id, never a real message)', () => {
        expect(classifySubmit({ editingId: '', stagedFileCount: 0 })).toBe('new-message');
    });
});

describe('decideViewportAction — should this change move the viewport?', () => {
    it('own message sent while at the bottom → follow the bottom', () => {
        expect(decideViewportAction({ kind: 'new-message', wasAtBottom: true }))
            .toBe('follow-bottom');
    });

    it('own message sent while scrolled up → follow the bottom (a submit is always the reader\'s own send)', () => {
        // A composer submit of new content is an own send, which still takes
        // the reader to the bottom (owner, 2026-11-26: only OTHER people's
        // content stopped dragging a scrolled-up reader down).
        expect(decideViewportAction({ kind: 'new-message', wasAtBottom: false }))
            .toBe('follow-bottom');
    });

    it('in-place edit while scrolled up → stay put — THE FIX', () => {
        expect(decideViewportAction({ kind: 'in-place-edit', wasAtBottom: false }))
            .toBe('preserve-anchor');
    });

    it('in-place edit while at the bottom → stay pinned to the bottom', () => {
        // "Where they were" IS the bottom. Freezing scrollTop instead would
        // push the edited last message out of view the moment it grows.
        expect(decideViewportAction({ kind: 'in-place-edit', wasAtBottom: true }))
            .toBe('follow-bottom');
    });

    it('never yanks a scrolled-up reader for an edit, whatever else is true', () => {
        expect(decideViewportAction({ kind: 'in-place-edit', wasAtBottom: false }))
            .not.toBe('follow-bottom');
    });
});

describe('correctedScrollTop — holding the edited row still when its height changes', () => {
    it('no height change → scrollTop is untouched', () => {
        expect(correctedScrollTop({
            scrollTop: 800, maxScrollTop: 4000, rowTopBefore: 120, rowTopAfter: 120,
        })).toBe(800);
    });

    it('edit grows a message ABOVE the anchor → anchor drifts down, scroll down to compensate', () => {
        // Nothing above changed height here; the anchored row itself grew
        // downward, so its top is unmoved — the case below covers real drift.
        expect(correctedScrollTop({
            scrollTop: 800, maxScrollTop: 4000, rowTopBefore: 120, rowTopAfter: 168,
        })).toBe(848);
    });

    it('edit shrinks content above the anchor → anchor drifts up, scroll up to compensate', () => {
        expect(correctedScrollTop({
            scrollTop: 800, maxScrollTop: 4000, rowTopBefore: 120, rowTopAfter: 78,
        })).toBe(758);
    });

    it('clamps at the bottom when a shrinking edit drops the scrollable range', () => {
        // A big deletion can leave the corrected value past the new end of the
        // feed; the browser would clamp silently, so clamp here and keep the
        // caller's bookkeeping refs honest about where the feed really is.
        expect(correctedScrollTop({
            scrollTop: 3900, maxScrollTop: 3000, rowTopBefore: 100, rowTopAfter: 400,
        })).toBe(3000);
    });

    it('clamps at zero rather than producing a negative scrollTop', () => {
        expect(correctedScrollTop({
            scrollTop: 20, maxScrollTop: 4000, rowTopBefore: 300, rowTopAfter: 0,
        })).toBe(0);
    });

    it('handles a feed too short to scroll (maxScrollTop would be negative)', () => {
        expect(correctedScrollTop({
            scrollTop: 0, maxScrollTop: -40, rowTopBefore: 10, rowTopAfter: 50,
        })).toBe(0);
    });

    it('content growing BELOW the anchored row never moves the viewport', () => {
        // A new message, a typing strip, an edit or an image below the row the
        // reader is looking at leaves that row's top where it was: zero drift.
        expect(correctedScrollTop({
            scrollTop: 1200, maxScrollTop: 5000, rowTopBefore: 140, rowTopAfter: 140,
        })).toBe(1200);
    });

    it('an image decoding ABOVE the viewport (+176 px) is compensated exactly', () => {
        expect(correctedScrollTop({
            scrollTop: 313, maxScrollTop: 1000, rowTopBefore: 32, rowTopAfter: 208,
        })).toBe(489);
    });

    it('a page of history loading above (+1800 px) is compensated exactly', () => {
        expect(correctedScrollTop({
            scrollTop: 40, maxScrollTop: 6000, rowTopBefore: 60, rowTopAfter: 1860,
        })).toBe(1840);
    });
});

/**
 * The owner's report (2026-11-26): "When someone joins or someone sends a
 * message in a chat you're scrolled up in, it jumps you down to the bottom."
 * ChatPane's new-row effect called the scroll-to-bottom reveal for EVERY new
 * last row. `shouldFollow` is the rule that replaced it.
 */
describe('shouldFollow — does this change pin the feed to the bottom?', () => {
    const scrolledUp = (cause: FeedChangeCause) => shouldFollow({ cause, wasFollowing: false });
    const atBottom = (cause: FeedChangeCause) => shouldFollow({ cause, wasFollowing: true });

    it('own send while scrolled up → follows (you expect to see what you sent)', () => {
        expect(scrolledUp('own-send')).toBe(true);
    });

    it('incoming message while scrolled up → stays put — THE BUG', () => {
        expect(scrolledUp('incoming-message')).toBe(false);
    });

    it('system row ("X joined") while scrolled up → stays put — THE BUG', () => {
        expect(scrolledUp('system-row')).toBe(false);
    });

    it('image / embed loading while scrolled up → stays put (anchor-corrected)', () => {
        expect(scrolledUp('media-resize')).toBe(false);
    });

    it('history loading above while scrolled up → stays put (anchor-corrected)', () => {
        expect(scrolledUp('history-load')).toBe(false);
    });

    it('edit or reaction while scrolled up → stays put', () => {
        expect(scrolledUp('edit-or-reaction')).toBe(false);
    });

    it('typing indicator while scrolled up → stays put', () => {
        expect(scrolledUp('typing')).toBe(false);
    });

    it('at the bottom, EVERY cause keeps following (auto-follow is unchanged)', () => {
        const causes: FeedChangeCause[] = ['own-send', 'incoming-message', 'system-row', 'media-resize', 'history-load', 'edit-or-reaction', 'typing'];
        for (const c of causes) expect(atBottom(c)).toBe(true);
    });

    it('only an own send overrides a scrolled-up reader', () => {
        const causes: FeedChangeCause[] = ['own-send', 'incoming-message', 'system-row', 'media-resize', 'history-load', 'edit-or-reaction', 'typing'];
        expect(causes.filter(scrolledUp)).toEqual(['own-send']);
    });
});

describe('followAfterScroll — "at the bottom" with hysteresis', () => {
    it('exactly at the bottom → following', () => {
        expect(followAfterScroll(false, 0)).toBe(true);
    });

    it('just inside the engage threshold → following', () => {
        expect(followAfterScroll(false, FOLLOW_ENGAGE_PX - 1)).toBe(true);
    });

    it('at the engage threshold → keeps the previous state', () => {
        expect(followAfterScroll(false, FOLLOW_ENGAGE_PX)).toBe(false);
        expect(followAfterScroll(true, FOLLOW_ENGAGE_PX)).toBe(true);
    });

    it('between the thresholds → keeps the previous state (no flicker)', () => {
        expect(followAfterScroll(true, 90)).toBe(true);
        expect(followAfterScroll(false, 90)).toBe(false);
    });

    it('at the release threshold → still keeps the previous state', () => {
        expect(followAfterScroll(true, FOLLOW_RELEASE_PX)).toBe(true);
    });

    it('just past the release threshold → scrolled up', () => {
        expect(followAfterScroll(true, FOLLOW_RELEASE_PX + 1)).toBe(false);
    });
});

describe('countsAsUnseen — what the top bar counts', () => {
    const row = (type: string) => ({ id: 'x', content: { type } });

    it('counts other people\'s messages of every postable kind', () => {
        for (const t of ['text', 'attachment', 'klipy_gif', 'server_invite', 'pro_gift']) {
            expect(countsAsUnseen(row(t), false)).toBe(true);
        }
    });

    it('counts member rows ("X joined") and undecryptable placeholders (type system)', () => {
        expect(countsAsUnseen({ id: 's', content: { type: 'system', kind: 'member_event' } as { type: string } }, false)).toBe(true);
    });

    it('never counts the reader\'s own rows', () => {
        expect(countsAsUnseen(row('text'), true)).toBe(false);
        expect(countsAsUnseen(row('system'), true)).toBe(false);
    });

    it('does not count call rows or safety-number notices', () => {
        expect(countsAsUnseen(row('call_key'), false)).toBe(false);
        expect(countsAsUnseen(row('safety_number'), false)).toBe(false);
    });

    it('does not count control types (reactions, edits, deletes, pins)', () => {
        for (const t of ['reaction', 'edit', 'delete', 'pin', 'call_key_request']) {
            expect(countsAsUnseen(row(t), false)).toBe(false);
        }
    });

    it('a row with no content does not count', () => {
        expect(countsAsUnseen({ id: 'x' }, false)).toBe(false);
        expect(countsAsUnseen({ id: 'x', content: null }, false)).toBe(false);
    });
});

describe('appendedRows — new arrivals vs history inserted above', () => {
    const r = (id: string, ts: number) => ({ id, timestamp: ts });
    const key = (m: { id?: string }) => m.id ?? 'no-id';
    const base = [r('a', 1), r('b', 2), r('c', 3)];

    it('rows after the previous last row are new', () => {
        expect(appendedRows([...base, r('d', 4), r('e', 5)], { key: 'c', ts: 3 }, key).map(m => m.id)).toEqual(['d', 'e']);
    });

    it('history loaded ABOVE (previous last row still last) → nothing new', () => {
        expect(appendedRows([r('y', -2), r('z', -1), ...base], { key: 'c', ts: 3 }, key)).toEqual([]);
    });

    it('history above AND a new message in the same commit → only the new message', () => {
        expect(appendedRows([r('z', -1), ...base, r('d', 4)], { key: 'c', ts: 3 }, key).map(m => m.id)).toEqual(['d']);
    });

    it('previous last row deleted → falls back to "strictly newer than its time"', () => {
        expect(appendedRows([r('a', 1), r('b', 2), r('d', 4)], { key: 'c', ts: 3 }, key).map(m => m.id)).toEqual(['d']);
    });

    it('no previous row (first render of an empty chat) → nothing counts as new', () => {
        expect(appendedRows(base, null, key)).toEqual([]);
    });

    it('an unparseable previous time and a vanished row → nothing (never guesses)', () => {
        expect(appendedRows(base, { key: 'gone', ts: NaN }, key)).toEqual([]);
    });

    it('ISO-string timestamps work for the fallback too', () => {
        const rows = [{ id: 'a', timestamp: '2026-11-26T10:00:00Z' }, { id: 'd', timestamp: '2026-11-26T10:05:00Z' }];
        expect(appendedRows(rows, { key: 'gone', ts: Date.parse('2026-11-26T10:01:00Z') }, key).map(m => m.id)).toEqual(['d']);
    });
});

describe('newMessagesLabel — the bar\'s wording', () => {
    const clock = () => '3:42 PM';

    it('singular', () => {
        expect(newMessagesLabel(1, 0, clock)).toBe('1 new message since 3:42 PM');
    });

    it('plural', () => {
        expect(newMessagesLabel(3, 0, clock)).toBe('3 new messages since 3:42 PM');
    });

    it('99 is printed, 100 caps at 99+', () => {
        expect(newMessagesLabel(99, 0, clock)).toBe('99 new messages since 3:42 PM');
        expect(newMessagesLabel(100, 0, clock)).toBe('99+ new messages since 3:42 PM');
    });

    it('no usable time → no "since" clause', () => {
        expect(newMessagesLabel(2, null, clock)).toBe('2 new messages');
        expect(newMessagesLabel(2, NaN, clock)).toBe('2 new messages');
    });

    it('formats the FIRST unseen message\'s time through the given clock', () => {
        const seen: number[] = [];
        newMessagesLabel(2, 1234, ms => { seen.push(ms); return 'x'; });
        expect(seen).toEqual([1234]);
    });
});
