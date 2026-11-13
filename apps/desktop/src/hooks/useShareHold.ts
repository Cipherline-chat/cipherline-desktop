/**
 * React's view of utils/shareHold.ts. The tracker is a module-level store rather
 * than context state so a hold can be read by the tile, the focused banner, the
 * fullscreen stage and the sound cues without a prop through each of them, and so
 * its phase is already right when the render caused by the unpublish happens.
 */
import React from 'react';
import { shareHold, type ShareHoldPhase } from '../utils/shareHold';
import { captureHeldFrame, isRealFrameSize, releaseHeldFrame, type HeldFrame } from '../utils/shareHoldFrame';

const emptySubscribe = () => () => { /* no publisher: nothing to watch */ };

export function useShareHoldPhase(identity: string | null | undefined): ShareHoldPhase {
    return React.useSyncExternalStore(
        identity ? shareHold.subscribe : emptySubscribe,
        () => (identity ? shareHold.phase(identity) : 'idle'),
    );
}

/** Publishers with a hold in progress, whose share should stay where it is though its publication is gone. */
export function useShareHoldIds(): ReadonlySet<string> {
    return React.useSyncExternalStore(shareHold.subscribe, () => shareHold.heldIds());
}

export interface ShareHoldFrameOptions {
    /** The publisher; undefined on a tile that is not a screen share. */
    identity: string | undefined;
    videoRef: React.RefObject<HTMLVideoElement | null>;
    wrapperRef: React.RefObject<HTMLElement | null>;
    /** The publication's current track. */
    liveTrack: unknown;
}

export interface ShareHoldFrameState {
    phase: ShareHoldPhase;
    frame: HeldFrame | null;
    /**
     * The placeholder is what should be on screen now: from the moment the hold is
     * announced, not from when the track goes. In between, the SFU closes the old
     * down track with a burst of tiny black frames (seen at 8x8, ~200 ms before the
     * unpublish reaches the viewer). Showing those would be a black flash, and every
     * component that measures the picture would measure them.
     */
    placeholder: boolean;
}

const hasFrameCallback = (el: HTMLVideoElement): boolean =>
    typeof el.requestVideoFrameCallback === 'function';

/**
 * One tile's part in a hold: take the frame when told to, keep it for the length of
 * the hold, let go of it after, and report when the new track has painted.
 */
export function useShareHoldFrame({ identity, videoRef, wrapperRef, liveTrack }: ShareHoldFrameOptions): ShareHoldFrameState {
    const phase = useShareHoldPhase(identity);
    const [frame, setFrame] = React.useState<HeldFrame | null>(null);

    React.useEffect(() => {
        if (!identity) return;
        let held: HeldFrame | null = null;
        const drop = () => {
            if (!held) return;
            releaseHeldFrame(held);
            held = null;
            setFrame(null);
        };
        const offCapture = shareHold.registerCapture(identity, () => {
            const wrapper = wrapperRef.current;
            releaseHeldFrame(held);
            held = captureHeldFrame(
                videoRef.current,
                wrapper ? { width: wrapper.clientWidth, height: wrapper.clientHeight } : null,
                typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
            );
            setFrame(held);
            return !!held;
        });
        // Dropped the moment the hold ends, and with the tile: a frame must not outlive either.
        const offPhase = shareHold.subscribe(() => { if (shareHold.phase(identity) === 'idle') drop(); });
        return () => { offCapture(); offPhase(); drop(); };
    }, [identity, videoRef, wrapperRef]);

    // The new track's first painted frame ends the hold. Only while resuming: in any
    // other phase a frame on this element is the OLD stream's.
    React.useEffect(() => {
        if (!identity || phase !== 'resuming' || !liveTrack) return;
        const el = videoRef.current;
        if (!el) return;
        let done = false;
        const painted = () => {
            if (done) return;
            // Not the blank frames a track can open with: the hold ends on the picture.
            if (!isRealFrameSize(el.videoWidth, el.videoHeight)) return false;
            done = true;
            shareHold.dispatch(identity, { type: 'first_frame' });
            return true;
        };
        if (hasFrameCallback(el)) {
            let handle = 0;
            const onFrame = () => { if (painted() === false) handle = el.requestVideoFrameCallback(onFrame); };
            handle = el.requestVideoFrameCallback(onFrame);
            return () => { done = true; el.cancelVideoFrameCallback(handle); };
        }
        el.addEventListener('loadeddata', painted);
        return () => { done = true; el.removeEventListener('loadeddata', painted); };
    }, [identity, phase, liveTrack, videoRef]);

    return {
        phase,
        frame,
        placeholder: phase !== 'idle',
    };
}
