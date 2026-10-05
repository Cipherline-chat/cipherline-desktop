/**
 * micLevelRegistry — a plain, no-pub/sub holder for the local mic pipeline's
 * current level (dBFS), written by CallPane.tsx's voiceProcessor
 * `onInputLevel` callback and read by audioSilenceWatchdog's own polling
 * effect in SidebarConference.tsx.
 *
 * Deliberately NOT routed through audioHealth.ts's pub/sub `commit()`/
 * `subscribe()` machinery: onInputLevel fires at ~50 Hz (voiceProcessor's
 * level-poll timer runs every 20ms). audioHealth's commit() does a full
 * snapshot spread and notifies every subscriber (e.g. the Settings "Audio
 * health" panel via useSyncExternalStore) on every call — feeding a 50 Hz
 * signal through that would re-render any open subscriber 50 times a
 * second for no reason. The watchdog only needs to sample this value at
 * its own, much slower cadence (roughly once a second), so a bare mutable
 * field it reads on its own schedule is the right weight — same pattern as
 * activeCallRegistry.ts.
 */

let currentDbfs = -Infinity;

export function setCurrentPipelineDbfs(dbfs: number): void {
    currentDbfs = dbfs;
}

export function getCurrentPipelineDbfs(): number {
    return currentDbfs;
}

/** Reset to silence — call when the call ends so a stale reading from a
 *  previous call can't be misread by the next one before the pipeline has
 *  reported anything fresh. */
export function resetPipelineDbfs(): void {
    currentDbfs = -Infinity;
}
