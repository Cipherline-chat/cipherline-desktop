/**
 * OfflineScreen — full-screen overlay shown when the device has no network.
 *
 * Sits above the Dashboard (z-[9990]) so the user can't interact with
 * stale data while offline. When the network comes back it shows a brief
 * "back online" beat and then simply gets out of the way.
 *
 * It used to HARD-RELOAD the renderer at that point (except during a call).
 * That reload was the single most expensive thing the app could do — a full
 * cold start: every script re-downloaded and re-evaluated, the whole
 * encrypted store decrypted again, every list and history re-fetched — and it
 * fired on exactly the most common wake path (the network drops while the PC
 * sleeps, comes back on wake), i.e. right when the user had just opened the
 * app to read something. That is the "wakes the PC, opens Cipherline, it
 * hangs for a long time and then comes back" report.
 *
 * Nothing needs the reload any more. isOnline can only turn true here once
 * the WebSocket has proven a fresh round trip (see useNetworkStatus), and
 * that reconnect is what drives the full resync in Dashboard (the
 * wsConnectCount effect + rehydrateAll): the open conversation first, DMs,
 * every list, badges, permissions, voice presence. That resync was already
 * what kept the app correct whenever a call was active (the reload was
 * skipped then because it killed LiveKit's own ~38 s reconnect window), so
 * the two paths are now one.
 *
 * THE SECRET, here too: after HINT_MS a quiet "Press Space to play" fades in
 * under the dots. Space (only Space — never a click) cross-fades into the same
 * Firewall game the loading screen has, as the offline mode of AppLoadingScreen
 * (autoPlay: the run starts as the field appears). Esc returns to this card.
 * If the connection comes back mid-run nobody is yanked out: the game's own
 * "You're back online · Enter to continue" chip appears and the screen waits
 * for Enter, Esc or game over — so the 550 ms "reconnecting" clear below never
 * runs while a game is up. Offered only where a worker-driven field can exist
 * (canOfferGame) and never under reduced motion.
 *
 * Only rendered when the user is authenticated — the login screen handles
 * its own offline error state via the toast system.
 */

import React, { useEffect, useState } from 'react';
import { Keys } from './mascot/Keys';
import { AppLoadingScreen } from './AppLoadingScreen';
import { canOfferGame } from './loadingWorkerHost';
import { HINT_MS } from './loadingWait';

/** Cosmetic-only pause before clearing the overlay once we're confirmed back
 *  online — long enough to see the mascot perk up, short enough that it never
 *  reads as "stuck". Not a wait-for-signal timeout; see the note below on why. */
const RECONNECT_DELAY_MS = 550;

interface Props {
    isOnline: boolean;
}

type Phase = 'offline' | 'reconnecting' | 'hidden';

/** The shared articulated Keys (components/mascot/Keys.tsx), flipping between
 *  its downcast `sad` face while offline (droopy brows, a single tear, the
 *  limb sway dragging at half speed) and an excited hello wave for the
 *  reconnecting beat — the wave's opening lean + arm raise land well inside
 *  the 550ms cosmetic delay before the overlay clears. Display-only: no pokes on a
 *  blocking overlay. */
const OfflineMascot: React.FC<{ sad: boolean }> = ({ sad }) => (
    <Keys
        size={72}
        sad={sad}
        wave={!sad}
        interactive={false}
        waveOnMount={false}
        ariaLabel={sad ? 'Keys, looking sad' : 'Keys, happy to be back'}
    />
);

const isEditable = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

