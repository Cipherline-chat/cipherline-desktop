/**
 * Remote A/V sync: which path a remote participant's audio plays through, how
 * much latency that path adds, and a getStats()-based estimate of how far the
 * audio we play is from the video we show.
 *
 * ── Why this exists (measured, 2026-10, branch claude/av-sync) ───────────────
 * LiveKit (server defaults, no `syncStreams`) gives every subscribed track its
 * own MediaStream id (msid `PA_x|TR_y`), so Chromium puts a participant's audio
 * and video in DIFFERENT sync groups and never lip-syncs them: each plays out
 * as soon as its own jitter buffer allows. Whatever latency one side has and
 * the other doesn't shows up 1:1 as A/V offset.
 *
 * The receive side used to play every remote voice through Web Audio
 * (track → muted <audio> element → MediaStreamAudioSourceNode → gain →
 * master gain → limiter → destination). Compared with the plain WebRTC
 * <audio> element path that costs, per Chromium's implementation and the
 * clapper harness:
 *   - the MediaStreamAudioSourceNode FIFO (blink WebAudioMediaStreamAudioSink):
 *     up to 6 device buffers (60 ms on a 10 ms device), never drained once
 *     filled — measured 15–90 ms, random per chain build;
 *   - the context's own render buffer (baseLatency, ~10 ms);
 *   - the master limiter's fixed 6 ms look-ahead (Chromium DynamicsCompressor);
 *   - +30 ms more when per-user noise suppression is on (NS ring prebuffer
 *     20 ms + one 10 ms RNNoise frame).
 * Measured: +31…+105 ms over the element path (in-page, fake audio device),
 * +38 ms median on a PulseAudio sink (both paths into one sink, ground truth).
 * All of it is audio-only, so all of it is audio-behind-video.
 *
 * So remote audio now plays through the plain element whenever nothing in the
 * Web Audio graph is needed (no per-user NS, combined volume ≤ 100 %), and
 * only falls back to Web Audio for a boost above 100 % or per-user NS.
 *
 * Kept free of React/LiveKit/DOM so it is unit-testable in vitest's node env.
 */
import { PREBUFFER_SAMPLES, RNNOISE_FRAME } from '../audio/nsKernel';

// ── Latency model constants ──────────────────────────────────────────────────

/** Chromium's DynamicsCompressorNode look-ahead (fixed pre-delay) — the
 *  master limiter. Measured with an impulse through an OfflineAudioContext. */
export const LIMITER_LOOKAHEAD_MS = 6;

/** Remote per-user NS ring: 20 ms prebuffer + one 480-sample frame, 48 kHz. */
export const NS_RING_LATENCY_MS = ((PREBUFFER_SAMPLES + RNNOISE_FRAME) / 48000) * 1000;

/**
 * MediaStreamAudioSourceNode FIFO: its fill level is not observable from JS.
 * It is bounded by 6 device buffers (60 ms on a 10 ms Windows/WASAPI device)
 * and settles anywhere in 0…max per chain build; 30 ms is the middle of that
 * range, with ±30 ms of honest uncertainty that the overlay shows.
 */
export const MSS_FIFO_ESTIMATE_MS = 30;
export const MSS_FIFO_UNCERTAINTY_MS = 30;

/**
 * Receive → display beyond the jitter buffer and the decoder: render
 * scheduling + compositor. Measured in the harness as rVFC
 * expectedDisplayTime − receiveTime − jitter buffer − decode ≈ 30 ms.
 */
export const VIDEO_RENDER_DELAY_MS = 30;

/**
 * ITU-R BT.1359 detectability: audio leading by more than ~45 ms or lagging
 * by more than ~125 ms is noticeable. Sign convention everywhere in this
 * module: offset > 0 = audio plays AFTER the matching video (audio late).
 */
export const AUDIO_LEAD_LIMIT_MS = 45;
export const AUDIO_LAG_LIMIT_MS = 125;

// ── Playback path ────────────────────────────────────────────────────────────

export type PlaybackPath = 'element' | 'webaudio';

/** Linear gain above which the element path can't reproduce the volume
 *  (HTMLMediaElement.volume tops out at 1). Small epsilon for float noise. */
const UNITY = 1 + 1e-6;

/**
 * Which path a remote audio track should play through. The element path is
 * the low-latency default; Web Audio only when something in its graph is
 * actually needed:
 *   - per-user noise suppression (an AudioWorklet), or
 *   - a combined (per-user × master) gain above unity — an element can't boost.
 */
