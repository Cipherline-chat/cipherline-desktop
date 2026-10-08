/**
 * Video-freeze detection for the "Prioritize call video while gaming" offer.
 *
 * Fed one WebRTC stats sample per video stream per tick (CallPane's
 * GamingVideoGuard samples ~1/s, and ONLY while the window is in the
 * background, the mode is off and an offer is still allowed — so in normal use
 * it costs nothing). Decides whether a stream has REALLY frozen for a reason
 * the mode can help with: Cipherline's own capture / encode / decode being
 * starved while another app (a game) has the machine.
 *
 * What counts:
 *   - OUTGOING camera: `framesSent` (summed over the simulcast encodings) has
 *     not advanced for FREEZE_MS while the camera is published and not muted.
 *     Capture-side stalls count too — a camera that stops delivering frames
 *     while a game runs is exactly the symptom being reported.
 *   - OUTGOING screen share: `framesSent` stalled WHILE frames were still
 *     reaching WebRTC from the capturer (media-source `frames` advanced).
 *     A capturer that delivers nothing is just a static screen (DXGI / WGC
 *     hand over no frame when nothing changed), not a freeze.
 *   - INCOMING video: `framesDecoded` stalled WHILE media kept arriving
 *     (`bytesReceived` advanced) with low packet loss. Bytes arriving but no
 *     frames coming out is local decode starvation.
 *
 * What is explained away (never a freeze):
 *   - the stream is not eligible: muted / camera off, paused at the SFU (ours:
 *     utils/remoteVideoDemand.ts; theirs: stream state paused), unsubscribed,
 *     track ended — the caller marks those `eligible: false`, which also resets
 *     the stream's history so the resume ramp is not mistaken for a freeze;
 *   - the stream has not produced a single frame since it became eligible
 *     (start-up / keyframe wait);
 *   - outgoing: the encoder reports `qualityLimitationReason: 'bandwidth'`
 *     at any point in the stall (network, not this machine);
 *   - incoming: no bytes arrived during the stall (the sender stopped, the
 *     network dropped it, or the remote side paused — nothing local to fix),
 *     or loss over MAX_INBOUND_LOSS (frames are undecodable, not starved),
 *     or an E2EE decryption error was seen during the stall (frames dropped
 *     by the cryptor, not by a starved decoder);
 *   - the window was in the FOREGROUND at any point during the stall: the
 *     offer is about gaming, and a freeze while the user is looking at
 *     Cipherline is a different problem.
 *
 * Privacy: stream keys are opaque local ids chosen by the caller; nothing
 * here knows or records who is in the call, and nothing leaves the device.
 */

/** A stall at least this long, with the stream live, is a freeze. */
export const FREEZE_MS = 2500;
/** Above this share of packets lost during the stall, incoming video is a network problem. */
export const MAX_INBOUND_LOSS = 0.05;
/** How often the guard samples while it is sampling at all. */
export const SAMPLE_INTERVAL_MS = 1000;

export type VideoStreamKind = 'camera' | 'screen';

export interface OutboundVideoSample {
    direction: 'out';
    /** Opaque, stable for the life of the stream. */
    key: string;
    kind: VideoStreamKind;
    /** Published, not muted by the user, track live. */
    eligible: boolean;
    /** Sum of `framesSent` across the stream's encodings. */
    framesSent: number;
    /** Sum of media-source `frames` — frames delivered by the capturer; undefined if not reported. */
    sourceFrames?: number;
    /** Any encoding reported qualityLimitationReason === 'bandwidth'. */
    bandwidthLimited: boolean;
}

export interface InboundVideoSample {
    direction: 'in';
    key: string;
    kind: VideoStreamKind;
    /** Subscribed, enabled (not paused), not muted, stream state active. */
    eligible: boolean;
    framesDecoded: number;
    bytesReceived: number;
    packetsReceived: number;
    packetsLost: number;
}

export type VideoStreamSample = OutboundVideoSample | InboundVideoSample;

export interface FreezeTickContext {
    /** Monotonic ms. */
    at: number;
    /** Cipherline is not the focused, visible window. */
    backgrounded: boolean;
    /** An E2EE decryption error was reported since the previous tick. */
    decryptError: boolean;
}

export interface VideoFreezeEvent {
    at: number;
    direction: 'out' | 'in';
    kind: VideoStreamKind;
    stalledMs: number;
}

interface StreamState {
    frames: number;
    /** When frames last advanced (or when tracking began). */
    progressAt: number;
    /** Frames have advanced at least once since the stream became eligible. */
    hasProgressed: boolean;
    /** Counters captured when the current stall began. */
    stallStart: { bytes: number; packetsReceived: number; packetsLost: number; sourceFrames?: number };
    bandwidthDuringStall: boolean;
    decryptErrorDuringStall: boolean;
    foregroundDuringStall: boolean;
    reported: boolean;
}

const framesOf = (s: VideoStreamSample): number => (s.direction === 'out' ? s.framesSent : s.framesDecoded);

const snapshot = (s: VideoStreamSample): StreamState['stallStart'] => s.direction === 'out'
    ? { bytes: 0, packetsReceived: 0, packetsLost: 0, sourceFrames: s.sourceFrames }
    : { bytes: s.bytesReceived, packetsReceived: s.packetsReceived, packetsLost: s.packetsLost };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function validSample(s: VideoStreamSample): boolean {
    if (s.direction === 'out') return finite(s.framesSent);
    return finite(s.framesDecoded) && finite(s.bytesReceived) && finite(s.packetsReceived) && finite(s.packetsLost);
}

export class VideoFreezeDetector {
    private readonly streams = new Map<string, StreamState>();

