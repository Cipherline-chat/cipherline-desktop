import { useEffect, useRef, useState } from 'react';
import { useAnnotationStore } from '../utils/annotationStore';
import { tryAutoArm, autoArmAnnouncement } from '../utils/annotationAutoArm';
import { useToast } from '../contexts/ToastContext';

export interface UseAnnotationAutoArmArgs {
    trackKey: string;
    ownerName: string;
    isScreenShare: boolean;
    surfaceActive: boolean;
    granted: boolean;
}

/** How long the screen-reader announcement stays in the live region. */
const ANNOUNCE_MS = 6000;

/**
 * Per-tile glue for utils/annotationAutoArm: when this tile's track has a fresh
 * "my request was approved" marker and the tile is a drawing surface, arm the
 * tool and announce it. Returns the announcement text (empty when idle) for the
 * tile to render inside an `aria-live` region.
 *
 * Re-runs when the marker appears, when the tile becomes a drawing surface
 * (focusing the share shortly after approval) and when the grant list lands -
 * `tryAutoArm` decides, and spends the marker only when it arms.
 */
export function useAnnotationAutoArm({ trackKey, ownerName, isScreenShare, surfaceActive, granted }: UseAnnotationAutoArmArgs): string {
    const pending = useAnnotationStore(s => s.approvedAt[trackKey]);
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const [announcement, setAnnouncement] = useState('');

    useEffect(() => {
        if (pending === undefined) return;
        if (!tryAutoArm(trackKey, { surfaceActive, granted })) return;
        const text = autoArmAnnouncement(ownerName, isScreenShare);
        setAnnouncement(text);
        toastRef.current.push({ kind: 'info', message: text, durationMs: 4000 });
    }, [pending, trackKey, surfaceActive, granted, ownerName, isScreenShare]);

    useEffect(() => {
        if (!announcement) return;
        const t = setTimeout(() => setAnnouncement(''), ANNOUNCE_MS);
        return () => clearTimeout(t);
    }, [announcement]);

    return announcement;
}
