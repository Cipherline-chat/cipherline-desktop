import { useEffect } from 'react';
import type React from 'react';
import type { StoragePolicy } from './useRetentionPolicy';
import { shrinkToCached, type ChannelCoverage } from '../utils/channelHistoryCoverage';
import { retentionWindowsKey } from '../utils/rowSaveState';

type CachedRows = Record<string, ReadonlyArray<{ id: string; created_at?: string; timestamp?: string | number }>>;

/**
 * A widened retention window can bring back rows a history page dropped at
 * the door as expired under the old one: un-cover what isn't cached so those
 * stretches become fillable gaps again (utils/channelHistoryCoverage
 * shrinkToCached).
 *
 * Keyed on the retention WINDOWS (plus the per-server / per-conversation
 * override versions), NOT on the policy object. A personal "Save for me" /
 * "Remove from my saves" rebuilds the policy (its per-message id lists), and
 * while this ran on every policy change, each personal save pulled a fully
 * loaded channel's coverage off its first message: "This is the beginning of
 * #channel" was swapped for an "older history" gap row above the first
 * message, and as the feed has `overflow-anchor: none`, every row on screen
 * moved (29 px at 1366x768) — the "Save for me makes the chat jump" bug of
 * 0.1.2-staging.247. Save to server and Pin never touch the policy, which is
 * why they never did it. A save only exempts a row that is already cached; it
 * cannot bring back a row dropped at the door, so it has nothing to un-cover.
 */
export function useRetentionCoverageShrink(
    policy: StoragePolicy,
    /** Changes whenever a per-server / per-conversation override is edited. */
    overridesVersion: string,
    setCoverage: React.Dispatch<React.SetStateAction<Record<string, ChannelCoverage>>>,
    cachedRowsRef: React.MutableRefObject<CachedRows>,
): void {
    const windows = retentionWindowsKey(policy);
    useEffect(() => {
        setCoverage(cov => {
            let changed = false;
            const next: Record<string, ChannelCoverage> = {};
            for (const [cid, segs] of Object.entries(cov)) {
                next[cid] = shrinkToCached(segs, cachedRowsRef.current[cid] ?? []);
                if (next[cid] !== segs) changed = true;
            }
            return changed ? next : cov;
        });
    }, [windows, overridesVersion, setCoverage, cachedRowsRef]);
}
