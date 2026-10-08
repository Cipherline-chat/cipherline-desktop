/**
 * LiveKit Room → TrackStatsInput[] for the WebRTC ring (webrtcRing.ts).
 *
 * Structurally typed against the few livekit-client members it reads so it can
 * be unit-tested with fake rooms. What it reads per publication: the SOURCE
 * enum (camera / microphone / screen_share / screen_share_audio), the track
 * kind, and the track object's own getRTCStatsReport(). It never reads a SID,
 * a participant identity or name, or a track name — the ring names tracks by
 * role at capture time.
 */
import type { StatsReportLike, TrackStatsInput } from './webrtcRing';
import type { OutboundTrackStats } from './reportTypes';

export interface StatsTrackLike {
    kind?: string;
    getRTCStatsReport?: () => Promise<unknown>;
    sender?: { getParameters?: () => { encodings?: Array<{ active?: boolean; maxFramerate?: number; maxBitrate?: number }> } } | undefined;
}
export interface PublicationLike {
    source?: string;
    kind?: string;
    track?: StatsTrackLike | null;
    isSubscribed?: boolean;
}
export interface ParticipantLike {
    trackPublications: { forEach(cb: (pub: PublicationLike) => void): void };
}
export interface RoomLike {
    localParticipant?: ParticipantLike | null;
    remoteParticipants?: { forEach(cb: (p: ParticipantLike) => void): void } | null;
}

const SOURCES: readonly OutboundTrackStats['source'][] = ['screen_share', 'screen_share_audio', 'camera', 'microphone', 'unknown'];
const asSource = (s: unknown): OutboundTrackStats['source'] =>
    (SOURCES as readonly unknown[]).includes(s) ? s as OutboundTrackStats['source'] : 'unknown';
const kindOf = (pub: PublicationLike): 'video' | 'audio' | null => {
    const k = pub.kind ?? pub.track?.kind;
    return k === 'video' || k === 'audio' ? k : null;
};

function senderCaps(track: StatsTrackLike): { maxFramerate?: number; maxBitrate?: number } {
    try {
        const encs = track.sender?.getParameters?.()?.encodings ?? [];
        let fps: number | undefined;
        let br: number | undefined;
        for (const e of encs) {
            if (e.active === false) continue;
            if (typeof e.maxFramerate === 'number') fps = Math.max(fps ?? 0, e.maxFramerate);
            if (typeof e.maxBitrate === 'number') br = (br ?? 0) + e.maxBitrate;
        }
        return { maxFramerate: fps, maxBitrate: br };
    } catch {
        return {};
    }
}

export interface GatherOptions {
    /** The user's chosen screen-share fps (ScreenShareSession.requestedFps). */
    screenShareTargetFps?: number;
    maxInbound?: number;
}

/**
 * One getStats() per published / subscribed track, in parallel. A track whose
 * stats call fails (ended between polls) is skipped, never fatal.
 */
export async function gatherTrackStats(room: RoomLike, opts: GatherOptions = {}): Promise<TrackStatsInput[]> {
    const jobs: Array<Promise<TrackStatsInput | null>> = [];
    const statsOf = async (track: StatsTrackLike): Promise<StatsReportLike | null> => {
        try {
            const r = await track.getRTCStatsReport?.();
            return r && typeof (r as { forEach?: unknown }).forEach === 'function' ? r as StatsReportLike : null;
        } catch {
            return null;
        }
    };

    room.localParticipant?.trackPublications.forEach(pub => {
        const track = pub.track;
        const kind = kindOf(pub);
        if (!track || !kind || typeof track.getRTCStatsReport !== 'function') return;
        const source = asSource(pub.source);
        jobs.push((async () => {
            const report = await statsOf(track);
            if (!report) return null;
            const caps = kind === 'video' ? senderCaps(track) : {};
            const targetFps = source === 'screen_share' ? (opts.screenShareTargetFps ?? caps.maxFramerate) : caps.maxFramerate;
            return { ref: track, direction: 'outbound', kind, source, report, targetFps, maxBitrateBps: caps.maxBitrate } satisfies TrackStatsInput;
        })());
    });

    const remote: Array<{ track: StatsTrackLike; kind: 'video' | 'audio' }> = [];
    room.remoteParticipants?.forEach(p => {
        p.trackPublications.forEach(pub => {
            const kind = kindOf(pub);
            if (!pub.track || !kind || pub.isSubscribed === false || typeof pub.track.getRTCStatsReport !== 'function') return;
            remote.push({ track: pub.track, kind });
        });
    });
    // Video first: it is what a quality report is usually about.
    remote.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1));
    for (const { track, kind } of remote.slice(0, opts.maxInbound ?? 8)) {
        jobs.push((async () => {
            const report = await statsOf(track);
            return report ? { ref: track, direction: 'inbound', kind, report } satisfies TrackStatsInput : null;
        })());
    }

    const results = await Promise.all(jobs);
    return results.filter((r): r is TrackStatsInput => r !== null);
}
