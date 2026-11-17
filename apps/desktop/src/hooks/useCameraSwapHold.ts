/**
 * React side of utils/cameraSwapHold.ts: the tile calls `capture(...)` from the cleanup of
 * its track-attach effect (before `track.detach` blanks the element). The frame is SHOWN
 * (<ShareHoldPicture>) only once a replacement track is known, until that track paints a
 * real frame or the cap passes. Mute / unpublish-without-replacement / disconnect drop it
 * at once: someone who turned their camera off must vanish from every viewer immediately.
 */
import React from 'react';
import { ParticipantEvent, RoomEvent, Track, type Participant, type TrackPublication } from 'livekit-client';
import { useMaybeRoomContext } from '@livekit/components-react';
import { logCallEvent } from '../utils/callEventLog';
import { captureHeldFrame, isRealFrameSize, releaseHeldFrame, type HeldFrame } from '../utils/shareHoldFrame';
import {
    CAMERA_HOLD_GRACE_MS, cameraHoldClears, cameraHoldRemainingMs, decideCameraHold, type CameraHoldEnd,
} from '../utils/cameraSwapHold';

export interface CameraSwapHoldOptions {
    /** Remote camera tiles only. */
    enabled: boolean;
    participant: Participant;
    source: Track.Source;
    videoRef: React.RefObject<HTMLVideoElement | null>;
    wrapperRef: React.RefObject<HTMLElement | null>;
    /** The publication's current track (null while the new one is not subscribed yet). */
    liveTrack: unknown;
    /** Call-log placeholder for the track ('remote-video-N'). */
    trackName: string | null;
}

export interface CaptureContext {
    /** The publication is muted right now: the camera is off. */
    muted: boolean;
    /** A non-muted replacement track for this participant + source is already there. */
    replacementKnown: boolean;
}

