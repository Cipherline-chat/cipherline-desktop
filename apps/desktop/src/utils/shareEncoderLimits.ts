/**
 * What size a screen share may be ENCODED at, per codec - and the one place the
 * "never hand the encoder a frame it cannot take" rule lives.
 *
 * ── The report (owner, 2026-10-13) ─────────────────────────────────────────
 * Three monitors in NVIDIA Surround are ONE 7680x1440 display to Windows. The
 * share box for "Source" was 7680x4320 (screenShare.resolveSSResolution), so the
 * capturer delivered the display at its native 7680x1440 and the encoder was
 * asked to open at that size. No mainstream encoder accepts it:
 *   - NVENC H.264 is limited to 4096 px wide (and Chromium's Media Foundation
 *     wrapper reports even less), H.264 levels 5.x top out at 36864
 *     macroblocks = 9,437,184 px;
 *   - the same wall exists in the other hardware encoders (Intel QSV, AMD VCN,
 *     VAAPI), and a software encoder would be asked for ~1 Gpx/s at 90 fps.
 * The encoder fails to initialise, no frame is ever produced, and every viewer
 * sees black. The same failure was reachable (more quietly) with a 5120x1440
 * super-ultrawide (5120 > 4096) or any 8K source.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Every share, of any display, is held to the conservative common denominator
 * below - 3840x2160 and 8,294,400 px (4K UHD), which every hardware and
 * software encoder Cipherline can pick accepts - by two layers:
 *   1. the CAPTURE BOX handed to getDisplayMedia (clampCaptureBox): Chromium's
 *      desktop capturer fits the source inside the box, preserving aspect, so
 *      the encoder is never opened at an illegal size;
 *   2. scaleResolutionDownBy on the encoding (planEncode), computed from the
 *      size the capture ACTUALLY has - the belt to the box's braces, and the
 *      only way to apply a fallback step mid-share.
 * Not sized by frame rate: NVENC does not enforce the H.264 level's macroblock
 * rate, and cutting 4K90 shares that work today would be a regression.
 *
 * Pure (no DOM, no livekit-client) so the clamp is unit-tested over every
 * codec x display size (shareEncoderLimits.test.ts).
 */

export type EncoderCodec = 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1';

export interface EncoderLimits {
    maxWidth: number;
    maxHeight: number;
    /** Largest frame area, pixels. */
    maxPixels: number;
}

/** 4K UHD - the common ceiling. */
export const UHD_WIDTH = 3840;
export const UHD_HEIGHT = 2160;
export const UHD_PIXELS = UHD_WIDTH * UHD_HEIGHT; // 8,294,400

/**
 * Per-codec encode limits. Deliberately conservative and, today, equal: the
 * point of a table is that a codec whose real limit turns out LOWER on some
 * hardware can be tightened here in one line, not hunted for at call sites.
 *   - h264: NVENC caps width at 4096 and H.264 level 5.2 caps the frame at
 *     36864 macroblocks (9.4 Mpx); 4K UHD sits inside both with margin.
 *   - h265: HEVC level 5.x allows 8,912,896 px; hardware wrappers in Chromium
 *     commonly stop at 4096x2304.
 *   - vp8 / vp9: hardware VP8/VP9 encoders (Intel, AMD) report 4096-wide
 *     ceilings; libvpx itself would accept more but cannot keep up.
 *   - av1: not published today (the E2EE worker rejects it) but clamped anyway.
 */
const LIMITS: Record<EncoderCodec, EncoderLimits> = {
    h264: { maxWidth: UHD_WIDTH, maxHeight: UHD_HEIGHT, maxPixels: UHD_PIXELS },
    h265: { maxWidth: UHD_WIDTH, maxHeight: UHD_HEIGHT, maxPixels: UHD_PIXELS },
    vp8:  { maxWidth: UHD_WIDTH, maxHeight: UHD_HEIGHT, maxPixels: UHD_PIXELS },
    vp9:  { maxWidth: UHD_WIDTH, maxHeight: UHD_HEIGHT, maxPixels: UHD_PIXELS },
    av1:  { maxWidth: UHD_WIDTH, maxHeight: UHD_HEIGHT, maxPixels: UHD_PIXELS },
};

export function encoderLimitsFor(codec: EncoderCodec): EncoderLimits {
    return LIMITS[codec] ?? LIMITS.h264;
}

/**
 * Black-screen fallback ladder (shareHealth.ts): after an encoder stall the
 * share is republished with its pixel budget cut to this. Step 0 = no extra cap.
 */
export const RESOLUTION_STEP_PIXELS: readonly number[] = Object.freeze([
    Number.POSITIVE_INFINITY,
    1920 * 1080, // step 1: 1080p-equivalent area
    1280 * 720,  // step 2: 720p-equivalent area
]);
export const MAX_RESOLUTION_STEP = RESOLUTION_STEP_PIXELS.length - 1;

/** Largest even integer <= n (video encoders want even dimensions), at least 2. */
export function evenFloor(n: number): number {
    const f = Math.floor(n);
    return Math.max(2, f - (f % 2));
}

/** Nearest even integer, at least 2. */
function nearestEven(n: number): number {
    return Math.max(2, Math.round(n / 2) * 2);
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export interface EncodePlan {
    /** scaleResolutionDownBy for the full layer; 1 = send as captured. */
    scale: number;
    /** The size that results (even dimensions). */
    width: number;
    height: number;
    /** True when the capture itself exceeds the codec's limits (not just a fallback step). */
    overLimit: boolean;
}

/**
 * How a capture of `width`x`height` must be scaled to be encoded with `codec`
 * at fallback `step`. Aspect is preserved; the result never exceeds the codec's
 * width, height or area, nor the step's pixel budget. Unknown / non-positive
 * input yields scale 1 (nothing to clamp against - the capture box still holds).
 */
export function planEncode(codec: EncoderCodec, width: number | undefined, height: number | undefined, step = 0): EncodePlan {
    if (!fin(width) || !fin(height)) return { scale: 1, width: 0, height: 0, overLimit: false };
    const lim = encoderLimitsFor(codec);
    const areaScale = Math.sqrt((width * height) / lim.maxPixels);
    const limScale = Math.max(1, width / lim.maxWidth, height / lim.maxHeight, areaScale);
    const budget = RESOLUTION_STEP_PIXELS[Math.min(Math.max(0, Math.floor(step)), MAX_RESOLUTION_STEP)];
    const stepScale = Number.isFinite(budget) ? Math.sqrt((width * height) / budget) : 1;
    const raw = Math.max(1, limScale, stepScale);
    // Round UP (at 6 decimals) so rounding can never leave the result over a limit.
    const scale = Math.ceil(raw * 1e6) / 1e6;
    // Nearest even size (1920x1080 stays 1920x1080, not 1918x1078); fall back to
    // rounding DOWN if the nearest one would poke past a width/height/area limit.
    const maxArea = Math.min(lim.maxPixels, budget);
    let w = nearestEven(width / scale);
    let h = nearestEven(height / scale);
    if (w > lim.maxWidth || h > lim.maxHeight || w * h > maxArea) {
        w = evenFloor(width / scale);
        h = evenFloor(height / scale);
    }
    return { scale, width: w, height: h, overLimit: limScale > 1 };
}

/** The capture box (max width x height) handed to getDisplayMedia, never beyond the codec's limits. */
export function clampCaptureBox(
    codec: EncoderCodec,
    box: { width: number; height: number },
): { width: number; height: number } {
    const lim = encoderLimitsFor(codec);
    return {
        width: Math.min(box.width, lim.maxWidth),
        height: Math.min(box.height, lim.maxHeight),
    };
}
