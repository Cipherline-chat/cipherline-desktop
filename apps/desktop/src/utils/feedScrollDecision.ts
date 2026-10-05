/**
 * Pure viewport-movement policy for the chat feed.
 *
 * ChatPane's composer runs ONE submit handler (`handleSendAll`) for two very
 * different things: sending new content, and submitting an edit to a message
 * that already exists. That handler used to force the feed to the bottom
 * unconditionally — `followBottomRef.current = true` on entry and a
 * `revealNewMessage()` (which assigns `el.scrollTop = el.scrollHeight`) in its
 * `finally`. Correct for a send; wrong for an edit, because the user had to
 * scroll UP to reach the message they were editing and got thrown back to the
 * bottom the moment they submitted.
 *
 * The decision is extracted here so it is testable without a ChatPane render
 * harness. ChatPane consults these functions; `feedScrollWiring.test.ts` pins
 * that it still does.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *   new content        → follow to the bottom
 *   in-place edit      → do not move the viewport, unless the user was already
 *                        at the bottom (in which case staying pinned to the
 *                        bottom IS "where they were")
 *
 * ── Deliberate non-rule: a peer's new message while scrolled up ───────────
 * A new message snaps the feed down whether or not the user has scrolled away.
 * That reads like a bug and is not: it is an explicit product decision
 * recorded at ChatPane's "Snap to bottom on every new message (any sender)"
 * effect — the symmetric counterpart to "sending snaps me to the bottom".
 * `decideViewportAction` encodes the behaviour that actually ships, so do not
 * "fix" `new-message` + `wasAtBottom: false` to `preserve-anchor` here without
 * changing that decision deliberately, with the owner.
 */

/** What a change to the message list actually is, from the viewport's point of view. */
export type FeedChangeKind =
    /** content the feed did not have before — a send, an upload, a peer's message */
    | 'new-message'
    /** an existing row's content changed; the list's shape and order did not */
    | 'in-place-edit';

export type ViewportAction =
    /** pin to the bottom of the feed */
    | 'follow-bottom'
    /** leave the user where they are, correcting for any height change */
    | 'preserve-anchor';

export interface SubmitShape {
    /** id of the message being edited, or `null` for an ordinary send */
    editingId: string | null;
    /** number of files staged in the composer alongside the text */
    stagedFileCount: number;
}

/**
 * Classify a composer submit.
 *
 * An edit submit that ALSO carries staged files is not an in-place edit: the
 * uploads append genuinely new messages to the end of the feed, and the user
 * expects to see them. Only a bare text edit leaves the list's shape untouched.
 */
export function classifySubmit({ editingId, stagedFileCount }: SubmitShape): FeedChangeKind {
    return editingId !== null && editingId !== '' && stagedFileCount === 0
        ? 'in-place-edit'
        : 'new-message';
}

export interface ViewportInput {
    kind: FeedChangeKind;
    /** was the viewer within the feed's follow-bottom threshold when the change committed? */
    wasAtBottom: boolean;
}

/** Should this change move the viewport, and where to? */
export function decideViewportAction({ kind, wasAtBottom }: ViewportInput): ViewportAction {
    // New content always wins the viewport — see the "deliberate non-rule" note above.
    if (kind === 'new-message') return 'follow-bottom';
    // An in-place edit never drags a scrolled-up reader anywhere. If they were
    // already at the bottom, staying pinned there is what "don't move" means —
    // otherwise an edit that grows the last message would push it out of view.
    return wasAtBottom ? 'follow-bottom' : 'preserve-anchor';
}

export interface AnchorCorrection {
    /** the container's scrollTop right now */
    scrollTop: number;
    /** the largest legal scrollTop after the change (scrollHeight - clientHeight) */
    maxScrollTop: number;
    /** anchored row's top edge relative to the container's top edge, BEFORE the change */
    rowTopBefore: number;
    /** the same measurement AFTER the change committed and layout settled */
    rowTopAfter: number;
}

/**
 * Where scrollTop must land so the anchored row sits exactly where it did.
 *
 * Preserving raw `scrollTop` is not enough: an edit can make a message taller
 * or shorter (more text, an embed appearing), and the composer's "Editing
 * Message" strip unmounting changes the feed's bottom spacer — either of which
 * shifts every row. Re-measuring the edited row and correcting by its drift
 * holds THAT row still regardless of what changed around it.
 *
 * Clamped, because a shrinking edit can drop `maxScrollTop` below the
 * corrected value and the browser would silently clamp anyway — doing it here
 * keeps the caller's bookkeeping refs honest about where the feed really is.
 */
export function correctedScrollTop({
    scrollTop,
    maxScrollTop,
    rowTopBefore,
    rowTopAfter,
}: AnchorCorrection): number {
    const drift = rowTopAfter - rowTopBefore;
    return Math.min(Math.max(scrollTop + drift, 0), Math.max(maxScrollTop, 0));
}
