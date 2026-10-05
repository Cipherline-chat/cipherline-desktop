import { describe, it, expect } from 'vitest';
import {
    classifySubmit,
    decideViewportAction,
    correctedScrollTop,
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

    it('new message while scrolled up → follow the bottom (deliberate, see module docstring)', () => {
        // NOT an oversight. ChatPane's "Snap to bottom on every new message
        // (any sender)" effect records this as an explicit product decision:
        // the symmetric counterpart to "sending snaps me to the bottom".
        // Pinned here so a future edit-scroll change cannot silently alter it.
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
});
