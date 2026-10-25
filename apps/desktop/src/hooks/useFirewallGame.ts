import { useCallback, useState } from 'react';
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
 */
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
    return { open, canPlay, openGame, closeGame, tryOpen };
}
