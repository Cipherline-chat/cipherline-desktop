/**
 * What a screen share does when the app itself takes its HARDWARE encoder away, and what the sharer is told.
 *
 * ── The report (2026-11-21, staging 0.1.2-staging.249 + stable 0.1.2 viewer, Windows)
 *
 * "Not hitting 90 fps when screen sharing" / "watching 90fps screenshare and it's like 30". The sharer chose
 * Source at 90 fps on a 3440x1440 ultrawide. The share began on H.265 in hardware (66 fps sent), then the sender
 * was encoding VP8 in SOFTWARE and the sent rate fell to 11 fps. Nothing told the sharer.
 *
 * Every way a share leaves H.265 mid-share lands on the codec decided at share start (shareBaseCodecRef in
 * SidebarConference): a viewer who cannot decode H.265 joins (hevcNegotiation), the H.265 encoder fails and
 * libwebrtc swaps the sender to the next negotiated codec - VP8, libvpx - by itself (shareCodecDrift), or it never
 * produced a frame (the start check). Whenever that base codec is not a hardware one (no H.264 hardware encoder
 * the decision trusts: NVIDIA skipping H.264 CB with High unavailable or failed earlier, a CB encoder that already
 * ran in software, no probe), the share is suddenly a CPU encode of ~446 Mpx/s
 * (3440 x 1440 x 90). libvpx does a fraction of that next to a game: measured on the GPU-less dev box, VP8 held
 * 45-49 fps at 2560x1440 with NOTHING else running (~170 Mpx/s), and the report's 11 fps at 3440x1440 is
 * ~55 Mpx/s. libwebrtc's own CPU adaptation steps the size down only slowly (seconds per step) and steps it back
 * up as soon as it recovers, so the frame rate is what collapses.
 *
 * ── The rule
 *
 * When the APP moved a share from a hardware encoder to a software one (never when the person's machine simply
 * has no hardware encoder and they chose the setting knowing it - that is the encoder-overload suggestion's,
 * shareEncoderOverload.ts, owner rule 2026-11-05: the app does not lower a setting by itself), the sender holds
 * the FRAME RATE and gives up resolution: scaleResolutionDownBy so the full layer's pixel rate fits
 * SOFTWARE_HOLD_PX_RATE (1080p60's), never below a 720 px short side. The person chose hardware quality; the
 * fallback is ours, so the trade-off is ours to make - frame rate first, as for every share ('motion',
 * degradationPreference 'maintain-framerate'). The sharer is told what happened and why.
 *
 * Pure: no DOM, no livekit-client. Unit-tested with the reported 3440x1440@90 case (shareQualityPlan.test.ts).
 */
import { evenFloor } from './shareEncoderLimits';
import { logCallEvent } from './callEventLog';

/** Why a share left its hardware encoder. */
export type ShareFallbackCause =
    /** A viewer who cannot decode H.265 is watching (or joined): the share moved to the base codec. */
    | 'viewer_cannot_decode'
    /** The hardware encoder failed mid-share and libwebrtc swapped the sender's codec (shareCodecDrift). */
    | 'hw_encoder_failed'
    /** The hardware encoder never produced a frame (the post-start check). */
    | 'hw_encoder_no_frames';

/**
 * Pixels per second a software encoder is asked for at most after an involuntary fallback: 1920 x 1080 x 60.
 * About 3/4 of what VP8 sustained on the GPU-less dev box with nothing else running (2560x1440 at 45-49 fps, see
 * decideScreenShareCodec), because the sharer is usually running the thing they share - a game - on the same CPU.
 * If even this is too much, the encoder-overload suggestion measures it and offers the next step down.
 */
export const SOFTWARE_HOLD_PX_RATE = 1920 * 1080 * 60; // 124,416,000
/** The hold never makes the picture's short side smaller than this (if the capture is larger). */
export const SOFTWARE_HOLD_MIN_SHORT_SIDE = 720;

