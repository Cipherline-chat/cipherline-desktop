/**
 * Receiver-side A/V sync for SCREEN SHARES ONLY: hold the share's VIDEO back
 * until it lines up with the share's AUDIO.
 *
 * Owner (2026-10-24): "For screenshares (not cameras) I would like the audio
 * and video to be in sync, so I am okay with adding a little delay into the
 * video if needed." And: voice ("talking") audio must NEVER be delayed and
 * does not need to be in sync with the share.
 *
 * ── Why not libwebrtc's own lip-sync
 *
 * libwebrtc lip-syncs one audio + one video receiver that share a MediaStream
 * (msid). livekit-client asks for screen_share + screen_share_audio to share a
 * stream (TrackPublishOptions.stream), but the SFU only honours it with
 * `room.sync_streams` on, which our LiveKit config does not set — and turning
 * it on server-wide also groups microphone + camera, where libwebrtc would
 * then DELAY THE VOICE to meet the camera, and could delay the share audio
 * instead of the video. Both break the owner's rules. So: our own controller,
 * video only.
 *
 * ── What it does
 *
 * Every SAMPLE_MS it takes the share pair's receive-side path estimate
 * (avSync.estimateAvSync: share audio = jitter buffer + output path, which is
 * the plain element / Web-Audio gain path — share audio is never noise-
 * suppressed, see screenShareAudioUnprocessed.test.ts; share video = jitter
 * buffer + decode + render) and asks the share VIDEO receiver's jitter buffer
 * for enough delay that video reaches the screen when its audio reaches the
 * speaker:
 *
 *     wanted video JB = audioPath − decode − render + SENDER_AUDIO_LEAD_MS
 *
 * jitterBufferTarget is a MINIMUM for the receiver's jitter buffer, and the
 * audio path does not depend on it, so there is no feedback loop through the
 * video measurement. Smoothed (median of the last MEDIAN_OF, then an EMA), dead-banded (below MIN_APPLY_MS nothing
 * is set), moved only by ≥ STEP_MS and at most every MIN_CHANGE_GAP_MS, and
 * capped at MAX_TARGET_MS. RTCRtpReceiver.jitterBufferTarget, falling back to
 * the older playoutDelayHint (seconds).
 *
 * SENDER_AUDIO_LEAD_MS: the sharer's native share-audio ring (pcmRingWorklet,
 * 40 ms prebuffer, trimmed to ≤ 80 ms) sits AFTER capture but BEFORE the RTP
 * timestamp is assigned, so no receiver can see it; the prebuffer is the
 * known floor of that lead. Everything else on the sender is unknowable here.
 *
 * It never touches an audio receiver, and never a camera: `applyShareVideoDelay`
 * refuses anything that is not the screen_share VIDEO publication.
 */

export const SAMPLE_MS = 3_000;
export const MAX_TARGET_MS = 500;
export const MIN_APPLY_MS = 40;
export const STEP_MS = 25;
export const MIN_CHANGE_GAP_MS = 6_000;
export const EMA_ALPHA = 0.35;
export const SENDER_AUDIO_LEAD_MS = 40;

export interface SharePathSample {
    /** Share audio: jitter buffer → speaker, ms. */
    audioPathMs: number;
    /** Share video decode time per frame, ms. */
    decodeMs: number;
    /** Share video render delay estimate, ms. */
    renderMs: number;
}

/** Wanted-delay samples kept for the median (one outlier never moves the target). */
export const MEDIAN_OF = 5;

export class ShareAvSyncController {
    private ema: number | null = null;
    private recent: number[] = [];
    private applied = 0;
    private lastChange = -Infinity;

    get targetMs(): number { return this.applied; }

    /** One estimate → the target to apply now, or null to leave it. */
    observe(s: SharePathSample | null, now: number): number | null {
        if (!s || ![s.audioPathMs, s.decodeMs, s.renderMs].every(Number.isFinite)) return null;
        const wanted = s.audioPathMs - s.decodeMs - s.renderMs + SENDER_AUDIO_LEAD_MS;
        this.recent.push(wanted);
        if (this.recent.length > MEDIAN_OF) this.recent.shift();
        const sorted = [...this.recent].sort((a, b) => a - b);
        const med = sorted[Math.floor((sorted.length - 1) / 2)]; // lower median
        this.ema = this.ema === null ? med : this.ema + EMA_ALPHA * (med - this.ema);
        let next = Math.round(Math.min(MAX_TARGET_MS, Math.max(0, this.ema)));
        if (next < MIN_APPLY_MS) next = 0;
        if (Math.abs(next - this.applied) < STEP_MS) return null;
        if (now - this.lastChange < MIN_CHANGE_GAP_MS) return null;
        this.applied = next;
        this.lastChange = now;
        return next;
    }
}

export interface ReceiverLike { jitterBufferTarget?: number | null; playoutDelayHint?: number | null }
export interface PublicationLike {
    source?: string;
    kind?: string;
    track?: { receiver?: ReceiverLike | null } | null;
}

/**
 * Set the extra video delay on a remote SCREEN-SHARE VIDEO publication.
 * Anything else — a microphone, the share's audio, a camera — is refused and
 * left untouched (returns false). 0 clears the hint.
 */
export function applyShareVideoDelay(pub: PublicationLike | null | undefined, targetMs: number): boolean {
    if (!pub || pub.source !== 'screen_share' || pub.kind !== 'video') return false;
    const r = pub.track?.receiver;
    if (!r) return false;
    const ms = Math.max(0, Math.min(MAX_TARGET_MS, Math.round(targetMs)));
    try {
        if ('jitterBufferTarget' in r) { r.jitterBufferTarget = ms > 0 ? ms : null; return true; }
        if ('playoutDelayHint' in r) { r.playoutDelayHint = ms > 0 ? ms / 1000 : null; return true; }
    } catch { /* receiver gone */ }
    return false;
}
