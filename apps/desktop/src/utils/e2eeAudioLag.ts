/**
 * A hard cap on how late an AUDIO frame may be when it passes through the
 * call's E2EE worker — both directions — and the numbers to prove it.
 *
 * ── Why
 *
 * 2026-10-24, staging.174: "audio was super delayed on both ends", by "about a
 * minute", in a DM call where the sharer's PC was encoding a 1080p60 screen
 * share in SOFTWARE next to a running game. Every frame of the call — our mic
 * on its way out (encrypt) and the other person's voice on its way in
 * (decrypt) — passes through ONE worker thread (workers/e2eeWorker.ts:
 * LiveKit's frame cryptor + our Annex-B stage), in FIFO order with every
 * video frame. That is the one place in the app where both directions share a
 * queue, and a delay "on both ends" is what a backlog there looks like: once
 * frames wait, they are all played — late — because NetEq on the far side,
 * and here, simply plays what arrives. Nothing in the app measured or bounded
 * that wait. (Chromium drops encoded frames when its own transform-source
 * queue is deep, but that is an implementation detail we can't see from here
 * and the report says it did not save the call; this is our own bound.)
 *
 * ── How
 *
 * Each audio frame carries its RTP timestamp (48 kHz for Opus/RED). For one
 * stream, `arrival_ms - rtp_ms` is constant while frames flow on time, and
 * grows by exactly the queueing delay when they wait. The tracker keeps a
 * baseline (the smallest offset seen, allowed to creep up by DRIFT_PPM so a
 * sender clock running slow is never mistaken for lag), and a frame whose
 * excess over that baseline is above AUDIO_LAG_CAP_MS is DROPPED instead of
 * being encrypted / decrypted (cap: AUDIO_LAG_CAP_MS out, AUDIO_LAG_CAP_RECV_MS in): Opus concealment covers it, and dropping is
 * what drains the queue (a dropped frame costs no crypto), so the next frames
 * arrive fresh. Voice must stay the lowest-latency thing in the app; a few
 * concealed packets are far better than conversational audio a second (or a
 * minute) late.
 *
 * If dropping does NOT bring the excess down within REBASE_AFTER_MS (frames
 * keep arriving at real-time pace with the same offset — a timestamp jump
 * after a source pause, or lag that happened upstream of us), the offset is
 * not a queue we can drain: the baseline is re-based and the drop stops.
 *
 * Video frames are never touched (dropping one breaks the decode chain until
 * the next keyframe). Frame CONTENT is never read — only the timestamp.
 */

/** Outgoing (our mic → encrypt): only local scheduling sits in front of the
 *  worker, so anything past this is backlog. */
export const AUDIO_LAG_CAP_MS = 300;
/** Incoming (decrypt → NetEq): network jitter also lands in the offset, so the
 *  cap is looser — NetEq absorbs ordinary jitter; this only stops a backlog. */
export const AUDIO_LAG_CAP_RECV_MS = 1_000;
export const REBASE_AFTER_MS = 2_000;
/** Baseline creep allowed for clock drift: 500 ppm = 30 ms per minute. */
export const DRIFT_PPM = 500;
export const AUDIO_CLOCK_HZ = 48_000;
export const AUDIO_LAG_STATS_KIND = 'cl:audio-lag';
export const AUDIO_LAG_STATS_EVERY_MS = 10_000;
/** Report a window with no drops only if it got at least this close to the cap. */
export const AUDIO_LAG_REPORT_MS = 120;

export interface AudioLagVerdict { excessMs: number; drop: boolean; rebased: boolean }

export class AudioLagTracker {
    private lastTs: number | null = null;
    private extTs = 0;
    private baseline: number | null = null;
    private baselineAt = 0;
    private dropSince: number | null = null;
    private dropStartExcess = 0;
    private lastExcess = 0;

    private readonly capMs: number;
    private readonly clockHz: number;

    constructor(capMs = AUDIO_LAG_CAP_MS, clockHz = AUDIO_CLOCK_HZ) {
        this.capMs = capMs;
        this.clockHz = clockHz;
    }

