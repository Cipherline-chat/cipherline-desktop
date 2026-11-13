/**
 * audioSilenceWatchdog — catches the one failure mode LiveKit's own
 * connection-state machinery structurally can't see: a "connected but
 * silent" outbound mic. ICE/DTLS can be perfectly healthy (Reconnecting never
 * fires, ConnectionState stays Connected) while the capture/encode path is
 * dead — a suspended AudioContext, a processed track that stopped delivering,
 * a disabled track behind an "unmuted" button — and the user has no way to
 * know they're talking into dead air.
 *
 * ── What it judges against (rewritten 2026-11-04)
 *
 * It used to compare our pipeline meter against `localParticipant.audioLevel`
 * and called the difference an outage. That second signal is NOT a wire
 * measurement: livekit-client 2.18.8 only ever writes it from the SFU's
 * speaker updates (Room.handleActiveSpeakersUpdate / handleSpeakersChanged),
 * which are thresholded and pushed server-side. On 2026-11-02 a Mac user
 * tripped `call_one_way_audio {out}` while their own sender was putting 57-66
 * kbps of live Opus on the wire (webrtc samples of that same report) — a false
 * positive built into the signal, not a flaky moment. So the verdict now comes
 * from the SENDER's own getStats() (utils/outboundAudioStats.ts):
 *
 *   no_rtp        the mic is enabled and the connection is up, yet the
 *                 sender's bytesSent has not moved for TRIP_AFTER_MS (a
 *                 never-started sender gets START_GRACE_MS). Needs no meter
 *                 at all: an enabled Opus sender emits packets even in
 *                 silence (the idle floor in real reports is a steady 13
 *                 kbps), and a suspended AudioContext's destination track
 *                 sends NOTHING (measured, outboundAudioStats.ts).
 *   silent_source RTP flows, our pipeline meter says the user is talking
 *                 (>= PIPELINE_ACTIVE_FLOOR_DBFS), but the samples the
 *                 encoder was fed average below SOURCE_SILENT_RMS: the
 *                 published track is delivering silence (e.g. a disabled
 *                 track behind an unmuted button).
 *
 * Everything else is "no verdict", never an outage: muted, reconnecting,
 * counters unreadable or restarted, a stale meter, and a sampling gap larger
 * than MAX_SAMPLE_GAP_MS (sleep/wake, a frozen renderer: wall-clock time that
 * passed while nobody was looking is not evidence).
 *
 * Deliberately does NOT attempt a "remote participant has been silent for
 * Ns" watchdog: silence from a remote participant is the overwhelming
 * majority of any real call. The inbound half (their packets stop) is
 * callSummary.InboundAudioStallDetector.
 */

import { sourceRmsBetween, type WireReading } from './outboundAudioStats';

export const PIPELINE_ACTIVE_FLOOR_DBFS = -45; // matches the gate's own default threshold
/** Mean level of the samples fed to the encoder (linear, 1 = full scale) below which the source is "silent": -70 dBFS. */
export const SOURCE_SILENT_RMS = 10 ** (-70 / 20);
export const TRIP_AFTER_MS = 4000; // sustained evidence this long before flagging
/** A sender that has never sent a byte may just be waiting for ICE: give it longer. */
export const START_GRACE_MS = 12_000;
export const RECOVER_AFTER_MS = 1000; // healthy evidence has to hold, not blip
/** A tripped state with no new evidence of the fault for this long is stale (the user went quiet): clear it. */
export const QUIET_CLEAR_MS = 15_000;
/** Samples further apart than this are not continuous observation (sleep/wake, frozen renderer). */
export const MAX_SAMPLE_GAP_MS = 3000;
/** A pipeline meter reading older than this is a dead meter, not a quiet user. */
export const PIPELINE_STALE_MS = 1500;

export type StallCause = 'no_rtp' | 'silent_source';

export interface SilenceWatchdogSample {
    /** Loudest reading of our own pipeline meter since the previous sample, dBFS. */
    pipelineDbfs: number;
    /** Milliseconds since the pipeline meter last reported at all (Infinity = never this call). */
    pipelineAgeMs: number;
    micEnabled: boolean;
    /** Room connected and not reconnecting: without it nothing is judged. */
    transportUp: boolean;
    /** The mic sender's counters, or null when they could not be read this tick. */
    wire: WireReading | null;
}

export interface SilenceWatchdogState {
    tripped: boolean;
    cause: StallCause | null;
}

