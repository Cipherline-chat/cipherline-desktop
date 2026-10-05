import { useEffect, useRef } from 'react';

/**
 * useMascotCue — one cue, every mascot on screen reacts.
 *
 * Fixes a real bug: `StartDMModal` has always dispatched `cl:cuttlefish` when
 * you search for the mascot by name, and NOTHING in the app listened. The
 * catalog documented the egg as shipped; it silently did nothing.
 *
 * Every mounted mascot responds rather than only the "nearest" one. At most
 * two are ever co-mounted in practice (the titlebar mark, plus a MascotEmpty
 * that may be behind a modal), and the titlebar one is never covered by the
 * modal that emits the cue — so the egg always has a visible payoff without
 * needing visibility tracking.
 *
 * The once-per-session guard lives on the EMIT side deliberately: listeners
 * mount and unmount as views change, so a per-listener guard would let the egg
 * re-fire simply by navigating. Emitting once also means retyping the trigger
 * word rotates its text line (an owned field slot, rule 6) without
 * re-triggering the animation (rule 6: visual eggs fire once per session).
 */

export const MASCOT_CUE = 'cl:cuttlefish';

let fired = false;

/** Fire the cue, at most once per session. */
export function emitMascotCue(): void {
    if (fired) return;
    fired = true;
    window.dispatchEvent(new CustomEvent(MASCOT_CUE));
}

/**
 * Run `onCue` when the mascot cue fires. Skips entirely under reduced motion
 * (rule 9) — checked at cue time, not mount time, so a mid-session OS change
 * is respected.
 */
export function useMascotCue(onCue: () => void): void {
    const ref = useRef(onCue);
    useEffect(() => { ref.current = onCue; });

    useEffect(() => {
        const handler = () => {
            if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
            ref.current();
        };
        window.addEventListener(MASCOT_CUE, handler);
        return () => window.removeEventListener(MASCOT_CUE, handler);
    }, []);
}

/** Test-only: reset the once-per-session guard. */
export function __resetMascotCueForTests(): void {
    fired = false;
}
