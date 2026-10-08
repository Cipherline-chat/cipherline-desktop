/**
 * One tick of WebRTC stats for every video stream in a LiveKit call, shaped for
 * utils/videoFreezeDetector.ts. Used by components/call/GamingVideoGuard.tsx,
 * and only while that guard is sampling (Cipherline in the background, the
 * gaming-video mode off, an offer still allowed).
 *
 * Per-track reports (`track.getRTCStatsReport()` → the track's own
 * RTCRtpSender / RTCRtpReceiver getStats), so no mapping between stats ids
 * and tracks is needed and a sender whose track was swapped out (LiveKit's
 * pauseUpstream) still reports. Stream keys are track sids — opaque, kept only
 * in memory by the detector, never logged.
 */
import { Track, type LocalTrackPublication, type LocalVideoTrack, type RemoteTrackPublication, type RemoteVideoTrack, type Room } from 'livekit-client';
import { outboundCountersFromReport, inboundCountersFromReport, type VideoStreamSample } from './videoFreezeDetector';

/** Most video streams sampled per tick (getStats per stream). */
const MAX_SAMPLED_STREAMS = 12;

const kindOf = (source: Track.Source): 'camera' | 'screen' | null =>
    source === Track.Source.Camera ? 'camera' : source === Track.Source.ScreenShare ? 'screen' : null;

/**
 * One tick of samples. A stream that is muted, paused (ours or the SFU's),
 * unsubscribed or ended is reported `eligible: false` WITHOUT fetching its
 * stats — the detector resets its history on that.
 */
export async function sampleCallVideo(room: Room): Promise<VideoStreamSample[]> {
    const jobs: Promise<VideoStreamSample | null>[] = [];
    room.localParticipant.videoTrackPublications.forEach((pub: LocalTrackPublication) => {
        const kind = kindOf(pub.source);
        const track = pub.track as LocalVideoTrack | undefined;
        if (!kind || !track || jobs.length >= MAX_SAMPLED_STREAMS) return;
        const key = `out:${pub.trackSid}`;
        const eligible = !pub.isMuted && track.mediaStreamTrack?.readyState === 'live';
        jobs.push((eligible ? track.getRTCStatsReport().catch(() => undefined) : Promise.resolve(undefined)).then(report => {
            const c = eligible ? outboundCountersFromReport(report) : null;
            return c
                ? { direction: 'out' as const, key, kind, eligible: true, ...c }
                : { direction: 'out' as const, key, kind, eligible: false, framesSent: 0, bandwidthLimited: false };
        }));
    });
    room.remoteParticipants.forEach(p => p.videoTrackPublications.forEach((pub: RemoteTrackPublication) => {
        const kind = kindOf(pub.source);
        const track = pub.track as RemoteVideoTrack | undefined;
        if (!kind || !track || !pub.isSubscribed || jobs.length >= MAX_SAMPLED_STREAMS) return;
        const key = `in:${pub.trackSid}`;
        const eligible = pub.isEnabled && !pub.isMuted
            && track.streamState === Track.StreamState.Active
            && track.mediaStreamTrack?.readyState === 'live';
        jobs.push((eligible ? track.getRTCStatsReport().catch(() => undefined) : Promise.resolve(undefined)).then(report => {
            const c = eligible ? inboundCountersFromReport(report) : null;
            return c
                ? { direction: 'in' as const, key, kind, eligible: true, ...c }
                : { direction: 'in' as const, key, kind, eligible: false, framesDecoded: 0, bytesReceived: 0, packetsReceived: 0, packetsLost: 0 };
        }));
    }));
    return (await Promise.all(jobs)).filter((s): s is VideoStreamSample => s !== null);
}