    /** Forget everything (window came back to the foreground, call ended). */
    reset(): void {
        this.streams.clear();
    }

    /**
     * Feed one tick. Streams absent from `samples` are forgotten (unpublished,
     * unsubscribed, or not sampled this tick). Returns the freezes that BEGAN
     * qualifying on this tick — at most one per stall per stream.
     */
    observe(samples: readonly VideoStreamSample[], ctx: FreezeTickContext): VideoFreezeEvent[] {
        const seen = new Set<string>();
        const events: VideoFreezeEvent[] = [];
        for (const s of samples) {
            if (!s || typeof s.key !== 'string' || seen.has(s.key)) continue;
            seen.add(s.key);
            if (!s.eligible || !validSample(s)) { this.streams.delete(s.key); continue; }
            const frames = framesOf(s);
            const st = this.streams.get(s.key);
            if (!st || frames < st.frames) {
                // New, or the counter went backwards (a new sender / receiver): start over.
                this.streams.set(s.key, fresh(frames, ctx.at, s, false));
                continue;
            }
            if (frames > st.frames) {
                this.streams.set(s.key, fresh(frames, ctx.at, s, true));
                continue;
            }
            // Stalled this tick.
            if (s.direction === 'out' && s.bandwidthLimited) st.bandwidthDuringStall = true;
            if (ctx.decryptError) st.decryptErrorDuringStall = true;
            if (!ctx.backgrounded) st.foregroundDuringStall = true;
            const stalledMs = ctx.at - st.progressAt;
            if (st.reported || !st.hasProgressed || stalledMs < FREEZE_MS) continue;
            if (!ctx.backgrounded || st.foregroundDuringStall) continue;
            if (!unexplained(s, st)) continue;
            st.reported = true;
            events.push({ at: ctx.at, direction: s.direction, kind: s.kind, stalledMs });
        }
        for (const key of [...this.streams.keys()]) if (!seen.has(key)) this.streams.delete(key);
        return events;
    }
}

function fresh(frames: number, at: number, s: VideoStreamSample, hasProgressed: boolean): StreamState {
    return {
        frames,
        progressAt: at,
        hasProgressed,
        stallStart: snapshot(s),
        bandwidthDuringStall: false,
        decryptErrorDuringStall: false,
        foregroundDuringStall: false,
        reported: false,
    };
}

/** True when nothing but local starvation explains the stall. */
function unexplained(s: VideoStreamSample, st: StreamState): boolean {
    if (s.direction === 'out') {
        if (st.bandwidthDuringStall) return false;
        if (s.kind === 'screen') {
            // Only a share whose capturer kept delivering is frozen by US.
            const before = st.stallStart.sourceFrames;
            return finite(before) && finite(s.sourceFrames) && s.sourceFrames > before;
        }
        return true;
    }
    if (st.decryptErrorDuringStall) return false;
    if (!(s.bytesReceived > st.stallStart.bytes)) return false;
    const recv = Math.max(0, s.packetsReceived - st.stallStart.packetsReceived);
    const lost = Math.max(0, s.packetsLost - st.stallStart.packetsLost);
    if (recv + lost === 0) return false;
    return lost / (recv + lost) <= MAX_INBOUND_LOSS;
}

// ── Stats extraction (one RTCStatsReport per track) ────────────────────────

/** Anything iterable as RTCStatsReport.values() yields. */
type StatsLike = { forEach(cb: (stat: Record<string, unknown>) => void): void };

const num = (v: unknown): number => (finite(v) ? v : 0);

/**
 * From a LOCAL video track's sender report (LocalVideoTrack.getRTCStatsReport):
 * framesSent summed over every video outbound-rtp (simulcast layers), the
 * capturer's delivered frames from media-source, and whether any layer is
 * bandwidth-limited. null when the report has no video outbound-rtp.
 */
export function outboundCountersFromReport(report: StatsLike | null | undefined):
    { framesSent: number; sourceFrames?: number; bandwidthLimited: boolean } | null {
    if (!report) return null;
    let found = false;
    let framesSent = 0;
    let bandwidthLimited = false;
    let sourceFrames: number | undefined;
    report.forEach(stat => {
        if (!stat || typeof stat !== 'object') return;
        if (stat.type === 'outbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) {
            found = true;
            framesSent += num(stat.framesSent);
            if (stat.qualityLimitationReason === 'bandwidth') bandwidthLimited = true;
        } else if (stat.type === 'media-source' && stat.kind === 'video' && finite(stat.frames)) {
            sourceFrames = (sourceFrames ?? 0) + stat.frames;
        }
    });
    if (!found) return null;
    return sourceFrames === undefined ? { framesSent, bandwidthLimited } : { framesSent, sourceFrames, bandwidthLimited };
}

/** From a REMOTE video track's receiver report (RemoteVideoTrack.getRTCStatsReport). */
export function inboundCountersFromReport(report: StatsLike | null | undefined):
    { framesDecoded: number; bytesReceived: number; packetsReceived: number; packetsLost: number } | null {
    if (!report) return null;
    let found = false;
    const out = { framesDecoded: 0, bytesReceived: 0, packetsReceived: 0, packetsLost: 0 };
    report.forEach(stat => {
        if (!stat || typeof stat !== 'object') return;
        if (stat.type === 'inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) {
            found = true;
            out.framesDecoded += num(stat.framesDecoded);
            out.bytesReceived += num(stat.bytesReceived);
            out.packetsReceived += num(stat.packetsReceived);
            // packetsLost can be negative (duplicates); never let it subtract.
            out.packetsLost += Math.max(0, num(stat.packetsLost));
        }
    });
    return found ? out : null;
}
