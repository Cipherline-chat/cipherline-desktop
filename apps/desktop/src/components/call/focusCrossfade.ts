/**
 * What FocusedStreamBanner does when `focusedStream` changes.
 *
 * The banner keeps the stream it is SHOWING (`shown`) a beat behind the one
 * that is FOCUSED (`next`) so a focus SWITCH can fade the old stream out before
 * the new one replaces it. That fade only means something when there is an old
 * stream on screen to fade:
 *
 *  - `clear`     — nothing is focused any more. Drop `shown` and make sure the
 *                  fade is off, so the next focus does not inherit a half-run
 *                  one (opacity 0 with nothing scheduled to bring it back).
 *  - `keep`      — the stream on screen is the focused one (e.g. a switch was
 *                  undone inside the fade window). Cancel any fade in progress.
 *  - `show-now`  — nothing was on screen: this is a fresh focus. Show it at
 *                  once. The banner's own entrance (`focus-banner-enter`, a
 *                  0.28 s fade-in) is the whole animation.
 *  - `crossfade` — a different stream is on screen: fade it out, then swap.
 *
 * `show-now` is the fix for "the focused stream flashes in and out for the
 * first second after focusing". A fresh focus used to take the `crossfade`
 * path with no old stream to fade, so the stream being focused was faded
 * instead: the banner mounted and started fading in (0 → 1 over 0.28 s) while
 * the tile's own wrapper faded 1 → 0 over 0.14 s, then snapped back to 1 at
 * 160 ms. Effective opacity went 0 → ~0.6 → ~0.1 → 1 — a visible blink every
 * time anything was focused from the unfocused state.
 */
export interface FocusKey {
    identity: string;
    source: string;
}

export type FocusSwap = 'clear' | 'keep' | 'show-now' | 'crossfade';

export function focusSwap(shown: FocusKey | null, next: FocusKey | null): FocusSwap {
    if (!next) return 'clear';
    if (!shown) return 'show-now';
    if (shown.identity === next.identity && shown.source === next.source) return 'keep';
    return 'crossfade';
}

/** How long the old stream fades before the new one replaces it. */
export const FOCUS_CROSSFADE_MS = 160;
