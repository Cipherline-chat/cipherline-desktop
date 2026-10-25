/**
 * HDR -> SDR tone mapping for screen shares of an HDR Windows desktop - the
 * reference implementation.
 *
 * WHY A SHARE OF AN HDR DESKTOP IS "BLOWN OUT". With HDR on, DWM composes the
 * desktop in scRGB: linear light, BT.709 primaries, FP16, 1.0 = 80 nits
 * (learn.microsoft.com "Use DirectX with Advanced Color", CCCS). An SDR app's
 * white is placed at the user's "SDR content brightness" W (typically
 * 200-480 nits), i.e. at scRGB W / 80 = 2.5 .. 6. Both capturers Chromium can
 * use hand back 8-bit BGRA (webrtc wgc_capture_session.cc creates its frame
 * pool as B8G8R8A8UIntNormalized; dxgi_output_duplicator.cc uses the legacy
 * IDXGIOutput1::DuplicateOutput, which "always converts ... to a 32-bit BGRA
 * format"), and that conversion clips scRGB at 1.0 without dividing by W: with
 * W = 200 every SDR value brighter than 40 % linear (sRGB code ~170) becomes
 * 255, and every HDR highlight with it. The detail is gone before any frame
 * reaches us, which is why a fix inside our frame pipeline cannot work and the
 * capture has to be our own (src-native/hdr_capture.cc: DuplicateOutput1 with
 * DXGI_FORMAT_R16G16B16A16_FLOAT, then this curve in a pixel shader).
 *
 * THE CURVE, applied to max(R,G,B) so hue is kept (the scale factor is shared
 * by all three channels):
 *   1. x = scRGB * 80 / W            - SDR-relative: the desktop's white is 1.0
 *   2. x <= knee: unchanged           - every SDR value up to `knee` (linear;
 *                                       0.8 = sRGB code 231) is reproduced
 *                                       EXACTLY as the app drew it
 *   3. x > knee: a C1 shoulder (extended Reinhard in the knee-relative
 *      variable u = (x - knee) / (1 - knee)):
 *          g(u) = u * (1 + u / umax^2) / (1 + u),  umax = (xmax - knee) / (1 - knee)
 *          y    = knee + (1 - knee) * g(u)
 *      g(0) = 0, g'(0) = 1 (no visible kink at the knee), g(umax) = 1: the
 *      display's peak (xmax = peak / W) lands exactly on output white, and
 *      everything between SDR white and the peak keeps its ordering.
 *   4. sRGB encode (piecewise; Windows decodes SDR content with the piecewise
 *      sRGB curve when composing it into scRGB, so this round-trips).
 * With the default knee, SDR white (x = 1) lands at ~0.90 linear = sRGB code
 * ~243 ("normal SDR white" to a viewer), and the HDR range from W up to the
 * panel's peak rolls off into the codes above it instead of clipping.
 *
 * The SAME math runs on the GPU: hdr_capture.cc's TONEMAP-CORE block is
 * written in the subset of HLSL that is also GLSL (with three #defines), and
 * scripts/hdr-tonemap-harness.mjs renders it in WebGL2 against this file.
 */

/** scRGB 1.0, in nits (CCCS nominal reference white). */
export const SCRGB_WHITE_NITS = 80;
/** Windows' SDR white level when nothing better is known (the slider's bottom). */
export const DEFAULT_SDR_WHITE_NITS = 80;
/** Peak luminance assumed when the display reports none. */
export const DEFAULT_PEAK_NITS = 1000;
/** Linear SDR-relative level below which the curve is the identity. */
export const DEFAULT_KNEE = 0.8;
/** The peak is never taken as closer to white than this (keeps the shoulder concave). */
export const MIN_PEAK_OVER_WHITE = 2;
/** Windows' SDR white slider tops out at 480 nits; leave room, refuse nonsense. */
export const MAX_SDR_WHITE_NITS = 1000;
export const MAX_PEAK_NITS = 10000;

/**
 * DISPLAYCONFIG_SDR_WHITE_LEVEL.SDRWhiteLevel -> nits. The struct documents
 * the value as "a multiplier for the SDR white level, 1000 = 80 nits".
 */
export function sdrWhiteNitsFromDisplayConfig(raw: number): number | null {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return (raw * SCRGB_WHITE_NITS) / 1000;
}

export interface ToneParams {
    /** The desktop's SDR white, nits. */
    sdrWhiteNits: number;
    /** The display's peak, nits (content above it was clipped on the user's own screen too). */
    peakNits: number;
    /** Linear SDR-relative knee, (0, 1). */
    knee: number;
}

/**
 * Sanitise what the display reports into parameters the curve is defined
 * for. Exactly mirrored by hdr_capture.cc ResolveToneParams.
 */
