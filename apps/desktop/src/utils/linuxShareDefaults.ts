/**
 * Linux screen-share defaults that depend on WHICH encode path the share will take. Pure.
 *
 * ── Frame rate on the Chromium/PipeWire path (cap 60) ──
 * Four real reports from a CachyOS / KDE Wayland PC (RTX 5070, 3440x1440, 2026-11-11) asked the
 * Chromium capture for 90 fps and got src_fps ~60 every time: Chromium's PipeWire capturer tops out
 * around 60 whatever the monitor runs at (the older KDE-only measurement in capture-flags.ts
 * captureFpsCeiling saw 65-75 on a different setup, so it only caps the request there). The native helper
 * path (native/share-encoder, hardware NVENC/VA-API) captured through the portal itself and reached 113.
 * So the 90 fps option is only honest where the native path will run; on the Chromium path the offer is 60.
 *
 * ── Software encode start ──
 * The same reports' software VP8 fallback at 3440x1440 "source@90" ran at cpu_pct 99, enc_ms 10.6, src 59
 * (~290 Mpx/s of work), and the encoder-overload card (shareEncoderOverload.ts) only appeared after
 * OVERLOAD_SUSTAIN_MS (30 s). The overload logic treats a window as overloaded at CPU_LIMIT_FRACTION (0.5) of a
 * core budget, i.e. roughly half of that 290 Mpx/s. SOFTWARE_START_BUDGET is that estimate: 1080p60 (124 Mpx/s)
 * fits, 1440p60 (221 Mpx/s) does not, source@90 on 3440x1440 (446 Mpx/s) never does.
 */
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';
import type { HardwareEncoderSupport, ScreenShareCodec } from './screenShare';
import { OVERLOAD_FRAME_RATES, OVERLOAD_RESOLUTIONS, resolveOption, type OverloadSetting, type ResolvedOption } from './shareEncoderOverload';

export const CHROMIUM_PORTAL_FPS_CAP = 60;
/** Pixels per second a software (VP8 / OpenH264) encoder is expected to carry comfortably. See the header. */
export const SOFTWARE_START_BUDGET = 150e6;

/**
 * The frame-rate ceiling of a share that will go through Chromium's capturer on Linux, or null when it
 * does not apply (not Linux, or the native hardware path will run). `nativeLikely` null = not known yet:
 * no cap is promised either way.
 */
export function chromiumPathFpsCap(i: { platform: string | undefined; nativeLikely: boolean | null }): number | null {
    return i.platform === 'linux' && i.nativeLikely === false ? CHROMIUM_PORTAL_FPS_CAP : null;
}

/** The tighter of two ceilings (null / 0 / garbage = none). */
export function mergeFpsCeiling(a: number | null | undefined, b: number | null | undefined): number | null {
    const ok = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
    if (ok(a) && ok(b)) return Math.min(a, b);
    return ok(a) ? a : ok(b) ? b : null;
}

/** `frameRate` held to `cap` (null = no cap), snapped down to a rate the picker offers. */
export function capFrameRate(frameRate: ScreenShareOptions['frameRate'], cap: number | null): ScreenShareOptions['frameRate'] {
    if (cap === null || frameRate <= cap) return frameRate;
    const offered = ([90, 60, 30, 15] as const).filter(f => f <= cap);
    return offered[0] ?? 15;
}

/**
 * Will this share be software-encoded? Linux only (Windows / macOS hardware behaviour is untouched):
 * the native hardware path is not going to run and Chromium has no hardware encoder for the codec in use.
 */
export function expectSoftwareEncode(i: {
    platform: string | undefined;
    nativeLikely: boolean | null;
    hw: HardwareEncoderSupport | null;
    codec: ScreenShareCodec;
}): boolean {
    if (i.platform !== 'linux' || i.nativeLikely !== false) return false;
    if (i.codec === 'vp8') return !i.hw?.vp8;
    if (i.codec === 'vp9') return !i.hw?.vp9;
    if (i.codec === 'h265') return false;               // negotiated only with a hardware encoder
    return !(i.hw?.h264 || i.hw?.h264High);
}

export interface SoftwareStartPlan {
    /** The setting the share should start at (= the input when it already fits). */
    setting: OverloadSetting;
    /** The picked setting does not fit the software budget. */
    overBudget: boolean;
    /** The picked setting's own option (size / rate / pixel rate), for the warning. */
    picked: ResolvedOption;
    /** What fits instead; null when the pick already fits or nothing lower exists. */
    suggested: ResolvedOption | null;
}

/**
 * Fit a quality setting to the software budget. Pure; the caller decides whether to APPLY `suggested`
 * (an untouched default / auto quality) or only SAY so up front (an explicit choice in the picker).
 */
export function planSoftwareStart(i: {
    setting: OverloadSetting;
    codec: ScreenShareCodec;
    source: { width: number; height: number };
    maxFps: number;
    budget?: number;
}): SoftwareStartPlan {
    const budget = i.budget ?? SOFTWARE_START_BUDGET;
    const picked = resolveOption(i.setting, i.codec, i.source);
    if (!(picked.rate > budget)) return { setting: i.setting, overBudget: false, picked, suggested: null };
    // Screen content wants frame rate before pixels: among the options that fit, those at 60 fps (or the path's
    // maximum when lower) come first, then the most pixels, then the rate closest to the user's.
    const smooth = Math.min(60, i.maxFps);
    const fits = OVERLOAD_RESOLUTIONS.flatMap(resolution => OVERLOAD_FRAME_RATES
        .filter(frameRate => frameRate <= i.maxFps)
        .map(frameRate => resolveOption({ resolution, frameRate }, i.codec, i.source)))
        .filter(o => o.rate <= budget && o.rate < picked.rate);
    fits.sort((x, y) =>
        Number(y.frameRate >= smooth) - Number(x.frameRate >= smooth)
        || y.rate - x.rate
        || Math.abs(x.frameRate - i.setting.frameRate) - Math.abs(y.frameRate - i.setting.frameRate));
    const sug: ResolvedOption | null = fits[0] ?? null;
    return {
        setting: sug ? { resolution: sug.resolution, frameRate: sug.frameRate } : i.setting,
        overBudget: true, picked, suggested: sug,
    };
}
