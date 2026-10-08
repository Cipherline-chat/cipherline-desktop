/**
 * useOfflineGrace — debounces the FULL-SCREEN offline UI only.
 *
 * useNetworkStatus is deliberately twitchy: navigator.onLine flips the instant
 * Wi-Fi renegotiates, and a WS close flips it until the next open. Those blips
 * (roaming, a router hiccup, a wake-from-sleep reconnect) are over in a second
 * or two, but the blocking OfflineScreen used to flash up for each of them.
 *
 * This hook takes the instantaneous `isOnline` and returns the value the
 * OfflineScreen should SEE:
 *   - online  → `true` immediately (never delayed, so the "Back online!" beat
 *               of an already-visible screen is unchanged);
 *   - offline → still `true` until the app has been CONTINUOUSLY offline for
 *               `graceMs`; only then does it turn `false` and the screen appear.
 * Any return to online inside the grace cancels the timer; the next drop starts
 * a fresh one. A brief drop therefore never mounts the screen at all.
 *
 * Feed it ONLY to the full-screen overlay. Reconnect/resync logic, send-failure
 * handling and presence read the raw signal (useNetworkStatus / the
 * 'cipherline:ws-*' events) and must keep doing so — nothing here delays them.
 */
import { useEffect, useState } from 'react';

/** How long the app must stay continuously offline before the overlay shows. */
export const OFFLINE_GRACE_MS = 10_000;

export function useOfflineGrace(isOnline: boolean, graceMs: number = OFFLINE_GRACE_MS): boolean {
    // True once a continuous offline spell has outlasted the grace. False at
    // mount, so a cold start while already offline also waits out the grace
    // instead of flashing the screen.
    const [expired, setExpired] = useState(false);

    useEffect(() => {
        if (isOnline) return;
        const timer = setTimeout(() => setExpired(true), graceMs);
        // Reset on the way out (the online edge, or a changed grace), not by a
        // setState in the body: the next offline spell starts a fresh grace.
        return () => { clearTimeout(timer); setExpired(false); };
    }, [isOnline, graceMs]);

    // `isOnline ||` keeps the online edge synchronous (no render of lag).
    return isOnline || !expired;
}
