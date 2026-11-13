import { useEffect, useRef } from 'react';
import { attachDesktopAnnotationOverlay } from '../utils/desktopAnnotationOverlay';
import type { OverlayShareFacts } from '../utils/screenChoiceMemory';

/**
 * Mirror the local screen share's annotations onto the real desktop while
 * this component is mounted (docs/video-annotation-design.md, Phase 5).
 * Pass the LiveKit identity of the sharer and the capture source id of the
 * running share; either being null means "no share" and releases the overlay.
 */
export function useDesktopAnnotationOverlay(
    identity: string | null | undefined,
    sourceId: string | null | undefined,
    /** Size of the shared frame, read when the overlay is shown (Wayland matches the share to a monitor by it). */
    getFrame?: () => { width: number; height: number } | null,
    /** What the share's portal said about the stream (native hardware share only). */
    getFacts?: () => OverlayShareFacts | null,
): void {
    // A ref, so a new closure each render does not tear the attachment down.
    const frameRef = useRef(getFrame);
    const factsRef = useRef(getFacts);
    useEffect(() => { frameRef.current = getFrame; factsRef.current = getFacts; });
    useEffect(() => {
        if (!identity || !sourceId) return;
        return attachDesktopAnnotationOverlay(identity, sourceId, () => frameRef.current?.() ?? null, () => factsRef.current?.() ?? null);
    }, [identity, sourceId]);
}
