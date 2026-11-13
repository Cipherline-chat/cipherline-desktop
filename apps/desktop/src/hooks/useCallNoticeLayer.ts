/**
 * React bindings for the sharer-side call notice layer (utils/callNoticeLayer.ts).
 */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { callNoticesHeld, holdCallNotices, subscribeCallNoticeHold } from '../utils/callNoticeLayer';
import { waitForCallOfferSlot } from '../utils/performanceOffer';

/** Whether an open call prompt is holding the notice cards back. */
export function useCallNoticesHeld(): boolean {
    return useSyncExternalStore(subscribeCallNoticeHold, callNoticesHeld, callNoticesHeld);
}

/**
 * An actionable call prompt: while `open`, every notice card waits off screen.
 * A LAYOUT effect, so the hold exists before any passive effect of the same
 * commit runs — a card mounting alongside the prompt must not cue its sound.
 */
export function useHoldCallNotices(open: boolean, id: string): void {
    useLayoutEffect(() => (open ? holdCallNotices(id) : undefined), [open, id]);
}

/**
 * A one-shot notice that must not be dropped when another card has the offer
 * slot: while `wanted`, wait for the slot; true once it is ours. Gives the slot
 * back when `wanted` goes false or the component unmounts.
 */
export function useQueuedCallOfferSlot(id: string, wanted: boolean): boolean {
    const [granted, setGranted] = useState(false);
    useEffect(() => {
        if (!wanted) return;
        const cancel = waitForCallOfferSlot(id, () => setGranted(true));
        return () => { cancel(); setGranted(false); };
    }, [id, wanted]);
    return wanted && granted;
}
