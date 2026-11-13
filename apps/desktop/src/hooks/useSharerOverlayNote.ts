/**
 * The sharer's own "Drawings won't show on your screen" (utils/sharerOverlayNotice.ts):
 * the note to show for the current local share, once per share, or null.
 *
 * One subscription to the desktop overlay's status per share: `told` lives and
 * dies with it, and the note goes when the share does. (A share's overlay
 * attachment starts at 'idle' and only refuses after an IPC round trip, so no
 * status change can slip in before this subscribes.)
 */
import { useCallback, useEffect, useState } from 'react';
import { onOverlayStatusChange } from '../utils/desktopAnnotationOverlay';
import { shouldTellSharer, type SharerOverlayNote } from '../utils/sharerOverlayNotice';
import { logCallEvent } from '../utils/callEventLog';

export function useSharerOverlayNote(sharing: boolean): { note: SharerOverlayNote | null; dismiss: () => void } {
    const [note, setNote] = useState<SharerOverlayNote | null>(null);
    useEffect(() => {
        if (!sharing) return;
        let told = false;
        const off = onOverlayStatusChange((st) => {
            const next = shouldTellSharer(st, window.electronAPI?.platform, told);
            if (!next) return;
            told = true;
            setNote(next);
            // Enums only: nothing about the call or the people in it.
            logCallEvent('annot_overlay', { result: 'told_sharer', reason: next.reason });
        });
        return () => { off(); setNote(null); };
    }, [sharing]);
    const dismiss = useCallback(() => setNote(null), []);
    return { note, dismiss };
}
