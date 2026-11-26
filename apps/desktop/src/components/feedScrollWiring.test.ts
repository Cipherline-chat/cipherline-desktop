import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guard for the chat feed's edit-scroll fix.
 *
 * The decision itself is unit-tested in utils/feedScrollDecision.test.ts. What
 * that cannot catch is the failure mode this repo has hit before: a pure module
 * written, tested and never actually consulted by the component. ChatPane is a
 * ~6.9k-line component with no render harness, so — same approach as
 * e2eeActivationWiring.test.ts / callsChannelKeyWiring.test.ts — the property
 * "the submit handler no longer forces the feed to the bottom unconditionally"
 * is pinned by a text scan.
 *
 * The bug being pinned: `handleSendAll` serves both sends and edit submits. It
 * set `followBottomRef.current = true` on entry and ran
 * `revealNewMessage()` — which assigns `el.scrollTop = el.scrollHeight` — in its
 * `finally`, so submitting an edit to a message you had scrolled up to reach
 * threw you back to the bottom of the conversation.
 */

const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

/** The body of handleSendAll, which is where the bug lived. */
const sendHandler = (() => {
    const start = src.indexOf('const handleSendAll = async');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('const [pendingCallMode', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
})();

describe('ChatPane consults the feed-scroll decision module', () => {
    it('imports the real decision helpers (not a local re-implementation)', () => {
        expect(src).toMatch(
            /import \{[^}]*classifySubmit[^}]*decideViewportAction[^}]*correctedScrollTop[^}]*\} from '\.\.\/utils\/feedScrollDecision'/,
        );
    });

    it('classifies the submit from the live editing state and staged files', () => {
        expect(sendHandler).toMatch(
            /classifySubmit\(\{\s*editingId,\s*stagedFileCount:\s*stagedFiles\.length\s*\}\)/,
        );
        // The "at bottom" input must be the feed's own live measurement, not a
        // constant — otherwise the at-bottom / scrolled-up split is decorative.
        expect(sendHandler).toMatch(/wasAtBottom:\s*isAtBottomRef\.current/);
    });
});

describe('the submit handler no longer forces the bottom unconditionally', () => {
    it('re-engages follow-bottom only when the submit is NOT a preserved-viewport edit', () => {
        const follows = sendHandler.match(/followBottomRef\.current\s*=\s*true/g) ?? [];
        expect(follows.length).toBeGreaterThan(0);
        // Every single one must sit behind the keepViewport guard.
        expect(sendHandler).toMatch(/if \(!keepViewport\) followBottomRef\.current = true;/);
        const unguarded = sendHandler
            .split('\n')
            .filter(l => /followBottomRef\.current\s*=\s*true/.test(l))
            .filter(l => !/keepViewport/.test(l));
        // The `finally` block's assignment is guarded by an enclosing block, so
        // allow it only when that block is the keepViewport one (asserted next).
        expect(unguarded.length).toBeLessThanOrEqual(1);
    });

    it('does not run the scroll-to-bottom reveal on a preserved-viewport edit', () => {
        const reveal = sendHandler.indexOf('requestAnimationFrame(() => revealNewMessage())');
        expect(reveal).toBeGreaterThan(-1);
        // The nearest guard opening before the reveal must be the keepViewport one.
        const guard = sendHandler.lastIndexOf('if (!keepViewport) {', reveal);
        expect(guard).toBeGreaterThan(-1);
        // ...and it must not have closed before the reveal.
        const between = sendHandler.slice(guard, reveal);
        expect(between).not.toMatch(/\n {12}\}/);
    });

    it('captures the edited row as an anchor before the edit commits', () => {
        expect(sendHandler).toMatch(/if \(keepViewport && editingId\) captureEditAnchor\(editingId\)/);
        // The measurement has to happen BEFORE the dispatch that mutates the feed.
        const capture = sendHandler.indexOf('captureEditAnchor(editingId)');
        const dispatch = sendHandler.indexOf("dispatchAction({ type: 'edit'");
        expect(capture).toBeGreaterThan(-1);
        expect(dispatch).toBeGreaterThan(capture);
    });
});

