import React from 'react';
import { AppLoadingScreen, type LoadingPhase } from './AppLoadingScreen';
import { useHydration, HYDRATION_GATE_TIMEOUT_MS } from '../contexts/HydrationContext';
import { useScreenLockEngaged } from '../utils/screenLockEngaged';

/**
 * Covers the app until its core data has landed.
 *
 * Deliberately an OVERLAY rather than a replacement for <Dashboard>. The
 * Dashboard's own effects are what fetch conversations, friends and servers —
 * swapping it out for a loading screen would mean nothing ever loads and the
 * gate could never open. So the Dashboard mounts and works immediately; this
 * just sits on top of it until there's something worth looking at.
 *
 * The timeout is the important part. Waiting forever on a dead or very slow
 * network would replace "app looks half-loaded" with "app never opens", which
 * is a worse bug than the one being fixed. After the deadline the gate lifts
 * and the user gets whatever arrived; retries continue underneath, and
 * OfflineScreen handles the genuinely-offline case separately.
 *
 * Readiness doesn't unmount us on the spot — it starts the ascent
 * (AppLoadingScreen's 'surfacing' phase), and we leave when that finishes.
 * The Dashboard is already mounted and painted underneath the whole time, so
 * the rise is dissolving into a live app, not into a blank frame.
 *
 * It yields to the Screen Lock. A locked app shows the lock and nothing of the
 * boot screen: while the lock is up this renders nothing (and so holds no
 * worker or GL context of its own), the Dashboard keeps loading underneath
 * exactly as before, and the loads still count toward readiness. If the app
 * finished loading while locked there is nothing left to wait for, so the
 * ascent is skipped outright rather than played over the app on unlock. If it
 * did not, the loading screen picks up again after the unlock, with whatever
 * progress the loads have made by then.
 */
export const HydrationGate: React.FC = () => {
    const { ready, releaseGate, settled } = useHydration();
    // The loading bar's real progress: how many core loads have settled.
    const loads = Object.values(settled);
    const progress = loads.length ? loads.filter(Boolean).length / loads.length : 0;
    const [gone, setGone] = React.useState(false);
    const locked = useScreenLockEngaged();
    // Derived, not stored: readiness is one-way (HydrationContext keeps
    // `settled` sticky precisely so a later re-hydration can't drag the user
    // back under), so there is no state here that `ready` doesn't already hold.
    const phase: LoadingPhase = ready ? 'surfacing' : 'loading';

    React.useEffect(() => {
        if (ready) return;
        const t = window.setTimeout(() => {
            console.warn('[hydrate] gate timeout — rendering with whatever has arrived');
            releaseGate();
        }, HYDRATION_GATE_TIMEOUT_MS);
        return () => window.clearTimeout(t);
    }, [ready, releaseGate]);

    // Readiness arrived behind the lock: no ascent to play for anyone (React's
    // "adjust state while rendering" form; settles in one extra render).
    if (ready && locked && !gone) setGone(true);

    if (gone || locked) return null;

    // z-index sits above the Dashboard but below the entry curtain (200) and
    // the window drag bar (9999), so neither is disturbed. pointer-events are
    // dropped as soon as the ascent starts — the app underneath is live and
    // shouldn't be blocked by a scene that's already dissolving.
    return (
        <div
            className="fixed inset-0"
            style={{ zIndex: 150, pointerEvents: phase === 'surfacing' ? 'none' : 'auto' }}
        >
            <AppLoadingScreen phase={phase} stage="sync" progress={progress} onSurfaced={() => setGone(true)} />
        </div>
    );
};

export default HydrationGate;
