/**
 * How long a viewer keeps "I am watching X's screen share" after X's share
 * publication disappears, before the watch is forgotten (and the click-to-watch
 * gate comes back).
 *
 * A sharer's republish is not instant: a FRESH republish (the start check's
 * fallback, a codec drift recovery, a software-encoder switch) unpublishes the
 * old track, re-acquires the OS capture and negotiates a new one - measured in
 * the 1.0.24-staging.178 reports as `share_start publish_ms` 1.4-3.9 s, on top
 * of the unpublish. The old 1500 ms grace was shorter than that, so the
 * viewer's watch was dropped just before the new track appeared and the
 * viewer had to click Watch AGAIN (report a346d7cf: "it republished the
 * screenshare at the start and I had to click watch 2 times"). The auto-resubscribe
 * in SidebarConference re-takes a republished share only while the sharer is
 * still in the watched set, so the grace must outlast the slowest republish.
 *
 * The price of a longer grace is that after a GENUINE stop the sharer stays in
 * the viewer's watched set (and in the viewer's own metadata's `watching_shares`)
 * for this long - a number of seconds of a social nicety, nothing more.
 */
export const WATCH_PRUNE_GRACE_MS = 10_000;

/** `prev` without the identities that are no longer sharing; `prev` itself when nothing changed. */
export function pruneToActive(prev: ReadonlySet<string>, active: ReadonlySet<string>): ReadonlySet<string> {
    const next = new Set<string>();
    prev.forEach(id => { if (active.has(id)) next.add(id); });
    return next.size === prev.size ? prev : next;
}

/** The comma-joined sorted ids of SidebarConference's `activeScreenShareIds`, as a set. */
export function activeIdSet(joined: string): Set<string> {
    return new Set(joined ? joined.split(',') : []);
}

/**
 * Schedule the prune for one render's active set; returns the cancel (the React
 * effect cleanup). A republish that brings the share back inside the grace
 * re-runs the effect first, which cancels this timer and schedules a new one
 * against the set that includes the sharer again - so nothing is pruned.
 */
export function scheduleWatchPrune<T extends ReadonlySet<string>>(
    joinedActiveIds: string,
    apply: (updater: (prev: T) => T) => void,
    graceMs: number = WATCH_PRUNE_GRACE_MS,
): () => void {
    const active = activeIdSet(joinedActiveIds);
    const timer = setTimeout(() => { apply(prev => pruneToActive(prev, active) as T); }, graceMs);
    return () => clearTimeout(timer);
}
