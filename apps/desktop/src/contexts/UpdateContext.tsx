/**
 * UpdateContext — renderer-side view of the auto-updater's lifecycle.
 *
 * Thin by design: it only mirrors main-process state (electron/updater-state.ts
 * owns the actual transition logic) and exposes the actions a user can take —
 * install, retry a failed update (always in the app), force a check, and —
 * Linux AppImage only — open the manual download. It deliberately does
 * NOT know about calls — "are you sure, you'll
 * leave your call" is a UI decision made where call state actually lives
 * (Dashboard), not something this context should reach for.
 *
 * Mounted once at the App root (see App.tsx) so it survives the auth →
 * dashboard transition and the state isn't lost/re-fetched on navigation.
 */

import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';

const IDLE: UpdateStateShape = { phase: 'idle' };

export interface UpdateContextValue {
    state: UpdateStateShape;
    /** Restart into the downloaded build. Only meaningful when state.phase === 'ready'. */
    installNow: () => void;
    /** Try a failed update again, in the app: main clears the half-finished
     *  download and starts a fresh one. Meaningful in 'retrying' (retry now)
     *  and 'failed'. */
    retry: () => void;
    /** Open the direct download link in the OS browser. Only meaningful when
     *  state.phase === 'manual', which main produces on Linux only. */
    openDownload: () => void;
    /**
     * Force an update check now, instead of waiting up to four hours for the
     * next scheduled one (see main.ts's `updater:check-now`).
     *
     * Resolves true when a real check was dispatched, false in a build with no
     * updater to ask. Unlike the two actions above this REJECTS on failure
     * rather than swallowing it: the caller (Settings → Advanced) asked a
     * direct question and has a visible place to report "that didn't work",
     * where a click on the rail tile has none.
     *
     * The answer arrives on `state`, not in the return value —
     * checkForUpdates() resolves whether or not it found anything.
     */
    checkNow: () => Promise<boolean>;
}

const UpdateContext = createContext<UpdateContextValue | undefined>(undefined);

export function UpdateProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<UpdateStateShape>(IDLE);

    useEffect(() => {
        const api = window.electronAPI;
        if (!api?.onUpdateState) return; // web/dev context with no preload bridge

        // Seed with whatever already happened before this provider mounted —
        // the main process caches the last state for exactly this reason (a
        // reload, or the provider mounting after an early background check
        // already resolved). Subscribe FIRST so a transition landing between
        // the seed read and the subscribe can't be lost.
        const unsub = api.onUpdateState((next) => setState(next));
        api.getUpdateState?.().then((seed) => setState((prev) =>
            // Don't clobber a transition that already arrived via the live
            // subscription while this promise was in flight.
            prev === IDLE ? seed : prev
        )).catch(() => { /* non-fatal — live subscription still works */ });

        return () => unsub();
    }, []);

    const installNow = useCallback(() => {
        window.electronAPI?.quitAndInstall?.().catch((err) => {
            console.warn('[UpdateContext] quitAndInstall failed:', err);
        });
    }, []);

    const retry = useCallback(() => {
        const api = window.electronAPI;
        if (!api?.retryUpdate) return;
        // Optimistic: the click visibly does something at once; main pushes
        // the real state ('available' → 'downloading' …) right behind it.
        setState(prev => (prev.phase === 'retrying' || prev.phase === 'failed' || prev.phase === 'manual')
            ? { phase: 'available', version: prev.version }
            : prev);
        api.retryUpdate().catch((err) => {
            console.warn('[UpdateContext] retryUpdate failed:', err);
        });
    }, []);

    const openDownload = useCallback(() => {
        if (state.phase !== 'manual') return;
        window.electronAPI?.openExternal?.(state.downloadUrl).catch((err) => {
            console.warn('[UpdateContext] openExternal failed:', err);
        });
    }, [state]);

    const checkNow = useCallback(async () => {
        const api = window.electronAPI;
        // No bridge (browser preview) is the same answer as an unpackaged
        // build: we can't ask, so don't claim we did.
        if (!api?.checkForUpdatesNow) return false;
        return api.checkForUpdatesNow();
    }, []);

    const value = useMemo(
        () => ({ state, installNow, retry, openDownload, checkNow }),
        [state, installNow, retry, openDownload, checkNow],
    );

    return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export function useUpdate(): UpdateContextValue {
    const ctx = useContext(UpdateContext);
    if (!ctx) throw new Error('useUpdate must be used within an UpdateProvider');
    return ctx;
}
