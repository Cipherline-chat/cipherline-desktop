/**
 * CallEventMonitor — feeds utils/callEventLog.ts with what the call's own
 * stats say, every 2 s, inside <LiveKitRoom> (CallPane). Renders nothing.
 *
 *   - call_join / call_leave / participants: COUNTS only;
 *   - reconnecting / reconnected;
 *   - ice_route: per peer connection, the selected candidate pair's local and
 *     remote candidate TYPES (host / srflx / prflx / relay), whether TURN is
 *     in use and its transport — never an address or port;
 *   - quality_limitation: our camera / share encoder's reason transitions
 *     (none ↔ cpu / bandwidth / other) with how long the previous one lasted;
 *   - dynacast_layers: which of our simulcast encodings are running;
 *   - freeze_start / freeze_end: a remote video that is subscribed, enabled
 *     and was decoding stops decoding (and later resumes, with the duration);
 *   - e2ee_decrypt_error: LiveKit's frame cryptor failed to decrypt a peer's
 *     frame (reason enum only — the SDK's message can carry an identity).
 *     Already throttled by the SDK (≤ 1/s, ≤ 5/min per cryptor) and coalesced
 *     here. A steady trickle with freezes = frames dropped before the decoder
 *     (see utils/e2eeAnnexB.ts).
 *
 * Tracks are named by placeholder (self-camera, remote-video-1, …) — see
 * callEventLog.trackPlaceholder. Nothing here is sent anywhere.
 */
import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, Track, RemoteVideoTrack, type Room } from 'livekit-client';
import { logCallEvent, markCallStart, markCallEnd, trackPlaceholder } from '../../utils/callEventLog';
import { resetAvSyncMonitor } from '../../utils/avSyncMonitor';
import { iceRouteFromStats, layerStateString, type StatsLike } from '../../utils/callEventStats';
import { decryptErrorReason } from '../../utils/e2eeWorkerStats';

interface PcLike { getStats(): Promise<StatsLike> }

function peerConnections(room: Room): { name: string; pc: PcLike }[] {
    const mgr = (room as unknown as { engine?: { pcManager?: { publisher?: { getStats(): Promise<StatsLike> }; subscriber?: { getStats(): Promise<StatsLike> } } } }).engine?.pcManager;
    const out: { name: string; pc: PcLike }[] = [];
    if (mgr?.publisher) out.push({ name: 'publisher', pc: mgr.publisher });
    if (mgr?.subscriber) out.push({ name: 'subscriber', pc: mgr.subscriber });
    return out;
}

