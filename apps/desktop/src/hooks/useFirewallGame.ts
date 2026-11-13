import { useCallback, useMemo, useState } from 'react';
import type React from 'react';
import { homeGameVerdict, type PlayVerdict } from '../utils/keysBurst';
import { canUseWorker } from '../components/loadingWorkerHost';

/**
 * Whether the easter-egg Firewall game is open: ONE state for the whole app,
 * held by Dashboard, which mounts the single FirewallOverlay. Both ways in use
 * it: Home's Keys (HomeKeys, via HomePanel's `canPlay`/`onPlay`) and the rail
 * Keys' right-click spam (RailKeys, via `tryOpen`).
 *
 * Never during a call (homeGameVerdict), and a call starting closes it: the
 * state is adjusted during render so the overlay never paints a frame over a
 * live call.
 *
 * The overlay sits over the content area only, so the rail stays clickable
 * while it is open. `railProps` (spread on the rail's <nav>) makes a click on
 * any rail control close the game on that same click: see railExitProps.
 */

/** Marks the rail <nav>: the overlay lets Space swim even when focus is on a rail control. */
export const FIREWALL_RAIL_ATTR = 'data-firewall-rail';
/** What counts as a rail control: a real click on one of these, not on the rail's padding or scrollbar. */
const RAIL_CONTROL = 'button, a[href], [role="button"], [role="menuitem"], [role="tab"]';

/**
 * The one mechanism for "click the rail while playing, leave the game". A
 * capture-phase click handler on the rail's <nav>: it runs before the control's
 * own onClick, so the tile's normal action still happens on this same click
 * (React batches the close with it). It goes through the game's ordinary close
 * (`close` = closeGame, what Esc does), so a run's score and best are kept
 * exactly as on Esc.
 *
 * Only a `click` counts, which fires for the primary button only: a right-click
 * (contextmenu) on a tile opens its menu and leaves the game running, and
 * Keys' right-click spam never produces a click. Targets are matched by DOM
 * containment, so portaled menus and popovers (a different subtree) never close
 * it. Keyboard activation (Enter on a focused tile) is a click too and closes
 * it; Space never gets there, the overlay owns it while focus is in the rail.
 */
export function railExitProps(open: boolean, close: () => void) {
    return {
        [FIREWALL_RAIL_ATTR]: '' as const,
        onClickCapture: (e: React.MouseEvent<HTMLElement>) => {
            if (!open || e.defaultPrevented) return;
            const t = e.target as Element | null;
            if (!t || typeof t.closest !== 'function') return;
            const control = t.closest(RAIL_CONTROL);
            if (control && e.currentTarget.contains(control)) close();
        },
    };
}
export function useFirewallGame(inCall: boolean) {
    const [open, setOpen] = useState(false);
    if (inCall && open) setOpen(false);
    // Not gated on reduced motion: see homeGameVerdict.
    const canPlay = useCallback(
        (): PlayVerdict => homeGameVerdict(inCall, () => canUseWorker(document.createElement('canvas'))),
        [inCall],
    );
    const openGame = useCallback(() => { if (!inCall) setOpen(true); }, [inCall]);
    const closeGame = useCallback(() => setOpen(false), []);
    /** Ask to open it now: opens on 'ok'; the verdict says why not otherwise. */
    const tryOpen = useCallback((): PlayVerdict => {
        const v = canPlay();
        if (v === 'ok') setOpen(true);
        return v;
    }, [canPlay]);
    const railProps = useMemo(() => railExitProps(open, closeGame), [open, closeGame]);
    return { open, canPlay, openGame, closeGame, tryOpen, railProps };
}