describe('the anchor is restored without fighting the deliberate snaps', () => {
    it('corrects scrollTop through the tested helper, not ad-hoc arithmetic', () => {
        expect(src).toMatch(/correctedScrollTop\(\{[\s\S]{0,400}?rowTopBefore:\s*anchor\.rowTop/);
    });

    it('yields to follow-bottom, so a peer message landing in the same commit still wins', () => {
        const effect = src.slice(src.indexOf('const anchor = editAnchorRef.current;'));
        const guard = effect.indexOf('if (followBottomRef.current) return;');
        const correct = effect.indexOf('correctedScrollTop(');
        expect(guard).toBeGreaterThan(-1);
        expect(correct).toBeGreaterThan(guard);
    });

    it('is single-shot — the anchor is cleared before any early return', () => {
        const effect = src.slice(src.indexOf('const anchor = editAnchorRef.current;'));
        const clear = effect.indexOf('editAnchorRef.current = null;');
        const guard = effect.indexOf('if (followBottomRef.current) return;');
        expect(clear).toBeGreaterThan(-1);
        expect(clear).toBeLessThan(guard);
    });

    it('keeps jump-to-message, pinned-jump and load-older history scrolling intact (unchanged)', () => {
        // These three deliberately move the viewport and must not have been
        // collateral damage. Each is identified by its own distinctive call.
        // Jump-to-message centres through centreMessageRow (2026-11-16).
        expect(src).toContain("feedEl.scrollTo({ top: Math.max(0, feedEl.scrollTop + offCentre(msgEl)), behavior: 'smooth' })");
        expect(src).toMatch(/preservedScrollHeightRef\.current !== null[\s\S]{0,300}?el\.scrollTop \+= delta/);
    });
});

/**
 * Owner, 2026-11-26: "When someone joins or someone sends a message in a chat
 * you're scrolled up in, it jumps you down to the bottom." The cause was the
 * new-row layout effect ("Snap to bottom on every new message (any sender)"):
 * for every new last row it set `followBottomRef.current = true` and ran
 * `revealNewMessage()`, unconditionally. The decision is unit-tested in
 * utils/feedScrollDecision.test.ts; this pins that ChatPane consults it.
 */
describe('a scrolled-up reader is not dragged to the bottom by other people\'s content', () => {
    /** The new-row effect: from the reveal-gate check to the end of its body. */
    const newRowEffect = (() => {
        const start = src.indexOf('if (!revealGate.check(chatId, lastMsgKey)) return;');
        expect(start).toBeGreaterThan(-1);
        const end = src.indexOf('}, [messages, activeChat?.id]);', start);
        expect(end).toBeGreaterThan(start);
        return src.slice(start, end);
    })();

    it('the unconditional snap is gone', () => {
        expect(src).not.toContain('Snap to bottom on every new message (any sender)');
    });

    it('the new-row effect follows only through shouldFollow, with the pre-change follow state', () => {
        expect(newRowEffect).toMatch(/if \(shouldFollow\(\{ cause, wasFollowing: followBottomRef\.current \}\)\) \{/);
        // Every follow / reveal in the effect sits inside that guard, which returns.
        const guard = newRowEffect.indexOf('if (shouldFollow(');
        const guardEnd = newRowEffect.indexOf('return;', guard);
        for (const needle of ['followBottomRef.current       = true', 'revealNewMessage()']) {
            const at = newRowEffect.indexOf(needle);
            expect(at).toBeGreaterThan(guard);
            expect(at).toBeLessThan(guardEnd);
            expect(newRowEffect.indexOf(needle, guardEnd)).toBe(-1);
        }
    });

    it('an own send from THIS device is the only cause that overrides scrolling up', () => {
        expect(newRowEffect).toMatch(/sender_device_id === deviceId/);
        expect(newRowEffect).toMatch(/ownSend \? 'own-send'/);
    });

    it('arrivals are diffed with appendedRows and counted with countsAsUnseen', () => {
        expect(newRowEffect).toMatch(/appendedRows<any>\(messages, prevMark,/);
        expect(newRowEffect).toMatch(/countsAsUnseen\(m, rowIsMine\(m\)\)/);
    });

    it('the composer\'s own send still re-engages follow-bottom on entry', () => {
        expect(sendHandler).toMatch(/if \(!keepViewport\) followBottomRef\.current = true;/);
    });
});

describe('the reading anchor holds the row being read while scrolled up', () => {
    it('re-runs after EVERY commit (a layout effect with no dependency list)', () => {
        expect(src).toContain('useLayoutEffect(() => { holdReadAnchor(); });');
    });

    it('and on content resizes outside a commit (images decoding) via a ResizeObserver', () => {
        expect(src).toMatch(/new ResizeObserver\(\(\) => holdReadAnchor\(\)\)/);
    });

    it('corrects through the tested helper and yields to follow-bottom, jumps and the FLIP slide', () => {
        const body = src.slice(src.indexOf('const holdReadAnchor = () => {'));
        const correct = body.indexOf('correctedScrollTop(');
        expect(body.indexOf('if (followBottomRef.current || pendingScrollMsgIdRef.current) return;')).toBeLessThan(correct);
        expect(body.indexOf('flipCleanupRef.current) return;')).toBeLessThan(correct);
    });

    it('declared after the gap-fill and edit-anchor corrections, so it runs last', () => {
        const hold = src.indexOf('useLayoutEffect(() => { holdReadAnchor(); });');
        expect(hold).toBeGreaterThan(src.indexOf('const anchor = editAnchorRef.current;'));
        expect(hold).toBeGreaterThan(src.indexOf('const anchor = fillAnchorRef.current;'));
    });

    it('the default window is frozen when the reader scrolls away (no row slides off its top)', () => {
        expect(src).toMatch(/if \(wasFollowing && !followBottomRef\.current\) \{[\s\S]{0,300}?pagination\.freeze\(\);/);
    });

    it('Chromium scroll anchoring stays off (the FLIP reveal needs it off; the anchor replaces it)', () => {
        expect(src).toContain("style={{ overflowAnchor: 'none' }}");
    });
});

describe('ONE top indicator, inside the feed wrapper', () => {
    it('renders NewMessagesBar with the count label and both jumps', () => {
        expect(src).toMatch(/<NewMessagesBar\s+newLabel=\{newMessagesText\}\s+farFromBottom=\{showScrollBtn\}\s+onJumpToNew=\{jumpToFirstUnseen\}\s+onJumpToPresent=\{jumpToPresent\}/);
    });

    it('the old top-centre "Jump to latest" pill is gone (no second competing indicator)', () => {
        expect(src).not.toMatch(/tooltip="Jump to latest"/);
        expect((src.match(/<NewMessagesBar/g) ?? []).length).toBe(1);
    });

    it('sits inside the feed wrapper, after the feed, so it cannot cover the header or banners', () => {
        const wrapper = src.indexOf('<div className="relative flex-1 min-h-0 flex flex-col min-w-0">');
        const bar = src.indexOf('<NewMessagesBar');
        const menu = src.indexOf('{msgContextMenu.menu}');
        expect(wrapper).toBeGreaterThan(-1);
        expect(bar).toBeGreaterThan(wrapper);
        expect(bar).toBeLessThan(menu);
    });
});