export const CallEventMonitor: React.FC = () => {
    const room = useRoomContext();

    useEffect(() => {
        if (!room) return;
        markCallStart();
        resetAvSyncMonitor(); // A/V-sync placeholders (remote-av-N) are per call too
        const count = () => room.remoteParticipants.size + 1;
        logCallEvent('call_join', { participants: count() });
        const onCount = () => logCallEvent('participants', { count: count() });
        const onReconnecting = () => logCallEvent('reconnecting');
        const onReconnected = () => { logCallEvent('reconnected'); ice.clear(); };
        room.on(RoomEvent.ParticipantConnected, onCount);
        room.on(RoomEvent.ParticipantDisconnected, onCount);
        room.on(RoomEvent.Reconnecting, onReconnecting);
        room.on(RoomEvent.Reconnected, onReconnected);
        const onDecryptError = (err: unknown) => logCallEvent('e2ee_decrypt_error', { reason: decryptErrorReason(err) });
        room.on(RoomEvent.EncryptionError, onDecryptError);

        const ice = new Map<string, string>();
        const qlr = new Map<string, { reason: string; since: number }>();
        const layers = new Map<string, string>();
        const decode = new Map<string, { frames: number; frozenSince: number | null }>();
        let busy = false;

        const sample = async () => {
            if (busy) return;
            busy = true;
            try {
                const now = performance.now();
                for (const { name, pc } of peerConnections(room)) {
                    try {
                        const route = iceRouteFromStats(await pc.getStats());
                        if (!route) continue;
                        const key = `${route.local}/${route.remote}/${route.protocol}`;
                        if (ice.get(name) !== key) {
                            ice.set(name, key);
                            logCallEvent('ice_route', { pc: name, type: route.relay ? 'relay' : route.local, local: route.local, remote: route.remote, turn: route.relay, protocol: route.protocol });
                        }
                    } catch { /* pc closing */ }
                }
                // Our encoders.
                for (const [source, label] of [[Track.Source.Camera, 'self-camera'], [Track.Source.ScreenShare, 'self-screen']] as const) {
                    const pub = room.localParticipant.getTrackPublication(source);
                    const sender = (pub?.track as { sender?: RTCRtpSender } | undefined)?.sender;
                    if (!sender || pub?.isMuted) { qlr.delete(label); layers.delete(label); continue; }
                    const ls = layerStateString(sender.getParameters().encodings);
                    if (ls && layers.get(label) !== ls) {
                        if (layers.has(label)) logCallEvent('dynacast_layers', { track: label, layers: ls });
                        layers.set(label, ls);
                    }
                    let reason = 'none';
                    let topArea = -1;
                    (await sender.getStats()).forEach((s: Record<string, unknown>) => {
                        if (s.type !== 'outbound-rtp' || s.kind !== 'video' || s.active === false) return;
                        const a = (Number(s.frameWidth) || 0) * (Number(s.frameHeight) || 0);
                        if (a > topArea && typeof s.qualityLimitationReason === 'string') { topArea = a; reason = s.qualityLimitationReason; }
                    });
                    const prev = qlr.get(label);
                    if (!prev) qlr.set(label, { reason, since: now });
                    else if (prev.reason !== reason) {
                        logCallEvent('quality_limitation', { track: label, from: prev.reason, to: reason, prev_seconds: Math.round((now - prev.since) / 1000) });
                        qlr.set(label, { reason, since: now });
                    }
                }
                // Remote video freezes.
                const seen = new Set<string>();
                for (const p of room.remoteParticipants.values()) {
                    for (const source of [Track.Source.Camera, Track.Source.ScreenShare]) {
                        const pub = p.getTrackPublication(source);
                        const track = pub?.track;
                        if (!pub?.isSubscribed || !pub.isEnabled || pub.isMuted || !(track instanceof RemoteVideoTrack)) continue;
                        seen.add(pub.trackSid);
                        let frames = 0;
                        (await track.getRTCStatsReport())?.forEach((s: Record<string, unknown>) => {
                            if (s.type === 'inbound-rtp' && s.kind === 'video' && typeof s.framesDecoded === 'number') frames = s.framesDecoded;
                        });
                        const st = decode.get(pub.trackSid);
                        const name = trackPlaceholder(pub.trackSid, source === Track.Source.Camera ? 'remote-video' : 'remote-screen');
                        if (!st) { decode.set(pub.trackSid, { frames, frozenSince: null }); continue; }
                        if (frames === st.frames && frames > 0 && st.frozenSince === null) {
                            st.frozenSince = now;
                            logCallEvent('freeze_start', { track: name });
                        } else if (frames !== st.frames && st.frozenSince !== null) {
                            logCallEvent('freeze_end', { track: name, ms: Math.round(now - st.frozenSince) });
                            st.frozenSince = null;
                        }
                        st.frames = frames;
                    }
                }
                for (const sid of [...decode.keys()]) if (!seen.has(sid)) decode.delete(sid);
            } finally {
                busy = false;
            }
        };
        const iv = setInterval(() => { void sample().catch(() => {}); }, 2000);
        return () => {
            clearInterval(iv);
            room.off(RoomEvent.ParticipantConnected, onCount);
            room.off(RoomEvent.ParticipantDisconnected, onCount);
            room.off(RoomEvent.Reconnecting, onReconnecting);
            room.off(RoomEvent.Reconnected, onReconnected);
            room.off(RoomEvent.EncryptionError, onDecryptError);
            logCallEvent('call_leave', { participants: count() });
            markCallEnd();
            resetAvSyncMonitor();
        };
    }, [room]);

    return null;
};

export default CallEventMonitor;
