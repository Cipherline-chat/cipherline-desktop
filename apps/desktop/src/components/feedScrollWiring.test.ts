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

    it('keeps jump-to-message, pinned-jump and load-older history scrolling intact', () => {
        // These three deliberately move the viewport and must not have been
        // collateral damage. Each is identified by its own distinctive call.
        expect(src).toContain("feedEl.scrollTo({ top: Math.max(0, centredTop), behavior: 'smooth' })");
        expect(src).toMatch(/preservedScrollHeightRef\.current !== null[\s\S]{0,300}?el\.scrollTop \+= delta/);
    });
});
