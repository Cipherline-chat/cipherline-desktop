import { useEffect } from 'react';
import { attachDesktopAnnotationOverlay } from '../utils/desktopAnnotationOverlay';

/**
 * Mirror the local screen share's annotations onto the real desktop while
 * this component is mounted (docs/video-annotation-design.md, Phase 5).
 * Pass the LiveKit identity of the sharer and the capture source id of the
 * running share; either being null means "no share" and releases the overlay.
 */
export function useDesktopAnnotationOverlay(identity: string | null | undefined, sourceId: string | null | undefined): void {
    useEffect(() => {
        if (!identity || !sourceId) return;
        return attachDesktopAnnotationOverlay(identity, sourceId);
    }, [identity, sourceId]);
}
