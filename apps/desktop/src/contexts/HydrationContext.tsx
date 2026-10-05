/**
 * HydrationContext — tracks whether the app's core data has landed, and gives
 * everything else a signal to retry on.
 *
 * Two jobs:
 *
 * 1. **Readiness**, so first paint can wait for conversations + friends +
 *    servers instead of rendering an empty shell the user has to refresh.
 *
 * 2. **A generation counter**, which is the retry mechanism for everything
 *    that isn't a core load. Components that fetch their own data (avatars,
 *    most of all) read `generation` and include it in their effect deps; when
 *    a re-hydration happens the number changes, their effect re-runs, and
 *    anything that previously failed gets another go. Successful loads sit in
 *    their own caches, so a bump costs almost nothing — only the blanks retry.
 *
 * Why a counter rather than each component subscribing to reconnect events:
 * there are many such components and only one rule ("something changed, try
 * again"). A number in a dep array can't be forgotten the way an event
 * listener can, and it composes with React's existing re-render path.
 */

import React, { createContext, useContext, useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { isHydrationReady, type CoreLoad } from '../utils/hydrationGate';

export type { CoreLoad };

/**
 * How long first paint may be held before we give up waiting and render
 * whatever we have. A slow or dead network must never strand the user on a
 * skeleton — retries keep running underneath, and OfflineScreen covers the
 * genuinely-offline case.
 */
export const HYDRATION_GATE_TIMEOUT_MS = 8_000;

interface HydrationValue {
    /** Bumped on every re-hydration. Put it in effect deps to retry on demand. */
    generation: number;
    /** True once every core load has settled, or the gate timed out. */
    ready: boolean;
    /** Which core loads have settled (resolved OR exhausted their retries). */
    settled: Record<CoreLoad, boolean>;
    /** Mark a core load settled. Idempotent. */
    markSettled: (load: CoreLoad) => void;
    /** Give up waiting and render. Called by the gate's timeout. */
    releaseGate: () => void;
    /** Bump the generation — retry everything that can retry. */
    bumpGeneration: () => void;
}

const HydrationContext = createContext<HydrationValue | null>(null);

export const HydrationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [generation, setGeneration] = useState(0);
    const [settled, setSettled] = useState<Record<CoreLoad, boolean>>({
        conversations: false, friends: false, servers: false,
    });
    const [gateReleased, setGateReleased] = useState(false);

    const markSettled = useCallback((load: CoreLoad) => {
        setSettled(prev => (prev[load] ? prev : { ...prev, [load]: true }));
    }, []);

    const releaseGate = useCallback(() => setGateReleased(true), []);

    // Re-hydration must never re-raise the gate. Once the user is looking at
    // the app, yanking them back to a skeleton because the network blipped
    // would be worse than the stale data this whole change exists to fix —
    // so `settled` is only ever set, never cleared.
    const bumpGeneration = useCallback(() => setGeneration(g => g + 1), []);

    // Single source of truth for the rule — the same function the gate tests
    // exercise, so what's tested is what ships.
    const ready = isHydrationReady({ settled, gateReleased });

    // One retry pass for everything that failed DURING the boot burst. The
    // avatar hook retries on its own schedule, but all of those attempts land
    // inside the same congested window (cold API, core loads backing off, WS
    // connecting) that caused the first failure; nothing else bumped the
    // generation until an OS resume or a socket RE-connect. So, once the core
    // loads have first settled, wait for the burst to drain and bump once.
    const postBootBumped = useRef(false);
    useEffect(() => {
        if (!ready || postBootBumped.current) return;
        postBootBumped.current = true;
        const t = setTimeout(() => setGeneration(g => g + 1), 2_500);
        return () => clearTimeout(t);
    }, [ready]);

    const value = useMemo<HydrationValue>(() => ({
        generation, ready, settled, markSettled, releaseGate, bumpGeneration,
    }), [generation, ready, settled, markSettled, releaseGate, bumpGeneration]);

    return <HydrationContext.Provider value={value}>{children}</HydrationContext.Provider>;
};

/**
 * Safe accessor — returns a benign default when there's no provider, so
 * components used outside the authenticated tree (and existing tests) don't
 * have to care.
 */
export function useHydration(): HydrationValue {
    const ctx = useContext(HydrationContext);
    if (ctx) return ctx;
    return {
        generation: 0,
        ready: true,
        settled: { conversations: true, friends: true, servers: true },
        markSettled: () => {},
        releaseGate: () => {},
        bumpGeneration: () => {},
    };
}

/** Just the retry signal — the common case for a component that fetches. */
export function useHydrationGeneration(): number {
    return useHydration().generation;
}
