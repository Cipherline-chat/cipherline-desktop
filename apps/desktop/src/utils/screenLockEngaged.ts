/**
 * Is the Screen Lock (the PIN gate, ScreenLockOverlay) up right now?
 *
 * The lock's state lives in `useScreenLock`, inside <Dashboard>. The boot
 * loading screen (<HydrationGate>) is Dashboard's SIBLING in App.tsx, so it
 * cannot see that state — yet it has to know: a locked app must show the lock
 * and nothing of the boot screen (its bar, its dots, its status line). This
 * tiny store is the one-way signal between the two. `useScreenLock` writes it;
 * the gate reads it. It carries a boolean and nothing about the app.
 *
 * Two writers, on purpose:
 *   - `primeScreenLockEngaged` is a SILENT write for the hook's first render
 *     (the app starts locked when a PIN is configured). It must not notify:
 *     notifying a subscriber while another component renders is a React
 *     error. It exists so the gate's very first render already knows, and
 *     never mounts a loading screen it would have to take straight back down.
 *   - `setScreenLockEngaged` is the notifying write the hook makes from a
 *     layout effect whenever the lock engages or releases, and on unmount
 *     (sign-out, account switch) so a stale `true` cannot outlive the lock.
 */
import { useSyncExternalStore } from 'react';

let engaged = false;
const listeners = new Set<() => void>();

export function isScreenLockEngaged(): boolean {
    return engaged;
}

/** Silent write for render-time priming — see the header. */
export function primeScreenLockEngaged(next: boolean): void {
    engaged = next;
}

/** Notifying write — the lock engaged or released. */
export function setScreenLockEngaged(next: boolean): void {
    if (engaged === next) return;
    engaged = next;
    listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** True while the Screen Lock is up. */
export function useScreenLockEngaged(): boolean {
    return useSyncExternalStore(subscribe, isScreenLockEngaged, () => false);
}