export class SilenceWatchdog {
    private lastAt: number | null = null;
    private prevWire: WireReading | null = null;
    private noRtpMs = 0;
    private silentMs = 0;
    private lastFaultAt = 0;
    private recoveredSince: number | null = null;
    private tripped = false;
    private cause: StallCause | null = null;

    /**
     * @param sample Current readings.
     * @param nowMs  Caller-supplied clock (Date.now() in production, a fake
     *               clock in tests) — keeps this fully deterministic.
     */
    update(sample: SilenceWatchdogSample, nowMs: number): SilenceWatchdogState {
        if (!sample.micEnabled || !sample.transportUp) {
            // Muted or reconnecting is not a bug — start clean when it ends.
            this.reset();
            return this.state();
        }

        const gap = this.lastAt === null ? 0 : nowMs - this.lastAt;
        this.lastAt = nowMs;
        let dt = gap;
        if (gap > MAX_SAMPLE_GAP_MS) {
            // We were not looking for a while. What happened in it is unknown.
            this.noRtpMs = 0;
            this.silentMs = 0;
            this.prevWire = null;
            this.recoveredSince = null;
            dt = 0;
        }

        const prev = this.prevWire;
        const wire = sample.wire;
        this.prevWire = wire;

        let fault: StallCause | null = null;
        let rtpFlowing = false;
        let healthyActive = false;
        let neededMs = TRIP_AFTER_MS;

        if (wire && prev) {
            const dBytes = wire.bytesSent - prev.bytesSent;
            if (dBytes < 0) {
                // Counters restarted (the sender was replaced): no verdict this tick.
                this.noRtpMs = 0;
            } else if (dBytes === 0) {
                this.noRtpMs += dt;
                fault = 'no_rtp';
                if (wire.bytesSent === 0) neededMs = START_GRACE_MS;
            } else {
                this.noRtpMs = 0;
                rtpFlowing = true;
                const active = sample.pipelineAgeMs <= PIPELINE_STALE_MS && sample.pipelineDbfs >= PIPELINE_ACTIVE_FLOOR_DBFS;
                const rms = sourceRmsBetween(prev, wire);
                if (active && rms !== null) {
                    if (rms < SOURCE_SILENT_RMS) {
                        this.silentMs += dt;
                        fault = 'silent_source';
                    } else {
                        this.silentMs = 0;
                        healthyActive = true;
                    }
                }
                // else: bytes flow but there is nothing to compare — idle, the
                // silent-source evidence so far is held, not cleared or added to.
            }
        } else {
            // Unreadable: a dead-run needs CONTINUOUS evidence.
            this.noRtpMs = 0;
        }

        if (!this.tripped) {
            if (this.noRtpMs >= neededMs) this.trip('no_rtp', nowMs);
            else if (this.silentMs >= TRIP_AFTER_MS) this.trip('silent_source', nowMs);
            return this.state();
        }

        if (fault) {
            this.lastFaultAt = nowMs;
            this.recoveredSince = null;
            return this.state();
        }
        // Recovery needs POSITIVE evidence: RTP moving again (for a no_rtp
        // fault) or the encoder hearing a talking user (for a silent source).
        // A quiet second proves nothing, so it holds the state rather than
        // flapping the banner off and on around every pause.
        const positive = this.cause === 'no_rtp' ? rtpFlowing : healthyActive;
        if (positive) {
            if (this.recoveredSince === null) this.recoveredSince = nowMs;
            if (nowMs - this.recoveredSince >= RECOVER_AFTER_MS) this.clear();
        } else {
            this.recoveredSince = null;
            if (nowMs - this.lastFaultAt >= QUIET_CLEAR_MS) this.clear();
        }
        return this.state();
    }

    state(): SilenceWatchdogState {
        return { tripped: this.tripped, cause: this.cause };
    }

    reset(): void {
        this.lastAt = null;
        this.prevWire = null;
        this.noRtpMs = 0;
        this.silentMs = 0;
        this.lastFaultAt = 0;
        this.recoveredSince = null;
        this.tripped = false;
        this.cause = null;
    }

    private trip(cause: StallCause, nowMs: number): void {
        this.tripped = true;
        this.cause = cause;
        this.lastFaultAt = nowMs;
        this.recoveredSince = null;
    }

    private clear(): void {
        this.tripped = false;
        this.cause = null;
        this.noRtpMs = 0;
        this.silentMs = 0;
        this.recoveredSince = null;
    }
}
