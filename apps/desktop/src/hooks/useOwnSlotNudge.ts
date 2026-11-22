/**
 * useOwnSlotNudge - real-time pull for an own-device slot. The server sends
 * `own_slot:changed {slot}` to the account's OTHER devices after any slot write
 * (hooks/useRealtime.ts re-dispatches it as OWN_SLOT_CHANGED_EVENT). A nudge
 * naming `slot` runs `pull` once, after a short debounce, so a burst of nudges
 * is ONE run. `pull` is the hook's own pull-only entry (a metadata probe; the
 * blob is downloaded only when its revision changed), so adopting never
 * publishes (no echo). Unknown slot names are ignored; the start / focus / poll
 * paths of each hook remain the fallback.
 */
import { useEffect, useRef } from 'react';
import { OWN_SLOT_CHANGED_EVENT } from '../utils/muteSync';

export const NUDGE_DEBOUNCE_MS = 400;

/** Pure part: returns the listener and a cancel; `schedule` is injectable for tests. */
export function createNudgeCoalescer(
    slot: string, pull: () => void,
    schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    cancel: (h: unknown) => void = h => clearTimeout(h as ReturnType<typeof setTimeout>),
) {
    let pending: unknown = null;
    return {
        onEvent(e: { detail?: { slot?: unknown } } | Event) {
            if ((e as CustomEvent<{ slot?: unknown }>).detail?.slot !== slot) return;
            if (pending !== null) return;
            pending = schedule(() => { pending = null; pull(); }, NUDGE_DEBOUNCE_MS);
        },
        cancel() { if (pending !== null) cancel(pending); pending = null; },
    };
}

export function useOwnSlotNudge(slot: string, enabled: boolean, pull: () => void): void {
    const pullRef = useRef(pull);
    useEffect(() => { pullRef.current = pull; });
    useEffect(() => {
        if (!enabled) return;
        const c = createNudgeCoalescer(slot, () => pullRef.current());
        window.addEventListener(OWN_SLOT_CHANGED_EVENT, c.onEvent);
        return () => { window.removeEventListener(OWN_SLOT_CHANGED_EVENT, c.onEvent); c.cancel(); };
    }, [slot, enabled]);
}
