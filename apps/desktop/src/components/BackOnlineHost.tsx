/**
 * Shows the "Back online" toast (utils/backOnline.ts decides when). Mounted
 * once in the signed-in app, fed the same connectivity signal the offline
 * screen uses. Renders nothing itself; the toast is the stock one, small and
 * self-dismissing, never a full-screen anything.
 *
 * A beat after the connection returns (so the offline screen's own "Back
 * online!" moment has cleared), and only if it is still up then.
 */
import { useEffect, useRef } from 'react';
import { useToast } from '../contexts/ToastContext';
import { createBackOnlineTracker, formatOutage } from '../utils/backOnline';

/** How long after the return before the note appears. */
export const BACK_ONLINE_SHOW_DELAY_MS = 1500;
/** The toast stays this long. */
export const BACK_ONLINE_TOAST_MS = 4500;

export function BackOnlineHost({ isOnline }: { isOnline: boolean }) {
    const { push } = useToast();
    const pushRef = useRef(push);
    useEffect(() => { pushRef.current = push; });
    const tracker = useRef(createBackOnlineTracker());
    const onlineRef = useRef(isOnline);
    onlineRef.current = isOnline;

    useEffect(() => {
        const r = tracker.current.update(isOnline, Date.now());
        if (!r.show) return;
        const timer = window.setTimeout(() => {
            if (!onlineRef.current) return;   // dropped again during the beat: no note
            pushRef.current({
                kind: 'success',
                title: 'Back online',
                message: `You were offline for ${formatOutage(r.offlineMs)}.`,
                durationMs: BACK_ONLINE_TOAST_MS,
            });
        }, BACK_ONLINE_SHOW_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [isOnline]);

    return null;
}

export default BackOnlineHost;
