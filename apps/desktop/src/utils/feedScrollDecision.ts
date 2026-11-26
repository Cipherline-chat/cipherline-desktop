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
 * ── Content that arrives while the reader is scrolled up (2026-11-26) ─────
 * This used to be a deliberate non-rule: ChatPane's "snap to bottom on every
 * new message (any sender)" effect dragged a scrolled-up reader to the bottom
 * whenever ANYONE posted, or a member joined. The owner reversed that: "When
 * someone joins or someone sends a message in a chat you're scrolled up in,
 * it jumps you down to the bottom … just have a small thing that says jump to
 * new message … at the top." So now:
 *
 *   own send / own upload        → follow to the bottom, wherever the reader was
 *   anything else, at the bottom → keep following (pinned to the bottom)
 *   anything else, scrolled up   → do not move; hold the row being read still,
 *                                  and count unseen messages for the top bar
 *
 * `shouldFollow` is that rule; `decideViewportAction` is the composer's view
 * of it (a submit is always the reader's OWN action). The unseen count and its
 * label live here too (`countsAsUnseen`, `appendedRows`, `newMessagesLabel`),
 * so ChatPane's top bar is fed by tested code, not inline arithmetic.
 */

/** What a composer submit does to the message list, from the viewport's point of view. */
export type FeedChangeKind =
    /** content the feed did not have before — the reader's own send or upload */
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
    // A submit is the reader's own action, so new content from it is an own
    // send, which always follows to the bottom (they expect to see it).
    if (kind === 'new-message') {
        return shouldFollow({ cause: 'own-send', wasFollowing: wasAtBottom }) ? 'follow-bottom' : 'preserve-anchor';
    }
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

// ── Follow-or-hold for everything that changes the feed ────────────────────

/** Why the feed's content changed, from the viewport's point of view. */
export type FeedChangeCause =
    /** the reader sent / uploaded something themselves */
    | 'own-send'
    /** someone else's message landed at the end of the feed */
    | 'incoming-message'
    /** a system row landed at the end: member joined / left / kicked / banned, a call row */
    | 'system-row'
    /** an image, embed or link card finished loading and changed a row's height */
    | 'media-resize'
    /** older rows were added above (load earlier, a history-gap fill, a prefetch) */
    | 'history-load'
    /** an existing row changed in place: an edit, a reaction, a save / pin mark */
    | 'edit-or-reaction'
    /** the typing indicator appeared, changed or went away */
    | 'typing';

/**
 * Distance from the bottom (px) beyond which a reader who scrolls counts as
 * "scrolled up" and stops following. 120 px, not 0: a reader a line or two
 * short of the bottom is still reading the newest messages.
 */
export const FOLLOW_RELEASE_PX = 120;
/** Distance from the bottom (px) under which a reader re-engages following. */
export const FOLLOW_ENGAGE_PX = 60;

/**
 * Follow state after the reader scrolled, with hysteresis: following stops past
 * FOLLOW_RELEASE_PX and resumes inside FOLLOW_ENGAGE_PX; in between it keeps
 * whatever it was, so a reader hovering at ~90 px does not flicker.
 */
export function followAfterScroll(wasFollowing: boolean, distanceFromBottom: number): boolean {
    if (distanceFromBottom > FOLLOW_RELEASE_PX) return false;
    if (distanceFromBottom < FOLLOW_ENGAGE_PX) return true;
    return wasFollowing;
}

export interface FollowInput {
    cause: FeedChangeCause;
    /**
     * Was the feed following the bottom BEFORE this change? It must be the state
     * recorded before the change, never a distance measured after it: content
     * that just grew the feed makes every reader look "scrolled up" by exactly
     * its own height.
     */
    wasFollowing: boolean;
}

/**
 * Should this change pin the feed to the bottom? `false` means: do not move;
 * hold the row being read still (a scroll-anchoring correction) instead.
 *
 * Only the reader's own send overrides a scrolled-up position. Everything else
 * follows only a reader who was already following, so a reader who scrolled up
 * to read history keeps their exact place, whoever posts or joins.
 */
export function shouldFollow({ cause, wasFollowing }: FollowInput): boolean {
    if (cause === 'own-send') return true;
    return wasFollowing;
}

// ── The unseen-messages count behind the top "new messages" bar ────────────

/** The fields of a feed row the unseen count reads. */
export interface UnseenRow {
    id?: string;
    timestamp?: string | number;
    content?: { type?: string } | null;
}

/**
 * Does this row count as a "new message" for the top bar?
 *
 * Counted: anything someone else POSTED (text, sticker, attachment, GIF,
 * invite card, gift), an undecryptable placeholder for one (`system` /
 * `encrypted`: a real message waiting for its key), and member rows (joined /
 * left / kicked / banned). Member rows count because they are persisted rows
 * in the feed exactly like messages, "X joined" is something people answer
 * ("welcome!") and is one of the two triggers the owner named, and Discord
 * counts its join messages the same way.
 *
 * Not counted: the reader's own rows; call rows (`call_key`: a call has its
 * own ring, banner and sidebar, and its row changes state in place while the
 * call runs); safety-number notices; and every control type that is not a row
 * at all (edit, delete, reaction, pin, receipts). Typing never reaches here.
 */
export function countsAsUnseen(row: UnseenRow, isMine: boolean): boolean {
    if (isMine) return false;
    switch (row.content?.type) {
        case 'text':
        case 'attachment':
        case 'klipy_gif':
        case 'server_invite':
        case 'pro_gift':
        case 'system':
            return true;
        default:
            return false;
    }
}

const tsMs = (v: string | number | undefined): number =>
    typeof v === 'number' ? v : Date.parse(v ?? '');

/** The last row before a change: its identity key and its time. */
export interface LastRowMark {
    key: string;
    ts: number;
}

/**
 * The rows that landed AFTER the previous last row: genuinely new arrivals,
 * not history inserted above or in the middle (load earlier, a gap fill).
 *
 * If the previous last row is still in the list, everything after it is new.
 * If it vanished (deleted), anything strictly newer than its time is new. No
 * previous row (an empty chat) means there is nothing to diff against, and the
 * first render counts as already seen.
 */
export function appendedRows<T extends UnseenRow>(
    rows: readonly T[],
    prevLast: LastRowMark | null,
    keyOf: (row: T, index: number) => string,
): T[] {
    if (!prevLast) return [];
    for (let i = rows.length - 1; i >= 0; i--) {
        if (keyOf(rows[i], i) === prevLast.key) return rows.slice(i + 1);
    }
    if (!Number.isFinite(prevLast.ts)) return [];
    return rows.filter(r => tsMs(r.timestamp) > prevLast.ts);
}

/**
 * The top bar's wording: "3 new messages since 3:42 PM". Above 99 the count
 * reads "99+" (a busy channel left for a while would otherwise print a number
 * nobody reads). `formatClock` is the app's time formatter, so Settings >
 * Accessibility > Time format applies.
 */
export function newMessagesLabel(count: number, sinceMs: number | null, formatClock: (ms: number) => string): string {
    const n = count > 99 ? '99+' : String(count);
    const noun = count === 1 ? 'new message' : 'new messages';
    const since = sinceMs !== null && Number.isFinite(sinceMs) ? ` since ${formatClock(sinceMs)}` : '';
    return `${n} ${noun}${since}`;
}
