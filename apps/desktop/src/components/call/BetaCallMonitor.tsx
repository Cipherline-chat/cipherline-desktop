/**
 * BetaCallMonitor — the closed beta's in-call observer, inside <LiveKitRoom>
 * (CallPane). Renders nothing, and does nothing at all while beta
 * diagnostics is off.
 *
 *   - time to first audio: from the moment a remote participant is in the
 *     room with us (our connect, or their join if later) to their microphone
 *     track being subscribed → the call summary, and call_first_audio_slow
 *     when it took FIRST_AUDIO_SLOW_MS or more;
 *   - one-way audio, inbound (we can't hear them): an unmuted, subscribed
 *     remote mic whose inbound packet count stays flat for 15 s of continuous
 *     observation (callSummary.InboundAudioStallDetector) → call_one_way_audio
 *     {in, cause, sfu_hears, other_flowing} + the audio_in_stall call event;
 *   - peers_max: remote participant COUNT;
 *   - mic / camera acquisition failures (LiveKit's MediaDevicesError) →
 *     mic_failed / camera_failed with the DOMException name.
 *
 * Participants are only ever map keys (the participant / track OBJECT, in a
 * WeakMap) — no identity, SID or name is read into anything that is sent.
 */
import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, Track, ConnectionState, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { isBetaActive, reportBeta } from '../../utils/betaDiagnostics/reporter';
import { getActiveCallSummary, noteBetaPeers } from '../../utils/betaDiagnostics/callSession';
import { InboundAudioStallDetector, type InboundAudioReading } from '../../utils/betaDiagnostics/callSummary';
import { errorNameOf } from '../../utils/betaDiagnostics/sanitize';
import { logCallEvent } from '../../utils/callEventLog';

export const FIRST_AUDIO_SLOW_MS = 3_000;
const STALL_POLL_MS = 5_000;
const MAX_STALL_TRACKS = 8;
const MAX_OTHER_TRACKS = 3;

/**
 * Packets received on a peer's OTHER subscribed tracks (camera, share video,
 * share audio), summed, or undefined when it has none. Only ever compared with
 * itself across polls: "did anything else from this peer keep arriving while the
 * mic's packets stood still". Capped so a busy peer cannot make the poll heavy.
 */
async function otherPacketsOf(p: RemoteParticipant, mic: RemoteTrackPublication): Promise<number | undefined> {
    let sum: number | undefined;
    let n = 0;
    for (const pub of p.trackPublications.values()) {
        if (pub === mic || !pub.isSubscribed || !pub.track || n >= MAX_OTHER_TRACKS) continue;
        n++;
        try {
            (await (pub.track as RemoteTrack).getRTCStatsReport())?.forEach((s: Record<string, unknown>) => {
                if (s.type === 'inbound-rtp' && typeof s.packetsReceived === 'number') sum = (sum ?? 0) + s.packetsReceived;
            });
        } catch { /* closing */ }
    }
    return sum;
}

export function BetaCallMonitor(): null {
    const room = useRoomContext();

    useEffect(() => {
        if (!room) return;
        const now = () => Date.now();
        let connectedAt: number | null = room.state === ConnectionState.Connected ? now() : null;
        const joinedAt = new WeakMap<object, number>();
        const heardFrom = new WeakSet<object>();
        let firstAudioDone = false;
        let slowReported = false;
        const detector = new InboundAudioStallDetector();

        const onConnected = () => { if (connectedAt === null) connectedAt = now(); noteBetaPeers(room.remoteParticipants.size); };
        const onParticipant = (p: RemoteParticipant) => {
            joinedAt.set(p, now());
            noteBetaPeers(room.remoteParticipants.size);
        };
        const onSubscribed = (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
            try {
                if (track.kind !== Track.Kind.Audio || pub.source !== Track.Source.Microphone || connectedAt === null) return;
                // Only a participant's FIRST mic subscription is "time to first
                // audio". A re-subscription (their mic republished after a device
                // switch, or their app crashed and rejoined under the same
                // participant object) measured from their original join is not a
                // delay: staging.174's call_first_audio_slow {ms: 283616} was the
                // sharer's renderer crash + rejoin, 4.7 min after they first joined.
                if (heardFrom.has(p)) return;
                heardFrom.add(p);
                const since = Math.max(connectedAt, joinedAt.get(p) ?? connectedAt);
                const ms = Math.max(0, now() - since);
                if (!firstAudioDone) { firstAudioDone = true; getActiveCallSummary()?.noteFirstAudio(ms); }
                if (ms >= FIRST_AUDIO_SLOW_MS && !slowReported) {
                    slowReported = true;
                    reportBeta('call_first_audio_slow', { ms });
                }
            } catch { /* diagnostics only */ }
        };
        const onMediaError = (err: Error, kind?: MediaDeviceKind) => {
            try {
                if (!isBetaActive()) return;
                const name = errorNameOf(err);
                const detail = { stage: 'acquire', ...(name ? { name } : {}) };
                if (kind === 'videoinput') reportBeta('camera_failed', detail);
                else if (kind === 'audioinput') reportBeta('mic_failed', detail);
                else reportBeta('mic_failed', { ...detail, kind: 'unknown' });
            } catch { /* diagnostics only */ }
        };

        room.on(RoomEvent.Connected, onConnected);
        room.on(RoomEvent.ParticipantConnected, onParticipant);
        room.on(RoomEvent.TrackSubscribed, onSubscribed);
        room.on(RoomEvent.MediaDevicesError, onMediaError);

        let busy = false;
        const poll = async () => {
            if (busy || !isBetaActive() || room.state !== ConnectionState.Connected) return;
            busy = true;
            try {
                const readings: InboundAudioReading[] = [];
                for (const p of [...room.remoteParticipants.values()].slice(0, MAX_STALL_TRACKS)) {
                    const pub = p.getTrackPublication(Track.Source.Microphone);
                    const track = pub?.track;
                    if (!pub?.isSubscribed || !track) continue;
                    let packets = 0;
                    try {
                        (await track.getRTCStatsReport())?.forEach((s: Record<string, unknown>) => {
                            if (s.type === 'inbound-rtp' && s.kind === 'audio' && typeof s.packetsReceived === 'number') packets = s.packetsReceived;
                        });
                    } catch { continue; }
                    readings.push({
                        ref: track,
                        unmuted: !pub.isMuted,
                        packetsReceived: packets,
                        sfuSpeaking: !!p.isSpeaking,
                        otherPackets: await otherPacketsOf(p, pub),
                    });
                }
                const stalled = detector.update(readings, now());
                if (stalled) {
                    reportBeta('call_one_way_audio', { direction: 'in', cause: 'rtp_flat', sfu_hears: stalled.sfuHears, other_flowing: stalled.otherFlowing });
                    logCallEvent('audio_in_stall', { cause: 'rtp_flat', sfu_hears: stalled.sfuHears, other_flowing: stalled.otherFlowing });
                }
            } catch { /* diagnostics only */ } finally {
                busy = false;
            }
        };
        const iv = setInterval(() => { void poll(); }, STALL_POLL_MS);

        return () => {
            clearInterval(iv);
            room.off(RoomEvent.Connected, onConnected);
            room.off(RoomEvent.ParticipantConnected, onParticipant);
            room.off(RoomEvent.TrackSubscribed, onSubscribed);
            room.off(RoomEvent.MediaDevicesError, onMediaError);
        };
    }, [room]);

    return null;
}

export default BetaCallMonitor;
