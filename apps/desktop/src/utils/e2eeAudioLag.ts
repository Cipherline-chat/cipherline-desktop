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
 * Dropping only helps if frames are waiting in a queue in front of us, so the
 * tracker checks that instead of assuming it:
 *   - Every drop is a probe. If a queue stands in front of us, the frame after
 *     a dropped one was already waiting and reaches us at once (well under one
 *     frame period later); if not, it arrives at the media's own pace.
 *     PROBES_TO_REBASE drops in a row with nothing waiting = the offset is not
 *     a queue we can drain (a capture stall that left the RTP timeline behind
 *     the wall clock for good, a timestamp jump, lag upstream of us): re-base,
 *     after ~60 ms of dropped audio.
 *   - "The next frame came at once" can also be the network handing us packets
 *     in clumps. So every PASS_PROBE_EVERY-th over-cap frame is let through
 *     instead (a pass probe): behind a real backlog, the frame after a PASSED
 *     one has to wait for its processing, so it comes later than after a drop.
 *     If it comes at once anyway (PASS_PROBES_TO_REBASE times), our drops are
 *     not what makes frames come early: not our queue, re-base. A pass probe
 *     that had to wait, after drops whose followers did not, is a backlog: the
 *     state is marked as one, the pass probes stop, and it keeps being dropped
 *     while it is over the cap, exactly as before.
 *   - A draining burst (a blocked worker releasing what queued) is never
 *     re-based by the pass probes: its frames are stale and are dropped until
 *     the excess is back under the cap.
 *
 * 2026-11-18 (claude/call-audio-e2e-test, a real two-peer LiveKit round trip):
 * the old rule (drop for REBASE_AFTER_MS, then re-base unless the excess fell)
 * turned a 600 ms capture stall into 2180 ms of lost speech, and a 1500 ms one
 * into 5080 ms (the send AND the receive stage each dropped 2 s). And because
 * any frame back under the cap restarted that 2 s clock, an offset sitting at
 * the receive cap with jitter around it was never re-based: 59-92 % of frames
 * dropped for a whole minute with 0 packets lost. The over-cap state now ends
 * only when the excess is really drained (under CLEAR_FRACTION of the cap),
 * never on a jittery dip, so neither the probes nor the REBASE_AFTER_MS
 * backstop are reset by one. The backstop never fires on a state the probes
 * marked as a backlog: that is what this cap exists to bound.
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
/** Backstop: re-base an over-cap state this old whose excess has not come down, unless the probes marked it a backlog. */
export const REBASE_AFTER_MS = 2_000;
/** Drops in a row after which the next frame was NOT already waiting: not a queue, re-base. 3 x 20 ms of audio. */
export const PROBES_TO_REBASE = 3;
/** Every this-many-th over-cap frame of a state not yet known to be a backlog is passed, as a pass probe. */
export const PASS_PROBE_EVERY = 4;
/** Pass probes whose next frame came at once anyway (not our queue): re-base. */
export const PASS_PROBES_TO_REBASE = 2;
/** ...but only once the state has lasted this long: a draining burst is over well before. */
export const PASS_PROBE_MIN_STATE_MS = 200;
/** The over-cap state ends only once the excess is back under this share of the cap (hysteresis: a dip is not a drain). */
export const CLEAR_FRACTION = 0.5;
/** An "excess" beyond this is a timestamp discontinuity, not a backlog: re-base at once, drop nothing. */
export const IMPLAUSIBLE_LAG_MS = 300_000;
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
    private lastExcess = 0;
    private lastOffset: number | null = null;
    /** The over-cap state: when it started, the excess then, and what its probes have shown. */
    private overSince: number | null = null;
    private overStartExcess = 0;
    private sincePassProbe = 0;
    /** The previous frame was a probe: 'drop' (dropped) or 'pass' (an over-cap frame let through). */
    private probePending: 'drop' | 'pass' | null = null;
    private dropProbes = 0;
    private dropProbesQuick = 0;
    /** Drop probes in a row whose next frame came at the media's pace (nothing was waiting). */
    private notWaitingRun = 0;
    private passProbes = 0;
    private passProbesQuick = 0;
    /** The probes showed a backlog that our drops drain: keep dropping, no more pass probes, no backstop. */
    private backlog = false;

    private readonly capMs: number;
    private readonly clockHz: number;

    constructor(capMs = AUDIO_LAG_CAP_MS, clockHz = AUDIO_CLOCK_HZ) {
        this.capMs = capMs;
        this.clockHz = clockHz;
    }

    /** One audio frame: its 32-bit RTP timestamp and the time it reached us (ms). */
    observe(rtpTs: number, nowMs: number): AudioLagVerdict {
        const ts = rtpTs >>> 0;
        let dTicks = 0;
        if (this.lastTs === null) {
            this.extTs = ts;
        } else {
            let d = (ts - this.lastTs) >>> 0;
            if (d > 0x7fffffff) d -= 0x100000000; // a reordered / older timestamp
            this.extTs += d;
            dTicks = d;
        }
        this.lastTs = ts;
        const offset = nowMs - (this.extTs / this.clockHz) * 1000;
        const prevOffset = this.lastOffset;
        this.lastOffset = offset;
        const probe = this.probePending;
        this.probePending = null;
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
        if (excess > IMPLAUSIBLE_LAG_MS) {
            // Not a queue: nothing waits five minutes in a frame transform, and
            // dropping cannot drain it. The stream's RTP timeline jumped (a
            // peer's new publication on a reused receiver, a source that
            // restarted its clock). Re-base NOW. Waiting out REBASE_AFTER_MS
            // first dropped 100 frames = 2 s of the speaker's audio every time
            // (staging.178-187: five inbound windows, lag "41,566,318 ms").
            this.rebase(offset);
            return { excessMs: 0, drop: false, rebased: true };
        }
        this.lastExcess = excess;
        // What the last probe showed: did the frame after it come at once (about a
        // frame lower offset: it was already waiting, or arrived in the same clump)
        // or at the media's pace (same offset)?
        if (probe && prevOffset !== null && dTicks > 0) {
            const quick = offset - prevOffset < -((dTicks / this.clockHz) * 1000) / 2;
            if (probe === 'drop') {
                this.dropProbes++;
                if (quick) { this.dropProbesQuick++; this.notWaitingRun = 0; } else this.notWaitingRun++;
            } else {
                this.passProbes++;
                if (quick) this.passProbesQuick++;
            }
            // Followers come at once after a drop but have to wait after a pass: our drops drain a backlog.
            if (!this.backlog && this.dropProbes >= 2 && this.passProbes >= 2
                && this.dropProbesQuick >= 0.75 * this.dropProbes && this.passProbesQuick <= 0.25 * this.passProbes) this.backlog = true;
        }
        if (this.overSince !== null && excess <= this.capMs * CLEAR_FRACTION) this.leaveOver(); // really drained
        if (this.overSince !== null) {
            const age = nowMs - this.overSince;
            const draining = excess <= this.overStartExcess - this.capMs / 2;
            // Dropping drains nothing (no frame waits behind a dropped one); or frames come
            // at once whether we drop or pass them (clumps, not our queue); or, failing a
            // readable answer, REBASE_AFTER_MS over the cap without it coming down.
            if (this.notWaitingRun >= PROBES_TO_REBASE
                || (!this.backlog && !draining && this.passProbesQuick >= PASS_PROBES_TO_REBASE)
                || (!this.backlog && !draining && age >= REBASE_AFTER_MS && excess > this.capMs)) {
                this.rebase(offset);
                return { excessMs: excess, drop: false, rebased: true };
            }
        }
        if (excess <= this.capMs) return { excessMs: excess, drop: false, rebased: false };
        if (this.overSince === null) {
            this.overSince = nowMs;
            this.overStartExcess = excess;
        } else if (!this.backlog && nowMs - this.overSince >= PASS_PROBE_MIN_STATE_MS && ++this.sincePassProbe >= PASS_PROBE_EVERY) {
            // A pass probe (never in the first PASS_PROBE_MIN_STATE_MS: a draining burst is over by then).
            this.sincePassProbe = 0;
            this.probePending = 'pass';
            return { excessMs: excess, drop: false, rebased: false };
        }
        this.probePending = 'drop';
        return { excessMs: excess, drop: true, rebased: false };
    }

    private leaveOver(): void {
        this.overSince = null;
        this.sincePassProbe = 0;
        this.dropProbes = 0;
        this.dropProbesQuick = 0;
        this.notWaitingRun = 0;
        this.passProbes = 0;
        this.passProbesQuick = 0;
        this.backlog = false;
    }

    private rebase(offset: number): void {
        this.baseline = offset;
        this.lastExcess = 0;
        this.probePending = null;
        this.leaveOver();
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
