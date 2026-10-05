import { useSyncExternalStore } from 'react';

/**
 * Which columns the in-call focused pane is allowed to span.
 *
 * In the ordinary (wide) layout the focused video sits above the chat column
 * only, so the conversation / channel list keeps its full height. That is the
 * right trade while the chat column is wide enough to show a usable video.
 *
 * Below the breakpoint it stops being the right trade: the chat column gets so
 * narrow that a 16:9 video in it is postage-stamp sized, while a full-height
 * channel list sits next to it doing nothing urgent. So the focused pane also
 * spans the channel/DM column, which drops to the remaining height underneath.
 * The server rail never yields — it is 72px of navigation the user always needs.
 *
 * ── Where 1370 comes from ────────────────────────────────────────────────────
 * Measured against the real layout (Dashboard.tsx + layout-drift.css) at the
 * default pane ratios:
 *
 *   server rail                 72   (nav.app-rail, Dashboard.tsx)
 *   main-row horizontal padding 12   (layout-drift.css: 6px 10px 10px 2px)
 *   two drag dividers           20   (layout-drift.css forces .app-div1/2 to 10px)
 *   channel/DM list       max(200, 0.18 * W)   (DEFAULT_LEFT_RATIO)
 *   context panel         max(280, 0.20 * W)   (DEFAULT_RIGHT_RATIO, floored at
 *                                               RIGHT_PANEL_MIN_PX below W=1400)
 *   ─────────────────────────────────────────
 *   chat column = W - 104 - list - panel
 *
 * The focused video is centred in the chat column at 16:9, so its usable width
 * IS the chat column width. In the regime that matters (list on its 0.18 ratio,
 * panel pinned to its 280px floor) that width is `0.82 * W - 384`, so the
 * breakpoint is whatever W makes that equal the floor below.
 *
 * ── Why the floor moved from 560 to 740 (2026-09-12) ─────────────────────────
 * The original 560px was an ILLEGIBILITY cliff: below it (~315px tall) shared
 * code and slide text stop being decipherable at all. That is a floor, not a
 * preference, and it made the span trigger only at W <= 1151 — so on an
 * ordinary narrow-ish window you sat just above it, watching a technically-
 * readable but cramped video next to a full-height channel list doing nothing.
 * The owner asked for the swap to happen sooner.
 *
 * So this is now a COMFORT threshold rather than a legibility one, and it
 * should be read that way: 740px (=> ~416px tall, comfortably above 720p-class
 * height) is where a shared screen reads easily rather than merely legibly.
 * Being a preference, it is a fine number to move again on request — that is
 * what FOCUS_SPANS_SIDEBAR_MIN_CHAT_PX exists for. Nothing below it is broken;
 * it just trades a channel list nobody is reading mid-call for a bigger video.
 *
 *   W = 1370  ->  list 246.6, panel 280, chat 739.4  (cramped -> span the sidebar)
 *   W = 1371  ->  list 246.8, panel 280, chat 740.2  (roomy   -> chat column only)
 *
 * At 1370 the span buys the focused pane back the list column and its divider:
 * 739 -> 996px wide, a 35% gain. 1370 also sits just above the very common
 * 1366px laptop width, so a maximised window on one of those now spans.
 *
 * Note this is a *window*-width query, matching how the user framed it ("when
 * my overall window size is narrow"). It deliberately does not react to the
 * user dragging the list column wider on a big window — that is their explicit
 * choice about how to spend the space, and yanking the layout out from under
 * a drag would be worse than the narrow video they asked for.
 */
/**
 * The chat-column width the focused video is considered comfortable at. This is
 * the knob: raise it to make the sidebar-spanning layout kick in on WIDER
 * windows (i.e. sooner), lower it to hold the ordinary layout longer.
 * {@link FOCUS_SPANS_SIDEBAR_MAX_PX} is derived from it — keep them in step.
 */
export const FOCUS_SPANS_SIDEBAR_MIN_CHAT_PX = 740;

export const FOCUS_SPANS_SIDEBAR_MAX_PX = 1370;

/** The `matchMedia` query behind {@link useFocusSpansSidebar}. */
export const FOCUS_SPANS_SIDEBAR_QUERY = `(max-width: ${FOCUS_SPANS_SIDEBAR_MAX_PX}px)`;

/** Pure form of the breakpoint, so the rule is testable without a DOM. */
export const focusSpansSidebarAt = (windowWidth: number): boolean =>
    windowWidth <= FOCUS_SPANS_SIDEBAR_MAX_PX;

/**
 * True when the focused pane should span the channel/DM column as well as the
 * chat column.
 *
 * Lives in the Dashboard (not in the call components) because the layout mode
 * has to hold wherever the user navigates — DMs, group chats, another server —
 * for as long as the call is up. The focused pane is portalled into a target
 * that never moves in the tree, so switching modes only changes grid placement:
 * nothing reparents, and nothing re-runs the pane's entry animation.
 */
export function useFocusSpansSidebar(): boolean {
    return useSyncExternalStore(subscribeToBreakpoint, getBreakpointSnapshot, getServerSnapshot);
}

const hasMatchMedia = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function subscribeToBreakpoint(onChange: () => void): () => void {
    if (!hasMatchMedia()) return () => { /* nothing to unsubscribe from */ };
    const mql = window.matchMedia(FOCUS_SPANS_SIDEBAR_QUERY);
    // Safari < 14 only has the deprecated addListener form.
    if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
}

function getBreakpointSnapshot(): boolean {
    if (!hasMatchMedia()) return false;
    return window.matchMedia(FOCUS_SPANS_SIDEBAR_QUERY).matches;
}

/** No window during SSR / the vitest node environment — assume the wide layout. */
function getServerSnapshot(): boolean {
    return false;
}
