import { useEffect, useRef, useState } from 'react';

/**
 * Keeps a "should render" boolean that lags a plain `open` request on its way
 * from true -> false by `exitMs`, so a CSS exit animation has time to play
 * instead of the caller yanking the node out the instant `open` flips false.
 *
 * Rules that make this safe against a rapid toggle:
 *  - Turning `open` back to true cancels any pending unmount outright and
 *    reports mounted immediately — no half-closed state, no missed re-open.
 *  - Only one timer is ever in flight; a new close request always clears the
 *    previous one first rather than layering timers.
 *  - The calling component unmounting clears the timer too, so it can never
 *    fire a state update against a component that is already gone.
 *
 * Used by ChatPane.tsx to keep the pinned messages panel portalled long
 * enough to play `.pinned-panel-exit` (index.css) on close.
 */
export function useKeepMountedForExit(open: boolean, exitMs: number): boolean {
    const [mounted, setMounted] = useState(open);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (open) {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            setMounted(true);
            return;
        }
        // Closing: don't unmount yet — give the exit animation `exitMs` to
        // play. Clear any earlier pending unmount first so a rapid
        // close/close doesn't stack timers.
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            setMounted(false);
            timerRef.current = null;
        }, exitMs);
    }, [open, exitMs]);

    // Unmount cleanup: only matters if the CALLER unmounts mid-exit.
    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    return mounted;
}
