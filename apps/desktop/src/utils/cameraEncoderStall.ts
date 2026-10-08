/**
 * Mid-call camera ENCODER stall detection.
 *
 * ── The gap this closes (owner's report, 1.0.18-staging.146, 2026-10-07) ──
 *
 * A camera published as H.264 High on NVIDIA's Media Foundation encoder
 * (`MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`, single
 * layer 1920x1080@30) ran at 29 fps, then 3, then 0 for the rest of the call:
 * capture kept delivering 15-30 fps, outbound-rtp `framesPerSecond` vanished
 * (Chrome omits it when nothing was ENCODED in the last second),
 * quality_limitation_reason stayed "none", no NACK/PLI, transport healthy.
 * The encoder had stopped producing frames and nothing noticed.
 *
 * cameraPublish.watchHardwareCamera checks a hardware camera ONCE, ~6 s after
 * it starts. That catches an encoder that never works; it cannot catch one
 * that dies mid-call (an NVENC session lost to a driver reset, a display or
 * mode change, another app taking the encoder, a GPU hang). H.264 High has NO
 * software encoder in Chromium (OpenH264 is Constrained Baseline only), so a
 * High camera whose hardware encoder fails stays black until the user turns
 * the camera off and on.
 *
 * This detector says "stalled" only when ALL of these hold for STALL_MS:
 *   - the same published track (a republish starts over);
 *   - at least one encoding is ACTIVE — a layer dynacast paused because
 *     nobody is watching encodes nothing by design and is never a stall
 *     (livekit-client setPublishingLayersForSender: a single-layer camera's
 *     rid '' maps to quality q, so it too is paused when unsubscribed);
 *   - the capture is still delivering frames (media-source `frames` grows) —
 *     a camera that delivers nothing is a capture problem, not an encoder one;
 *   - the encoder is not network-limited (bandwidth limitation or a zero
 *     target bitrate pause the encoder on purpose), and the room is connected;
 *   - and the frames-encoded total did not move.
 * It fires once per track. The caller (cameraPublish.recoverStalledCamera)
 * republishes the same capture on a different encoder — never unencrypted,
 * same E2EE room.
 *
 * Pure (no LiveKit, no DOM): cameraEncoderStall.test.ts drives it with samples.
 */

/** No encoded frame for this long, with capture and an active layer, = stalled. */
export const ENCODER_STALL_MS = 6000;
/** How often the call samples the camera sender. */
export const ENCODER_STALL_SAMPLE_MS = 2000;

export interface EncoderStallSample {
    /** ms (performance.now()). */
    at: number;
    /** Identifies the published track; a change starts a new watch. */
    trackKey: string;
    /** Publication unmuted, track live, and ≥ 1 encoding active. */
    encoding: boolean;
    /** Sum of outbound-rtp video `framesEncoded` for this sender. */
    framesEncoded: number;
    /** media-source `frames` (cumulative), or null when the stats lack it. */
    framesCaptured: number | null;
    /** Bandwidth-limited, zero target bitrate, or the room not connected. */
    networkHeld: boolean;
}

export type EncoderStallVerdict =
    /** First sample for this track, or not long enough yet. */
    | 'watching'
    /** Frames are being encoded. */
    | 'ok'
    /** Nothing to judge: dynacast paused / muted / network-held. */
    | 'paused'
    /** The capture itself delivers nothing (not the encoder's fault). */
    | 'no-capture'
    /** Capture flowing, layer active, encoder silent for ≥ stallMs. Fires once per track. */
    | 'stalled';

export class EncoderStallDetector {
    private key: string | null = null;
    private lastEncoded = 0;
    private lastCaptured: number | null = null;
    /** When the current run of "capture yes, encode no" began (ms), or null. */
    private silentSince: number | null = null;
    private lastAt = 0;
    private fired = false;
    /** The previous sample was not judgeable (paused / no capture): start the clock at the next one, not before. */
    private clockFromNow = false;

    private readonly stallMs: number;

    constructor(stallMs = ENCODER_STALL_MS) { this.stallMs = stallMs; }

    observe(s: EncoderStallSample): EncoderStallVerdict {
        if (s.trackKey !== this.key) {
            this.key = s.trackKey;
            this.lastEncoded = s.framesEncoded;
            this.lastCaptured = s.framesCaptured;
            this.silentSince = null;
            this.lastAt = s.at;
            this.fired = false;
            this.clockFromNow = false;
            return 'watching';
        }
        const encodedMoved = s.framesEncoded > this.lastEncoded;
        const captureMoved = s.framesCaptured === null || this.lastCaptured === null
            ? true
            : s.framesCaptured > this.lastCaptured;
        const prevAt = this.lastAt;
        this.lastEncoded = Math.max(this.lastEncoded, s.framesEncoded);
        this.lastCaptured = s.framesCaptured;
        this.lastAt = s.at;

        if (!s.encoding || s.networkHeld) { this.silentSince = null; this.clockFromNow = true; return 'paused'; }
        if (encodedMoved) { this.silentSince = null; this.clockFromNow = false; return 'ok'; }
        if (!captureMoved) { this.silentSince = null; this.clockFromNow = true; return 'no-capture'; }
        // Silent since the previous sample at the latest — or since now, when
        // the previous one was not judgeable (a layer dynacast just resumed
        // gets a full stallMs to produce its first frame).
        if (this.silentSince === null) this.silentSince = this.clockFromNow ? s.at : prevAt;
        this.clockFromNow = false;
        if (this.fired) return 'watching';
        if (s.at - this.silentSince >= this.stallMs) {
            this.fired = true;
            return 'stalled';
        }
        return 'watching';
    }
}

// ── Reading a sample from a sender ────────────────────────────────────────

type StatsRecord = Record<string, unknown>;
const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Build a sample from an RTCRtpSender's parameters + stats. `encodings` is
 * sender.getParameters().encodings; `stats` iterates the sender's report.
 */
export function encoderStallSample(input: {
    at: number;
    trackKey: string;
    publicationMuted: boolean;
    trackLive: boolean;
    roomConnected: boolean;
    encodings: readonly { active?: boolean }[] | undefined;
    stats: Iterable<StatsRecord>;
}): EncoderStallSample {
    let framesEncoded = 0;
    let framesCaptured: number | null = null;
    let networkHeld = !input.roomConnected;
    const mediaSourceIds = new Set<string>();
    const sources = new Map<string, StatsRecord>();
    for (const s of input.stats) {
        if (s.type === 'media-source' && s.kind === 'video' && typeof s.id === 'string') sources.set(s.id, s);
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') continue;
        framesEncoded += n(s.framesEncoded) ?? 0;
        if (typeof s.mediaSourceId === 'string') mediaSourceIds.add(s.mediaSourceId);
        // Only an ACTIVE layer can hold the encoder for network reasons.
        if (s.active !== false) {
            if (s.qualityLimitationReason === 'bandwidth') networkHeld = true;
            if (n(s.targetBitrate) === 0) networkHeld = true;
        }
    }
    const pick = mediaSourceIds.size ? [...mediaSourceIds].map(id => sources.get(id)).filter(Boolean) : [...sources.values()];
    for (const src of pick) {
        const f = n(src!.frames);
        if (f !== undefined) framesCaptured = Math.max(framesCaptured ?? 0, f);
    }
    const anyActive = (input.encodings ?? []).some(e => e.active !== false);
    return {
        at: input.at,
        trackKey: input.trackKey,
        encoding: !input.publicationMuted && input.trackLive && anyActive,
        framesEncoded,
        framesCaptured,
        networkHeld,
    };
}
