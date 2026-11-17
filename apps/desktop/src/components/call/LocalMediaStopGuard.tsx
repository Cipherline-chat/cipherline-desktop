/**
 * LocalMediaStopGuard - says so when OUR camera or screen share stops without a
 * press. Mounted once per call inside <LiveKitRoom> (CallPane). Renders nothing.
 *
 * Camera: livekit-client mutes a camera whose capture track `ended` and could
 * not be restarted, and CallPane deliberately skips the LOCAL camera's mute for
 * sounds (the press plays it) - so that stop was silent, unlogged and invisible
 * (staging.229: "camera randomly turns off with no audio"). Here an unprompted
 * stop (utils/mediaSelfStop.classifyCameraStop) is logged as `camera_stop` with
 * its reason, plays the same `camera_off` cue a press does, and shows a toast.
 * The capture track's own ended / mute / unmute are logged as `camera_track`.
 * The camera is never turned back on by itself: a camera lighting up with nobody
 * asking is worse than one that stayed off (livekit-client has already tried one
 * restart before it muted).
 *
 * Share: an unprompted end is logged as `share_end` with a reason. No sound or
 * toast here - CallPane's cue controller already plays screenshare_off for a
 * real unpublish (and for a hold that ends 'stopped').
 *
 * Nothing logged names a device, a window or a person: enums, booleans and ms.
 */
import React, { useEffect, useRef } from 'react';
import { useRoomContext } from '@livekit/components-react';
import {
    ConnectionState, RoomEvent, Track, TrackEvent,
    type LocalTrack, type LocalTrackPublication, type Participant, type TrackPublication,
} from 'livekit-client';
import { useToast } from '../../contexts/ToastContext';
import { useNotificationPrefs } from '../../contexts/NotificationContext';
import { playSound } from '../../utils/notificationSounds';
import { logCallEvent } from '../../utils/callEventLog';
import { cameraStopCue } from '../../utils/callTrackCues';
import { isCameraRepublishing } from '../../utils/cameraPublish';
import {
    classifyCameraStop, classifyShareEnd, cameraStopNotice, userCameraActionRecent, deliberateShareChangeRecent,
    UNPUBLISH_SETTLE_MS,
} from '../../utils/mediaSelfStop';

type Kind = 'camera' | 'share';

