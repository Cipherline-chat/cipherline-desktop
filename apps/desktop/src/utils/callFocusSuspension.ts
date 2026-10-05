/**
 * callFocusSuspension — the state machine behind Dashboard's CallFocusSuppressor.
 *
 * Some views (Friends, Home) render full-width and therefore have no
 * `#call-focus-root` in the tree. A focused stream on those views has nowhere
 * to paint: FocusedStreamBanner bails out because its portal target is missing,
 * and SidebarConference *also* skips the tile because it believes the focused
 * banner owns it — so the participant's video vanishes from the app entirely
 * until you navigate back.
 *
 * The behaviour the user expects (and which Friends already had) is
 * SUSPENSION, not teardown: entering such a view parks the current focus and
 * clears CallContext so the tile falls back into the right-hand context panel;
 * leaving restores exactly the same participant/track. The call itself is never
 * touched — audio and every tile stay live throughout, because only the
 * `focusedStream` *view* state changes.
 *
 * Pulled out of the component so the rules are checkable without a DOM:
 *
 *  1. No live call → forget anything parked. Otherwise ending call A while
 *     parked, then starting call B, would restore a focus pointing at a
 *     participant from A the moment you navigated back.
 *  2. Suppressed with a live focus → park it and clear. This runs on every
 *     change, not just on entry, so focusing a tile from the context panel
 *     *while* on Home parks the newer pick instead of leaving it stranded.
 *  3. Suppressed with nothing focused → hold whatever is parked.
 *  4. Un-suppressed with something parked → restore it and empty the park.
 *  5. Un-suppressed with nothing parked → nothing to do.
 */

export interface FocusSuspensionInput<F> {
    /** True while the active view has no focused-stream pane (Home / Friends). */
    suppressed: boolean;
    /** True while a call is live. Going false drops any parked focus. */
    callActive: boolean;
    /** What CallContext currently holds. */
    current: F | null;
    /** What this suspender has parked, if anything. */
    saved: F | null;
}

export interface FocusSuspensionResult<F> {
    /** The new parked value. */
    saved: F | null;
    /**
     * `undefined` means "leave CallContext alone". Any other value (including
     * `null`) means "call setFocusedStream with this".
     */
    apply?: F | null;
}

export function stepFocusSuspension<F>(input: FocusSuspensionInput<F>): FocusSuspensionResult<F> {
    const { suppressed, callActive, current, saved } = input;

    // 1. Call gone — drop the park. Teardown already clears `focusedStream`
    //    itself, so there is nothing to apply here.
    if (!callActive) return { saved: null };

    if (suppressed) {
        // 2. Park the live focus and collapse the view back into the panel.
        if (current) return { saved: current, apply: null };
        // 3. Nothing focused; keep holding.
        return { saved };
    }

    // 4. Back on a view that can paint a focused stream — restore.
    if (saved) return { saved: null, apply: saved };

    // 5. Nothing parked.
    return { saved: null };
}