export function choosePlaybackPath(o: { nsEnabled: boolean; perUserGain: number; masterGain: number }): PlaybackPath {
    if (o.nsEnabled) return 'webaudio';
    const g = o.perUserGain * o.masterGain;
    if (!Number.isFinite(g) || g > UNITY) return 'webaudio';
    return 'element';
}

/** HTMLMediaElement.volume for the element path: per-user × master, clamped
 *  to [0, 1]; 0 when silenced (local mute, deafen, screen-share mute). */
export function elementVolumeFor(perUserGain: number, masterGain: number, silenced: boolean): number {
    if (silenced) return 0;
    const g = perUserGain * masterGain;
    if (!Number.isFinite(g) || g <= 0) return 0;
    return Math.min(1, g);
}

export interface PlaybackInfo {
    path: PlaybackPath;
    nsEnabled: boolean;
    /** AudioContext.baseLatency, seconds (Web Audio path). */
    baseLatency?: number;
    /** AudioContext.outputLatency, seconds (Web Audio path). */
    outputLatency?: number;
}

/**
 * Latency from the jitter buffer's output to the speaker for the path in use.
 * Element path: Chromium's own device delay for the WebRTC renderer
 * (media-playout totalPlayoutDelay), falling back to the context's output
 * latency when the browser doesn't report it. Web Audio path: FIFO estimate
 * + context render buffer + output latency + limiter (+ NS ring).
 */
export function outputPathMs(p: PlaybackInfo, elementPlayoutMs: number | undefined): number {
    const outMs = (p.outputLatency ?? 0) * 1000;
    if (p.path === 'element') return elementPlayoutMs ?? outMs;
    return MSS_FIFO_ESTIMATE_MS + (p.baseLatency ?? 0) * 1000 + outMs + LIMITER_LOOKAHEAD_MS
        + (p.nsEnabled ? NS_RING_LATENCY_MS : 0);
}

/** What the Web Audio path costs on top of the element path (for logging the
 *  latency a path switch adds/removes). 0 for the element path. */
export function webAudioExtraMs(p: PlaybackInfo, elementPlayoutMs: number | undefined): number {
    if (p.path === 'element') return 0;
    return outputPathMs(p, elementPlayoutMs) - (elementPlayoutMs ?? (p.outputLatency ?? 0) * 1000);
}

// ── Stats → estimate ─────────────────────────────────────────────────────────

/** Loose view of an RTCStats entry: we only read fields, never trust shape. */
export type StatsEntry = { id: string; type: string; [k: string]: unknown };
type ReportLike = Iterable<StatsEntry> | { forEach: (cb: (s: StatsEntry) => void) => void };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function entries(report: ReportLike): StatsEntry[] {
    const out: StatsEntry[] = [];
    if (typeof (report as { forEach?: unknown }).forEach === 'function') {
        (report as { forEach: (cb: (s: StatsEntry) => void) => void }).forEach(s => { out.push(s); });
    } else {
        for (const s of report as Iterable<StatsEntry>) out.push(s);
    }
    return out;
}

function pickInbound(list: StatsEntry[], kind: 'audio' | 'video'): StatsEntry | undefined {
    let best: StatsEntry | undefined;
    for (const s of list) {
        if (s.type !== 'inbound-rtp' || s.kind !== kind) continue;
        if (!best || (num(s.bytesReceived) ?? 0) > (num(best.bytesReceived) ?? 0)) best = s;
    }
    return best;
}

export interface AvSyncSnapshot {
    aJbDelay: number; aJbEmitted: number;
    playoutDelay: number; playoutSamples: number;
    vJbDelay: number; vJbEmitted: number;
    vDecodeTime: number; vFramesDecoded: number;
}

export type AvSyncVerdict = 'ok' | 'audio-late' | 'audio-early' | 'unknown';

export interface AvSyncEstimate {
    /** Jitter buffer → speaker, ms. */
    audioPathMs: number;
    /** Jitter buffer → screen, ms. */
    videoPathMs: number;
    /** audioPathMs − videoPathMs: > 0 = audio late. Receive side only. */
    offsetMs: number;
    /** ± this much is unknowable from JS (the Web Audio FIFO). */
    uncertaintyMs: number;
    verdict: AvSyncVerdict;
    path: PlaybackPath;
    parts: { audioJbMs: number; outputMs: number; videoJbMs: number; decodeMs: number; renderMs: number };
}

