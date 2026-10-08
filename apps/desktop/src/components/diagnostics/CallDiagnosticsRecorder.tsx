import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { ConnectionState, RoomEvent, Track } from 'livekit-client';
import { webrtcRing, WEBRTC_SAMPLE_INTERVAL_MS, type CaptureInput } from '../../utils/diagnostics/webrtcRing';
import { gatherTrackStats, type RoomLike } from '../../utils/diagnostics/webrtcRoomAdapter';
import { getScreenShareSession } from '../../utils/screenShareDiagnostics';
import { sampleAvSync, setAvSyncSampler, type AvSyncRoomLike } from '../../utils/avSyncMonitor';
import { getRemotePlaybackInfo } from '../../hooks/useParticipantAudio';

/**
 * Feeds the issue reporter's WebRTC ring (utils/diagnostics/webrtcRing.ts)
 * while a call is up. Mounted inside <LiveKitRoom> (CallPane), renders
 * nothing.
 *
 * Samples every WEBRTC_SAMPLE_INTERVAL_MS only while the room is CONNECTED;
 * on unmount (call ended / left) the ring is frozen with the end time and the
 * timer is gone — no work at all outside a call. Every sample is one
 * getStats() per track; the adapter and ring keep no SID, identity or name.
 */
export function CallDiagnosticsRecorder(): null {
    const room = useRoomContext();

    useEffect(() => {
        if (!room) return;
        webrtcRing.beginCall();
        // On-demand A/V-sync sampling for the issue reporter (it calls
        // sampleAvSyncNow() when it opens). Nothing runs until then.
        const offAvSync = setAvSyncSampler(() => sampleAvSync(room as unknown as AvSyncRoomLike, getRemotePlaybackInfo, 1000));
        let timer: ReturnType<typeof setInterval> | null = null;
        let busy = false;

        const captureNow = (): CaptureInput | null => {
            const local = room.localParticipant;
            if (local?.isScreenShareEnabled) {
                const s = getScreenShareSession();
                return {
                    kind: s?.main?.sourceKind === 'window' ? 'window' : 'screen',
                    requestedFps: s?.requestedFps,
                    requestedResolution: s?.resolution,
                    codecPref: s?.codecPref,
                };
            }
            if (local?.isCameraEnabled) {
                const cam = local.getTrackPublication(Track.Source.Camera)?.track;
                const fr = cam?.mediaStreamTrack?.getSettings?.().frameRate;
                return { kind: 'camera', requestedFps: typeof fr === 'number' ? Math.round(fr) : undefined };
            }
            return null;
        };

        const sample = async () => {
            if (busy || room.state !== ConnectionState.Connected) return;
            busy = true;
            try {
                const sharing = !!room.localParticipant?.isScreenShareEnabled;
                const tracks = await gatherTrackStats(room as unknown as RoomLike, {
                    screenShareTargetFps: sharing ? getScreenShareSession()?.requestedFps : undefined,
                });
                const cap = captureNow();
                if (cap) webrtcRing.setCapture(cap);
                webrtcRing.record(Date.now(), tracks);
            } catch { /* diagnostics only */ } finally {
                busy = false;
            }
        };

        const start = () => {
            if (timer) return;
            void sample();
            timer = setInterval(() => { void sample(); }, WEBRTC_SAMPLE_INTERVAL_MS);
        };
        const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

        if (room.state === ConnectionState.Connected) start();
        room.on(RoomEvent.Connected, start);
        room.on(RoomEvent.Reconnected, start);
        room.on(RoomEvent.Disconnected, stop);
        return () => {
            offAvSync();
            stop();
            room.off(RoomEvent.Connected, start);
            room.off(RoomEvent.Reconnected, start);
            room.off(RoomEvent.Disconnected, stop);
            webrtcRing.endCall(Date.now());
        };
    }, [room]);

    return null;
}

export default CallDiagnosticsRecorder;