    /** One audio frame: its 32-bit RTP timestamp and the time it reached us (ms). */
    observe(rtpTs: number, nowMs: number): AudioLagVerdict {
        const ts = rtpTs >>> 0;
        if (this.lastTs === null) {
            this.extTs = ts;
        } else {
            let d = (ts - this.lastTs) >>> 0;
            if (d > 0x7fffffff) d -= 0x100000000; // a reordered / older timestamp
            this.extTs += d;
        }
        this.lastTs = ts;
        const offset = nowMs - (this.extTs / this.clockHz) * 1000;
        if (this.baseline === null) {
            this.baseline = offset;
            this.baselineAt = nowMs;
            return { excessMs: 0, drop: false, rebased: false };
        }
        // Creep the baseline up for clock drift, never past the current offset —
        // and only while healthy: while frames are late the baseline holds, or
        // a sustained backlog would slowly be accepted as the new normal.
        const healthy = this.lastExcess < this.capMs / 2;
        const crept = this.baseline + (healthy ? Math.max(0, nowMs - this.baselineAt) * (DRIFT_PPM / 1e6) : 0);
        this.baselineAt = nowMs;
        this.baseline = Math.min(crept, offset);
        const excess = offset - this.baseline;
        this.lastExcess = excess;
        if (excess <= this.capMs) {
            this.dropSince = null;
            return { excessMs: excess, drop: false, rebased: false };
        }
        if (this.dropSince === null) {
            this.dropSince = nowMs;
            this.dropStartExcess = excess;
        } else if (nowMs - this.dropSince >= REBASE_AFTER_MS && excess > this.dropStartExcess - this.capMs / 2) {
            // Dropping has not drained anything: not our queue. Re-base.
            this.baseline = offset;
            this.dropSince = null;
            this.lastExcess = 0;
            return { excessMs: excess, drop: false, rebased: true };
        }
        return { excessMs: excess, drop: true, rebased: false };
    }
}

export interface AudioLagStats { dir: 'send' | 'recv'; frames: number; dropped: number; maxMs: number; rebases: number }

interface FrameLike { timestamp?: number; getMetadata?(): { rtpTimestamp?: number } }

/** RTP timestamp of an encoded AUDIO frame, or null for a video frame / unknown. */
export function audioRtpTimestamp(frame: unknown): number | null {
    if (!frame || typeof frame !== 'object' || 'type' in frame) return null; // video frames carry `type`
    const f = frame as FrameLike;
    try {
        const m = f.getMetadata?.();
        if (typeof m?.rtpTimestamp === 'number' && Number.isFinite(m.rtpTimestamp)) return m.rtpTimestamp;
    } catch { /* fall through */ }
    return typeof f.timestamp === 'number' && Number.isFinite(f.timestamp) ? f.timestamp : null;
}

/**
 * The worker-side stage: a TransformStream that drops over-cap audio frames
 * and passes everything else through untouched. `onWindow` gets the stats
 * every AUDIO_LAG_STATS_EVERY_MS when there is something to say.
 */
export function createAudioLagStage<T>(
    dir: 'send' | 'recv',
    onWindow: (s: AudioLagStats) => void,
    now: () => number = () => Date.now(),
): TransformStream<T, T> {
    const tracker = new AudioLagTracker(dir === 'send' ? AUDIO_LAG_CAP_MS : AUDIO_LAG_CAP_RECV_MS);
    let stats: AudioLagStats = { dir, frames: 0, dropped: 0, maxMs: 0, rebases: 0 };
    let windowStart = now();
    return new TransformStream<T, T>({
        transform(frame, controller) {
            let drop = false;
            try {
                const ts = audioRtpTimestamp(frame);
                if (ts !== null) {
                    const t = now();
                    const v = tracker.observe(ts, t);
                    stats.frames++;
                    if (v.excessMs > stats.maxMs) stats.maxMs = v.excessMs;
                    if (v.rebased) stats.rebases++;
                    if (v.drop) { stats.dropped++; drop = true; }
                    if (t - windowStart >= AUDIO_LAG_STATS_EVERY_MS) {
                        if (stats.dropped > 0 || stats.rebases > 0 || stats.maxMs >= AUDIO_LAG_REPORT_MS) {
                            try { onWindow({ ...stats, maxMs: Math.round(stats.maxMs) }); } catch { /* page gone */ }
                        }
                        stats = { dir, frames: 0, dropped: 0, maxMs: 0, rebases: 0 };
                        windowStart = t;
                    }
                }
            } catch { drop = false; /* never block a frame on the hook */ }
            if (!drop) controller.enqueue(frame);
        },
    });
}

/** Page side: parse the worker's message. */
export function audioLagStatsFromMessage(data: unknown): AudioLagStats | null {
    const d = data as { kind?: string; data?: Record<string, unknown> } | null;
    if (!d || d.kind !== AUDIO_LAG_STATS_KIND || !d.data) return null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const dir = d.data.dir === 'recv' ? 'recv' : d.data.dir === 'send' ? 'send' : null;
    if (!dir) return null;
    return { dir, frames: n(d.data.frames), dropped: n(d.data.dropped), maxMs: n(d.data.maxMs), rebases: n(d.data.rebases) };
}
