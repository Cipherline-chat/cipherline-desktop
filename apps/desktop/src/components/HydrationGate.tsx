import React from 'react';
import { AppLoadingScreen, type LoadingPhase } from './AppLoadingScreen';
import { useHydration, HYDRATION_GATE_TIMEOUT_MS } from '../contexts/HydrationContext';

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
 */
export const HydrationGate: React.FC = () => {
    const { ready, releaseGate, settled } = useHydration();
    // The loading bar's real progress: how many core loads have settled.
    const loads = Object.values(settled);
    const progress = loads.length ? loads.filter(Boolean).length / loads.length : 0;
    const [gone, setGone] = React.useState(false);
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

    if (gone) return null;

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