export const OfflineScreen: React.FC<Props> = ({ isOnline }) => {
    const [phase, setPhase] = useState<Phase>(isOnline ? 'hidden' : 'offline');
    const [playing, setPlaying] = useState(false);
    const [hintOn, setHintOn] = useState(false);
    const [reduced] = useState(
        () => typeof window !== 'undefined'
            && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    );
    const gameOffered = !reduced && canOfferGame();

    // Reacts to isOnline flipping — same "sync local state to an external
    // system" shape useNetworkStatus.ts itself uses for navigator.onLine.
    //
    // When isOnline flips to false → go offline immediately, from any
    // phase (a flaky connection dropping again mid-"reconnecting" cancels
    // the pending clear below via the second effect's cleanup).
    //
    // When isOnline flips to true from a real offline state → briefly show
    // "back online", then clear (scheduled by the effect below).
    //
    // Bug fix: this used to wait for a SEPARATE 'cipherline:ws-connected'
    // window event, registering that listener only once we'd already
    // entered the 'reconnecting' phase. But isOnline (useNetworkStatus)
    // ALREADY incorporates the WS-connected signal into its own state —
    // isOnline can only become true here if the WebSocket has already
    // confirmed a connection (or never needed one). By the time that old
    // effect ran, the one-shot 'cipherline:ws-connected' event that caused
    // isOnline to flip had typically ALREADY fired and passed — registering
    // a listener for it there was listening for an event that had already
    // happened, so it could only catch the NEXT disconnect/reconnect cycle,
    // not this one. That's why reconnects "took forever" despite the app
    // already being reconnected: the overlay was waiting on a signal it had
    // already missed, until the 30s fallback finally gave up — and Ctrl+R,
    // which just reloads unconditionally, "fixed" it instantly because
    // there was never anything left to actually wait for. Since isOnline
    // being true already means we're good to go, there's nothing left to
    // listen for — just clear after a short cosmetic beat.
    useEffect(() => {
        if (!isOnline) {
            setPhase('offline');
            return;
        }
        setPhase(p => (p === 'offline' ? 'reconnecting' : p));
    }, [isOnline]);

    // Clears the overlay after the cosmetic beat once 'reconnecting' starts.
    // NEVER reloads the renderer (see the file header) — the WS reconnect that
    // made isOnline true has already started the full resync. If phase changes
    // away from 'reconnecting' before the timer fires (connection dropped
    // again), the cleanup cancels it.
    useEffect(() => {
        // Never while a game is up: the game stage owns the exit then (its
        // "back online" chip), and clears us through onSurfaced.
        if (phase !== 'reconnecting' || playing) return;
        const timer = setTimeout(() => setPhase('hidden'), RECONNECT_DELAY_MS);
        return () => clearTimeout(timer);
    }, [phase, playing]);

    // The hint: after HINT_MS of being offline, and gone the moment we aren't.
    useEffect(() => {
        if (phase !== 'offline' || playing || !gameOffered) return;
        const timer = setTimeout(() => setHintOn(true), HINT_MS);
        // Reset on the way out (not by a setState in the body), so the hint
        // starts quiet again on the next offline spell.
        return () => { clearTimeout(timer); setHintOn(false); };
    }, [phase, playing, gameOffered]);

    // Space starts the game — only once the hint is showing, never from typing,
    // and in the capture phase so the app underneath never sees it (a focused
    // button would otherwise be "clicked" by the same key).
    useEffect(() => {
        if (!hintOn) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
            if (e.code !== 'Space' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) setPlaying(true);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [hintOn]);

    if (phase === 'hidden') return null;

    if (playing) {
        return (
            <div className="fixed inset-0 z-[9990]">
                <AppLoadingScreen
                    offline
                    autoPlay
                    phase={isOnline ? 'surfacing' : 'loading'}
                    onSurfaced={() => { setPlaying(false); setPhase('hidden'); }}
                    onIdle={() => setPlaying(false)}
                />
            </div>
        );
    }

    return (
        <div
            className={[
                'fixed inset-0 z-[9990] flex items-center justify-center',
                'backdrop-blur-[3px]',
                'transition-opacity duration-300',
                phase === 'reconnecting' ? 'opacity-95' : 'opacity-100',
            ].join(' ')}
            style={{
                pointerEvents: 'all',
                background: 'radial-gradient(120% 120% at 50% 20%, var(--cl-deep) 0%, var(--cl-abyss) 65%)',
            }}
        >
            <div className="flex flex-col items-center gap-4 text-center select-none max-w-[320px] px-6">
                <OfflineMascot sad={phase === 'offline'} />

                {phase === 'offline' ? (
                    <>
                        <div className="space-y-1.5">
                            <p style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 500, fontSize: 18, color: 'var(--cl-text)', margin: 0, lineHeight: 1.3 }}>
                                You're offline
                            </p>
                            <p style={{ fontFamily: 'var(--cl-font-body)', fontSize: 13, color: 'var(--cl-faint)', lineHeight: 1.5, margin: 0 }}>
                                Cipherline will reconnect automatically the moment your connection is back.
                            </p>
                        </div>

                        {/* Bouncing dots, recolored to the brand accent. */}
                        <div className="flex items-center gap-2 pt-1">
                            {[0, 1, 2].map(i => (
                                <span
                                    key={i}
                                    className="w-1.5 h-1.5 rounded-full animate-bounce"
                                    style={{ background: 'var(--cl-flash)', animationDelay: `${i * 160}ms` }}
                                />
                            ))}
                        </div>

                        {/* The secret: quiet, and only once it has been offline a moment. */}
                        <p
                            aria-hidden={!hintOn}
                            style={{
                                fontFamily: 'var(--cl-font-body)', fontSize: 12, fontWeight: 700, margin: 0,
                                color: 'var(--cl-faint)', opacity: hintOn ? 0.75 : 0,
                                transition: 'opacity 700ms ease-out', minHeight: 18,
                            }}
                        >
                            {gameOffered && <>Press <kbd className="lo-kbd">Space</kbd> to play</>}
                        </p>
                    </>
                ) : (
                    <div className="space-y-1.5">
                        <p style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 500, fontSize: 18, color: 'var(--cl-text)', margin: 0, lineHeight: 1.3 }}>
                            Back online!
                        </p>
                        <p style={{ fontFamily: 'var(--cl-font-body)', fontSize: 13, color: 'var(--cl-faint)', lineHeight: 1.5, margin: 0 }}>
                            Reconnecting…
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default OfflineScreen;
