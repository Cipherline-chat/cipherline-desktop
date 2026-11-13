import { useEffect, useReducer, useState } from 'react';
import { createPresenceTracker, presenceNow } from '../utils/callPresenceLifecycle';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * A roster driven by server presence (voice-channel members, a huddle call's
 * participant ids, the floating huddle card). Owns its own tracker — one per
 * mount: the first roster it sees is the baseline (opening a server with a call
 * already running animates nothing), every later arrival animates in, and a
 * departure stays as a `leaving` ghost for PRESENCE_LEAVE_MS while it animates
 * out. Not tied to the call itself: removing the row never waited on anything.
 */
export function usePresenceRoster(ids: readonly string[], opts?: { selfJoinIds?: readonly string[] }) {
    const reduced = usePrefersReducedMotion();
    // One tracker per mount; selfJoinIds only matters for the first observe.
    const [tracker] = useState(() => createPresenceTracker({ reducedMotion: reduced, selfJoinIds: opts?.selfJoinIds }));
    tracker.setReducedMotion(reduced);
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const now = presenceNow();
    // Observing during render is idempotent for an unchanged roster (and
    // StrictMode's second render sees the same ids), so the list below always
    // matches THIS render's roster — no extra commit with stale rows.
    tracker.observe(ids, now);
    const items = tracker.list(now);

    // Re-render once the next ghost has finished animating out, so it is
    // removed. Keyed on the absolute deadline: unrelated re-renders don't
    // restart the timer.
    const pending = tracker.nextExpiryIn(now);
    const deadline = pending === null ? null : Math.round(now + pending);
    useEffect(() => {
        if (deadline === null) return;
        const t = setTimeout(() => { if (tracker.prune(presenceNow())) rerender(); }, Math.max(0, deadline - presenceNow()) + 16);
        return () => clearTimeout(t);
    }, [deadline, tracker]);

    return { items, tracker };
}