export function resolveToneParams(input: {
    sdrWhiteNits?: number | null;
    maxLuminance?: number | null;
    knee?: number | null;
}): ToneParams {
    const w0 = input.sdrWhiteNits;
    const sdrWhiteNits = typeof w0 === 'number' && Number.isFinite(w0) && w0 >= SCRGB_WHITE_NITS
        ? Math.min(w0, MAX_SDR_WHITE_NITS)
        : DEFAULT_SDR_WHITE_NITS;
    const p0 = input.maxLuminance;
    const reported = typeof p0 === 'number' && Number.isFinite(p0) && p0 > 0 ? Math.min(p0, MAX_PEAK_NITS) : DEFAULT_PEAK_NITS;
    const peakNits = Math.max(reported, sdrWhiteNits * MIN_PEAK_OVER_WHITE);
    const k0 = input.knee;
    const knee = typeof k0 === 'number' && Number.isFinite(k0) && k0 >= 0.1 && k0 <= 0.95 ? k0 : DEFAULT_KNEE;
    return { sdrWhiteNits, peakNits, knee };
}

/**
 * The four numbers the shader takes (cbuffer `tone` / uniform `uTone`):
 * [80 / W, knee, xmax, 1 / umax^2].
 */
export function shaderToneVector(p: ToneParams): [number, number, number, number] {
    const xmax = p.peakNits / p.sdrWhiteNits;
    const umax = (xmax - p.knee) / (1 - p.knee);
    return [SCRGB_WHITE_NITS / p.sdrWhiteNits, p.knee, xmax, 1 / (umax * umax)];
}

/** The shoulder on one SDR-relative linear value (step 2 + 3 above). */
export function rolloff(x: number, knee: number, invUmax2: number): number {
    if (!(x > knee)) return x;
    const u = (x - knee) / (1 - knee);
    const g = (u * (1 + u * invUmax2)) / (1 + u);
    return Math.min(knee + (1 - knee) * g, 1);
}

/** scRGB (linear, 1.0 = 80 nits, may be negative / > 1) -> linear SDR [0, 1]. */
export function tonemapScRgb(rgb: readonly [number, number, number], tone: readonly [number, number, number, number]): [number, number, number] {
    const [scale, knee, , invUmax2] = tone;
    const r = Math.max(rgb[0], 0) * scale;
    const g = Math.max(rgb[1], 0) * scale;
    const b = Math.max(rgb[2], 0) * scale;
    const m = Math.max(r, g, b);
    const s = m > 0 ? rolloff(m, knee, invUmax2) / m : 0;
    return [Math.min(r * s, 1), Math.min(g * s, 1), Math.min(b * s, 1)];
}

/** Linear [0, 1] -> sRGB-encoded [0, 1] (IEC 61966-2-1 piecewise). */
export function srgbEncode(l: number): number {
    const v = Math.min(Math.max(l, 0), 1);
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** sRGB-encoded [0, 1] -> linear. */
export function srgbDecode(e: number): number {
    const v = Math.min(Math.max(e, 0), 1);
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 8-bit code for an sRGB-encoded value (the render target is B8G8R8A8_UNORM). */
export function toCode(e: number): number {
    return Math.round(Math.min(Math.max(e, 0), 1) * 255);
}

/** Our output for one scRGB pixel, as 8-bit codes. */
export function tonemapToCodes(rgb: readonly [number, number, number], tone: readonly [number, number, number, number]): [number, number, number] {
    const l = tonemapScRgb(rgb, tone);
    return [toCode(srgbEncode(l[0])), toCode(srgbEncode(l[1])), toCode(srgbEncode(l[2]))];
}

/**
 * What Chromium's capturers deliver for the same pixel today: the OS's 8-bit
 * conversion, a plain clip of scRGB at 1.0 (see the header). Used for the
 * before/after comparison only.
 */
export function legacyClipToCodes(rgb: readonly [number, number, number]): [number, number, number] {
    return [toCode(srgbEncode(rgb[0])), toCode(srgbEncode(rgb[1])), toCode(srgbEncode(rgb[2]))];
}

/** An SDR app's sRGB code as DWM places it in scRGB at white level W. */
export function sdrCodeToScRgb(code: number, sdrWhiteNits: number): number {
    return srgbDecode(code / 255) * (sdrWhiteNits / SCRGB_WHITE_NITS);
}

// ── SMPTE ST 2084 (PQ), for test patterns defined in absolute nits ──────────
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

/** Absolute luminance (nits) -> PQ signal [0, 1]. */
export function pqEncode(nits: number): number {
    const y = Math.min(Math.max(nits, 0), 10000) / 10000;
    const p = Math.pow(y, PQ_M1);
    return Math.pow((PQ_C1 + PQ_C2 * p) / (1 + PQ_C3 * p), PQ_M2);
}

/** PQ signal [0, 1] -> absolute luminance (nits). */
export function pqDecode(e: number): number {
    const p = Math.pow(Math.min(Math.max(e, 0), 1), 1 / PQ_M2);
    return 10000 * Math.pow(Math.max(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p), 1 / PQ_M1);
}

/** Nits -> scRGB value (gray). */
export function nitsToScRgb(nits: number): number {
    return nits / SCRGB_WHITE_NITS;
}