export const LocalMediaStopGuard: React.FC = () => {
    const room = useRoomContext();
    const toast = useToast();
    const notif = useNotificationPrefs();
    const prefsRef = useRef(notif);
    prefsRef.current = notif;
    const toastRef = useRef(toast);
    toastRef.current = toast;

    useEffect(() => {
        if (!room) return;
        const lp = room.localParticipant;
        const now = () => Date.now();
        const endedAt: Record<Kind, number | null> = { camera: null, share: null };
        const detachers: Array<() => void> = [];
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const bound = new WeakSet<object>();
        const sinceEnded = (k: Kind) => (endedAt[k] === null ? null : now() - (endedAt[k] as number));
        const connected = () => room.state === ConnectionState.Connected;
        const kindOf = (src: Track.Source | undefined): Kind | null =>
            src === Track.Source.Camera ? 'camera' : src === Track.Source.ScreenShare ? 'share' : null;

        const bindMediaTrack = (k: Kind, mst: MediaStreamTrack | undefined) => {
            if (!mst || k !== 'camera') return;
            let mutedAt: number | null = null;
            const onMute = () => { mutedAt = now(); logCallEvent('camera_track', { state: 'source_muted', ready: mst.readyState }); };
            const onUnmute = () => {
                logCallEvent('camera_track', { state: 'source_unmuted', ms: mutedAt === null ? -1 : now() - mutedAt, ready: mst.readyState });
                mutedAt = null;
            };
            mst.addEventListener('mute', onMute);
            mst.addEventListener('unmute', onUnmute);
            detachers.push(() => { mst.removeEventListener('mute', onMute); mst.removeEventListener('unmute', onUnmute); });
        };

        const bindTrack = (track: LocalTrack | undefined, src: Track.Source | undefined) => {
            const k = kindOf(src);
            if (!k || !track || bound.has(track)) return;
            bound.add(track);
            const onEnded = () => {
                endedAt[k] = now();
                if (k === 'camera') logCallEvent('camera_track', { state: 'ended', ready: track.mediaStreamTrack?.readyState ?? 'none' });
            };
            const onRestarted = () => {
                if (k === 'camera') logCallEvent('camera_track', { state: 'restarted', ready: track.mediaStreamTrack?.readyState ?? 'none' });
                bindMediaTrack(k, track.mediaStreamTrack);
            };
            track.on(TrackEvent.Ended, onEnded);
            track.on(TrackEvent.Restarted, onRestarted);
            detachers.push(() => { track.off(TrackEvent.Ended, onEnded); track.off(TrackEvent.Restarted, onRestarted); });
            bindMediaTrack(k, track.mediaStreamTrack);
        };

        const camTrackState = () =>
            (lp.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack?.readyState) ?? 'none';

        const cameraStopped = (reason: NonNullable<ReturnType<typeof classifyCameraStop>>) => {
            logCallEvent('camera_stop', {
                reason, ready: camTrackState(), ended_ms: sinceEnded('camera') ?? -1,
                share: !!lp.getTrackPublication(Track.Source.ScreenShare),
            });
            // The same cue a press plays (SidebarConference.toggleCamera), for the stop nobody pressed.
            playSound(cameraStopCue(), prefsRef.current.prefs);
            toastRef.current.push({ kind: 'warning', title: 'Camera off', message: cameraStopNotice(reason), durationMs: 8000 });
        };

        const isLocal = (p?: Participant) => !p || p === lp || p.identity === lp.identity;

        const onMuted = (pub: TrackPublication, p: Participant) => {
            if (!isLocal(p) || pub.source !== Track.Source.Camera) return;
            const reason = classifyCameraStop({
                event: 'muted', userRecent: userCameraActionRecent(now()), republishing: isCameraRepublishing(lp),
                sinceEndedMs: sinceEnded('camera'), roomConnected: connected(),
            });
            if (reason) cameraStopped(reason);
        };
        const onUnmuted = (pub: TrackPublication, p: Participant) => {
            if (!isLocal(p) || pub.source !== Track.Source.Camera) return;
            if (!userCameraActionRecent(now())) logCallEvent('camera_track', { state: 'unmuted_unprompted', ready: camTrackState() });
        };
        const onPublished = (pub: LocalTrackPublication) => bindTrack(pub.track, pub.source);
        const onUnpublished = (pub: LocalTrackPublication) => {
            const k = kindOf(pub.source);
            if (!k) return;
            const timer = setTimeout(() => {
                timers.delete(timer);
                if (k === 'camera') {
                    const reason = classifyCameraStop({
                        event: 'unpublished', userRecent: userCameraActionRecent(now()), republishing: isCameraRepublishing(lp),
                        sinceEndedMs: sinceEnded('camera'), roomConnected: connected(),
                        replacementPresent: !!lp.getTrackPublication(Track.Source.Camera),
                    });
                    if (reason) cameraStopped(reason);
                } else {
                    const reason = classifyShareEnd({
                        roomConnected: connected(), deliberate: deliberateShareChangeRecent(now()),
                        replacementPresent: !!lp.getTrackPublication(Track.Source.ScreenShare), sinceEndedMs: sinceEnded('share'),
                    });
                    if (reason) logCallEvent('share_end', { reason, ended_ms: sinceEnded('share') ?? -1, camera: !!lp.getTrackPublication(Track.Source.Camera) });
                }
            }, UNPUBLISH_SETTLE_MS);
            timers.add(timer);
        };

        for (const pub of lp.trackPublications.values()) bindTrack((pub as LocalTrackPublication).track, pub.source);
        room.on(RoomEvent.LocalTrackPublished, onPublished);
        room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
        room.on(RoomEvent.TrackMuted, onMuted);
        room.on(RoomEvent.TrackUnmuted, onUnmuted);
        return () => {
            room.off(RoomEvent.LocalTrackPublished, onPublished);
            room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
            room.off(RoomEvent.TrackMuted, onMuted);
            room.off(RoomEvent.TrackUnmuted, onUnmuted);
            for (const d of detachers) { try { d(); } catch { /* track gone */ } }
            for (const t of timers) clearTimeout(t);
        };
    }, [room]);

    return null;
};

export default LocalMediaStopGuard;