export function avSyncVerdict(offsetMs: number | undefined): AvSyncVerdict {
    if (offsetMs === undefined || !Number.isFinite(offsetMs)) return 'unknown';
    if (offsetMs > AUDIO_LAG_LIMIT_MS) return 'audio-late';
    if (offsetMs < -AUDIO_LEAD_LIMIT_MS) return 'audio-early';
    return 'ok';
}

/**
 * Estimate the receive-side A/V offset for one participant from its audio and
 * video receivers' getStats() reports. Uses per-interval averages when `prev`
 * is given (and the counters advanced), lifetime averages otherwise.
 *
 * What it can't see: anything before the packets reach us — the sender's
 * capture latencies (camera vs mic) and its audio processing (noise
 * suppression etc. happens before RTP timestamps are assigned). Those shift
 * the real offset by the same amount for every viewer; the overlay says
 * "receive side" for that reason.
 */
export function estimateAvSync(
    audioReport: ReportLike,
    videoReport: ReportLike,
    playback: PlaybackInfo,
    prev: AvSyncSnapshot | null,
): { estimate: AvSyncEstimate | null; snapshot: AvSyncSnapshot | null } {
    const al = entries(audioReport);
    const vl = entries(videoReport);
    const a = pickInbound(al, 'audio');
    const v = pickInbound(vl, 'video');
    if (!a || !v) return { estimate: null, snapshot: null };
    const playout = al.find(s => s.type === 'media-playout');

    const snap: AvSyncSnapshot = {
        aJbDelay: num(a.jitterBufferDelay) ?? 0,
        aJbEmitted: num(a.jitterBufferEmittedCount) ?? 0,
        playoutDelay: num(playout?.totalPlayoutDelay) ?? 0,
        playoutSamples: num(playout?.totalSamplesCount) ?? 0,
        vJbDelay: num(v.jitterBufferDelay) ?? 0,
        vJbEmitted: num(v.jitterBufferEmittedCount) ?? 0,
        vDecodeTime: num(v.totalDecodeTime) ?? 0,
        vFramesDecoded: num(v.framesDecoded) ?? 0,
    };
    // Interval average when the counter advanced since prev, else lifetime.
    const avgMs = (sum: number, count: number, pSum: number | undefined, pCount: number | undefined): number | undefined => {
        if (pSum !== undefined && pCount !== undefined && count > pCount) return ((sum - pSum) / (count - pCount)) * 1000;
        return count > 0 ? (sum / count) * 1000 : undefined;
    };
    const audioJbMs = avgMs(snap.aJbDelay, snap.aJbEmitted, prev?.aJbDelay, prev?.aJbEmitted);
    const videoJbMs = avgMs(snap.vJbDelay, snap.vJbEmitted, prev?.vJbDelay, prev?.vJbEmitted);
    if (audioJbMs === undefined || videoJbMs === undefined) return { estimate: null, snapshot: snap };
    const playoutMs = avgMs(snap.playoutDelay, snap.playoutSamples, prev?.playoutDelay, prev?.playoutSamples);
    const decodeMs = avgMs(snap.vDecodeTime, snap.vFramesDecoded, prev?.vDecodeTime, prev?.vFramesDecoded) ?? 0;

    const outputMs = outputPathMs(playback, playoutMs);
    const audioPathMs = audioJbMs + outputMs;
    const videoPathMs = videoJbMs + decodeMs + VIDEO_RENDER_DELAY_MS;
    const offsetMs = audioPathMs - videoPathMs;
    return {
        estimate: {
            audioPathMs, videoPathMs, offsetMs,
            uncertaintyMs: playback.path === 'webaudio' ? MSS_FIFO_UNCERTAINTY_MS : 0,
            verdict: avSyncVerdict(offsetMs),
            path: playback.path,
            parts: { audioJbMs, outputMs, videoJbMs, decodeMs, renderMs: VIDEO_RENDER_DELAY_MS },
        },
        snapshot: snap,
    };
}

// ── Latest estimates, for the issue reporter's call bundle ───────────────────

/** Re-log an offset only when it moved at least this much (or the verdict changed). */
export const OFFSET_LOG_STEP_MS = 40;

export interface AvSyncSnapshotEntry {
    /** Placeholder, e.g. "remote-av-1" — never an identity. */
    slot: string;
    source: 'camera' | 'screen_share';
    path: PlaybackPath;
    offsetMs: number;
    uncertaintyMs: number;
    audioPathMs: number;
    videoPathMs: number;
    verdict: AvSyncVerdict;
    /** Epoch ms of the estimate. */
    at: number;
}
