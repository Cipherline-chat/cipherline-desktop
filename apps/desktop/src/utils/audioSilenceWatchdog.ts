/**
 * audioSilenceWatchdog — catches the one failure mode LiveKit's own
 * connection-state machinery structurally can't see: a "connected but
 * silent" pipeline. ICE/DTLS can be perfectly healthy (Reconnecting never
 * fires, ConnectionState stays Connected) while the actual capture/encode
 * path is dead — a stuck AudioWorklet, a browser mic-capture race, a
 * permission edge case — and the user has no way to know they're talking
 * into dead air.
 *
 * The signal: CipherlineVoiceProcessor's own level meter (fed through
 * audioHealth.recordInputLevel — see CallPane.tsx) reports what OUR
 * pipeline believes it's producing (post-gate, post-AGC, right before the
 * track handed to LiveKit). `localParticipant.audioLevel` reports what
 * LiveKit/WebRTC computed from the RTP audio-level header extension on
 * what's ACTUALLY being sent. If our own pipeline shows genuine activity
 * (above the gate's own -45 dBFS default floor, i.e. loud enough that the
 * gate itself would have opened) for a sustained stretch while LiveKit's
 * outbound level stays at effectively zero, that's a real disconnect
 * between "we think we're transmitting" and "the wire has nothing" — not
 * just a quiet moment.
 *
 * Deliberately does NOT attempt a "remote participant has been silent for
 * Ns" watchdog: silence from a remote participant is the OVERWHELMING
 * majority of any real call (most of a conversation is one person talking
 * while everyone else is quiet) and isn't a reliable signal of anything
 * broken — shipping that check would mostly produce false-positive noise
 * flagging perfectly normal quiet participants as "maybe broken," which
 * would hurt trust in the app's diagnostics rather than help it.
 */

export const PIPELINE_ACTIVE_FLOOR_DBFS = -45; // matches the gate's own default threshold
export const OUTBOUND_SILENT_CEILING = 0.01; // linear 0..1, LiveKit's audioLevel scale
export const TRIP_AFTER_MS = 4000; // sustained mismatch this long before flagging
export const RECOVER_AFTER_MS = 1000; // outbound level has to actually recover, not just blip

export interface SilenceWatchdogSample {
    /** Our own pipeline's level in dBFS (from voiceProcessor's level meter). */
    pipelineDbfs: number;
    /** LiveKit's reported outbound audio level, linear 0..1. */
    outboundLevel: number;
    micEnabled: boolean;
}

export class SilenceWatchdog {
    private mismatchSinceMs: number | null = null;
    private recoveredSinceMs: number | null = null;
    private tripped = false;

    /**
     * @param sample Current readings.
     * @param nowMs  Caller-supplied clock (Date.now() in production, a fake
     *               clock in tests) — keeps this fully deterministic.
     * @returns Whether the watchdog is CURRENTLY tripped after this sample.
     */
    update(sample: SilenceWatchdogSample, nowMs: number): boolean {
        if (!sample.micEnabled) {
            // Muted is not a bug — reset entirely so unmuting starts clean.
            this.mismatchSinceMs = null;
            this.recoveredSinceMs = null;
            this.tripped = false;
            return this.tripped;
        }

        const pipelineActive = sample.pipelineDbfs >= PIPELINE_ACTIVE_FLOOR_DBFS;
        const outboundSilent = sample.outboundLevel <= OUTBOUND_SILENT_CEILING;
        const mismatch = pipelineActive && outboundSilent;

        if (mismatch) {
            this.recoveredSinceMs = null;
            if (this.mismatchSinceMs === null) this.mismatchSinceMs = nowMs;
            if (!this.tripped && nowMs - this.mismatchSinceMs >= TRIP_AFTER_MS) {
                this.tripped = true;
            }
        } else {
            this.mismatchSinceMs = null;
            if (this.tripped) {
                // Require the recovery to hold for a beat rather than clearing
                // on a single good sample — a genuinely dead pipeline that
                // happens to report one clean reading (encoder hiccup) would
                // otherwise flap the banner on and off.
                if (this.recoveredSinceMs === null) this.recoveredSinceMs = nowMs;
                if (nowMs - this.recoveredSinceMs >= RECOVER_AFTER_MS) {
                    this.tripped = false;
                    this.recoveredSinceMs = null;
                }
            }
        }

        return this.tripped;
    }

    reset(): void {
        this.mismatchSinceMs = null;
        this.recoveredSinceMs = null;
        this.tripped = false;
    }
}
