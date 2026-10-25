/**
 * ShareAvSync — inside <LiveKitRoom>: keeps each watched remote SCREEN SHARE's
 * video in step with that share's audio by delaying the VIDEO
 * (utils/shareAvSync.ts). Renders nothing.
 *
 * Only a participant whose screen_share AND screen_share_audio are both
 * subscribed is considered; the stats are the two share receivers'. Nothing
 * here ever reads or touches a microphone or camera receiver.
 */
import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { estimateAvSync, type AvSyncSnapshot, type StatsEntry } from '../../utils/avSync';
import { ShareAvSyncController, applyShareVideoDelay, SAMPLE_MS, type PublicationLike } from '../../utils/shareAvSync';
import { getRemotePlaybackInfo } from '../../hooks/useParticipantAudio';
import { slotFor } from '../../utils/avSyncMonitor';
import { logCallEvent } from '../../utils/callEventLog';

interface StatsTrack { getRTCStatsReport?: () => Promise<unknown> }
type Pub = PublicationLike & { track?: (StatsTrack & { receiver?: unknown }) | null; isSubscribed?: boolean };
interface ParticipantLike { identity: string; getTrackPublication(source: Track.Source): Pub | undefined }

async function statsOf(t: StatsTrack | null | undefined): Promise<Iterable<StatsEntry> | null> {
    try { return ((await t?.getRTCStatsReport?.()) as Iterable<StatsEntry> | undefined) ?? null; } catch { return null; }
}

export function ShareAvSync(): null {
    const room = useRoomContext();
    useEffect(() => {
        if (!room) return;
        const ctl = new Map<string, { c: ShareAvSyncController; prev: AvSyncSnapshot | null; video: Pub }>();
        let busy = false;
        const tick = async () => {
            if (busy) return;
            busy = true;
            try {
                const live = new Set<string>();
                for (const p of [...room.remoteParticipants.values()] as unknown as ParticipantLike[]) {
                    const video = p.getTrackPublication(Track.Source.ScreenShare);
                    const audio = p.getTrackPublication(Track.Source.ScreenShareAudio);
                    if (!video?.track || !audio?.track || video.isSubscribed === false || audio.isSubscribed === false) continue;
                    const playback = getRemotePlaybackInfo(p.identity, 'screen');
                    if (!playback) continue;
                    live.add(p.identity);
                    let st = ctl.get(p.identity);
                    if (!st || st.video !== video) {
                        st = { c: new ShareAvSyncController(), prev: null, video };
                        ctl.set(p.identity, st);
                    }
                    const [a, v] = await Promise.all([statsOf(audio.track), statsOf(video.track)]);
                    if (!a || !v) continue;
                    const { estimate, snapshot } = estimateAvSync(a, v, playback, st.prev);
                    st.prev = snapshot;
                    if (!estimate) continue;
                    const target = st.c.observe({
                        audioPathMs: estimate.audioPathMs,
                        decodeMs: estimate.parts.decodeMs,
                        renderMs: estimate.parts.renderMs,
                    }, performance.now());
                    if (target === null) continue;
                    if (applyShareVideoDelay(video, target)) {
                        const slot = slotFor(p.identity); // 'remote-av-N' placeholder, never the identity
                        logCallEvent('av_sync_applied', {
                            slot,
                            target_ms: target,
                            offset_ms: Math.round(estimate.offsetMs),
                            audio_path_ms: Math.round(estimate.audioPathMs),
                            video_path_ms: Math.round(estimate.videoPathMs),
                        });
                    }
                }
                for (const id of [...ctl.keys()]) if (!live.has(id)) ctl.delete(id);
            } catch { /* sync is best-effort; never break the call */ } finally {
                busy = false;
            }
        };
        const iv = setInterval(() => { void tick(); }, SAMPLE_MS);
        return () => { clearInterval(iv); };
    }, [room]);
    return null;
}