export function useCameraSwapHold({ enabled, participant, source, videoRef, wrapperRef, liveTrack, trackName }: CameraSwapHoldOptions) {
    const room = useMaybeRoomContext();
    // The frame on screen. A captured frame that is still waiting for a replacement (the
    // grace) lives only in heldRef: nothing of the face is drawn until a swap is certain.
    const [frame, setFrame] = React.useState<HeldFrame | null>(null);
    const heldRef = React.useRef<HeldFrame | null>(null);
    const shownRef = React.useRef(false);
    const startedAtRef = React.useRef(0);
    const graceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = React.useRef(true);
    const nameRef = React.useRef(trackName);
    const liveRef = React.useRef<unknown>(liveTrack);
    React.useLayoutEffect(() => { nameRef.current = trackName; liveRef.current = liveTrack; }, [trackName, liveTrack]);

    const release = React.useCallback((end: CameraHoldEnd) => {
        const held = heldRef.current;
        if (!held) return;
        const wasShown = shownRef.current;
        heldRef.current = null;
        shownRef.current = false;
        if (graceRef.current) { clearTimeout(graceRef.current); graceRef.current = null; }
        releaseHeldFrame(held);
        const ms = Math.round(performance.now() - startedAtRef.current);
        logCallEvent('rx_video_gap', { track: nameRef.current ?? 'remote-video-0', reason: 'swap', held: wasShown, end, ms });
        if (mountedRef.current) setFrame(null);
    }, []);

    const show = React.useCallback(() => {
        const held = heldRef.current;
        if (!held || shownRef.current) return;
        shownRef.current = true;
        if (graceRef.current) { clearTimeout(graceRef.current); graceRef.current = null; }
        if (mountedRef.current) setFrame(held);
    }, []);

    // Called from the tile's attach-effect cleanup, with the element that is about to be detached.
    const capture = React.useCallback((el: HTMLVideoElement | null, sameTile: boolean, ctx: CaptureContext) => {
        if (!enabled || !el) return;
        const decision = decideCameraHold({
            sameTile, alreadyHeld: !!heldRef.current, muted: ctx.muted, replacementKnown: ctx.replacementKnown,
            readyState: el.readyState, videoWidth: el.videoWidth, videoHeight: el.videoHeight,
        });
        if (decision === 'none') return;
        const wrapper = wrapperRef.current;
        const taken = captureHeldFrame(
            el,
            wrapper ? { width: wrapper.clientWidth, height: wrapper.clientHeight } : null,
            typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
        );
        if (!taken) return;
        heldRef.current = taken;
        shownRef.current = false;
        startedAtRef.current = performance.now();
        if (decision === 'show') { show(); return; }
        // Hidden until a replacement shows up; dropped if none does within the grace.
        graceRef.current = setTimeout(() => {
            graceRef.current = null;
            if (!heldRef.current || shownRef.current) return;
            if (cameraHoldClears({ type: 'grace_expired', replacementArrived: !!liveRef.current })) release('gone');
            else show();
        }, CAMERA_HOLD_GRACE_MS);
    }, [enabled, wrapperRef, show, release]);

    // A replacement arriving inside the grace turns the hidden frame into the hold.
    React.useEffect(() => {
        if (liveTrack && heldRef.current && !shownRef.current) {
            const pub = participant.getTrackPublication(source);
            if (pub && !pub.isMuted) show();
        }
    }, [liveTrack, participant, source, show]);

    // Camera off / gone: clear at once, whatever state the hold is in.
    React.useEffect(() => {
        if (!enabled) return;
        const onMuted = (pub: TrackPublication) => {
            if (pub.source === source && cameraHoldClears({ type: 'muted' })) release('cleared');
        };
        const onUnpublished = (pub: TrackPublication) => {
            if (pub.source !== source) return;
            const other = participant.getTrackPublication(source);
            if (cameraHoldClears({ type: 'unpublished', replacementExists: !!other && !other.isMuted })) release('cleared');
        };
        const onLeft = (p: Participant) => {
            if (p.identity === participant.identity && cameraHoldClears({ type: 'disconnected' })) release('cleared');
        };
        participant.on(ParticipantEvent.TrackMuted, onMuted);
        participant.on(ParticipantEvent.TrackUnpublished, onUnpublished);
        room?.on(RoomEvent.ParticipantDisconnected, onLeft);
        return () => {
            participant.off(ParticipantEvent.TrackMuted, onMuted);
            participant.off(ParticipantEvent.TrackUnpublished, onUnpublished);
            room?.off(RoomEvent.ParticipantDisconnected, onLeft);
        };
    }, [enabled, participant, source, room, release]);

    // The cap, and the new track's first real frame (only a SHOWN hold waits on these).
    React.useEffect(() => {
        if (!frame) return;
        const timer = setTimeout(() => release('timeout'), cameraHoldRemainingMs(startedAtRef.current, performance.now()));
        const el = videoRef.current;
        if (!liveTrack || !el) return () => clearTimeout(timer);
        let cancelled = false;
        let handle = 0;
        const painted = (): boolean => {
            if (cancelled || !isRealFrameSize(el.videoWidth, el.videoHeight)) return false;
            release('painted');
            return true;
        };
        const hasRvfc = typeof el.requestVideoFrameCallback === 'function';
        if (hasRvfc) {
            const onFrame = () => { if (!painted() && !cancelled) handle = el.requestVideoFrameCallback(onFrame); };
            handle = el.requestVideoFrameCallback(onFrame);
        } else {
            el.addEventListener('loadeddata', painted);
        }
        return () => {
            cancelled = true;
            clearTimeout(timer);
            if (hasRvfc) el.cancelVideoFrameCallback(handle);
            else el.removeEventListener('loadeddata', painted);
        };
    }, [frame, liveTrack, videoRef, release]);

    // Unmount (participant left, tile removed): the pixels go with it.
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (graceRef.current) clearTimeout(graceRef.current);
            releaseHeldFrame(heldRef.current);
            heldRef.current = null;
        };
    }, []);

    return { frame, capture };
}