export interface SoftwareHoldPlan {
    /** scaleResolutionDownBy for the full layer; 1 = no change. */
    scale: number;
    width: number;
    height: number;
    /** Pixels per second at `width` x `height` x the frame rate. */
    pxRate: number;
    /** False when the 720p floor stopped the scale short of the budget: the frame rate may still not hold. */
    fits: boolean;
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * The size that holds `fps` on a software encoder for a capture of `width` x `height`. Aspect is preserved,
 * dimensions are even, and the result's pixel rate is at most `budget` unless the 720 px short-side floor stops
 * it (then `fits` is false). A capture already within the budget, or unknown input, yields scale 1.
 */
export function planSoftwareHold(
    width: number | undefined,
    height: number | undefined,
    fps: number,
    budget: number = SOFTWARE_HOLD_PX_RATE,
): SoftwareHoldPlan {
    if (!fin(width) || !fin(height) || !fin(fps) || !fin(budget)) {
        return { scale: 1, width: fin(width) ? width : 0, height: fin(height) ? height : 0, pxRate: 0, fits: true };
    }
    const rate = width * height * fps;
    if (rate <= budget) return { scale: 1, width, height, pxRate: rate, fits: true };
    const want = Math.sqrt(rate / budget);
    const short = Math.min(width, height);
    const maxScale = Math.max(1, short / SOFTWARE_HOLD_MIN_SHORT_SIDE);
    const floored = want > maxScale;
    // Round UP (6 decimals) so rounding can never leave the result over the budget.
    const scale = Math.ceil(Math.min(want, maxScale) * 1e6) / 1e6;
    if (scale <= 1) return { scale: 1, width, height, pxRate: rate, fits: false };
    const w = evenFloor(width / scale);
    const h = evenFloor(height / scale);
    const pxRate = w * h * fps;
    return { scale, width: w, height: h, pxRate, fits: !floored && pxRate <= budget };
}

/** Is a share published with `codec` on a hardware encoder, given what the start-of-share decision knew? */
export function isHardwareShareCodec(
    codec: string,
    known: { h264Hardware: boolean; vp9Hardware: boolean },
): boolean {
    if (codec === 'h265') return true; // Chromium has no software H.265: published H.265 is hardware or nothing.
    if (codec === 'h264') return known.h264Hardware;
    if (codec === 'vp9') return known.vp9Hardware;
    return false; // VP8: Chromium's WebRTC has no hardware VP8 path on Windows/macOS GPUs we see.
}

/** The cause for an h265 move-off reason as hevcNegotiation.hevcSwitchReason words it; null = not a fallback we hold for. */
export function causeForHevcSwitch(reason: string): ShareFallbackCause | null {
    if (reason === 'someone cannot decode H.265') return 'viewer_cannot_decode';
    if (reason === 'H.265 failed' || reason === 'graphics driver reset') return 'hw_encoder_failed';
    // The setting turned off / no hardware H.265 encoder / an empty room: not an involuntary loss of hardware.
    return null;
}

const CODEC_NAME: Record<string, string> = { h265: 'H.265', h264: 'H.264', vp8: 'VP8', vp9: 'VP9', av1: 'AV1' };
export const codecName = (c: string): string => CODEC_NAME[c] ?? c.toUpperCase();

/**
 * What the sharer is told after a fallback to a software encoder. Says what happened, why, and what the share now
 * sends - so "it's like 30" has an answer on the sharer's own screen.
 */
export function softwareHoldNotice(i: {
    cause: ShareFallbackCause;
    /** The codec the share left (h265, or h264 for a High encoder that failed). */
    from: string;
    fps: number;
    plan: SoftwareHoldPlan;
}): string {
    const why = i.cause === 'viewer_cannot_decode'
        ? `Someone watching can’t decode ${codecName(i.from)}, and this PC has no other hardware video encoder,`
        : `Your graphics card’s ${codecName(i.from)} encoder stopped working,`;
    const now = 'so your share is now encoded by the CPU.';
    if (i.plan.scale <= 1) return `${why} ${now} It may not hold ${i.fps} fps.`;
    const size = `${i.plan.width}×${i.plan.height}`;
    return i.plan.fits
        ? `${why} ${now} Sending ${size} to keep ${i.fps} fps.`
        : `${why} ${now} Sending ${size}; it may still drop below ${i.fps} fps.`;
}

export interface ShareQualityFields {
    phase: 'fallback';
    cause: ShareFallbackCause;
    from: string;
    to: string;
    hardware: boolean;
    fps: number;
    cap_res: string;
    cap_mpx_s: number;
    hold_res: string;
    hold_scale: number;
    holds: boolean;
}

/** The share_quality call event for a fallback (codec names and sizes only - nothing about people). */
export function shareQualityEvent(i: {
    cause: ShareFallbackCause;
    from: string;
    to: string;
    hardware: boolean;
    fps: number;
    capture?: { width: number; height: number };
    plan?: SoftwareHoldPlan | null;
}): ShareQualityFields {
    const cap = i.capture && fin(i.capture.width) && fin(i.capture.height) ? i.capture : null;
    return {
        phase: 'fallback',
        cause: i.cause,
        from: i.from,
        to: i.to,
        hardware: i.hardware,
        fps: i.fps,
        cap_res: cap ? `${cap.width}x${cap.height}` : '',
        cap_mpx_s: cap ? Math.round((cap.width * cap.height * i.fps) / 1e5) / 10 : 0,
        hold_res: i.plan && i.plan.scale > 1 ? `${i.plan.width}x${i.plan.height}` : '',
        hold_scale: i.plan ? i.plan.scale : 1,
        holds: i.plan ? i.plan.fits : i.hardware,
    };
}

/** Log a share_quality event (a literal detail object, so the call-site privacy scan reads its keys). */
export function logShareQuality(f: ShareQualityFields): void {
    logCallEvent('share_quality', {
        phase: f.phase, cause: f.cause, from: f.from, to: f.to, hardware: f.hardware, fps: f.fps,
        cap_res: f.cap_res, cap_mpx_s: f.cap_mpx_s, hold_res: f.hold_res, hold_scale: f.hold_scale, holds: f.holds,
    });
}
