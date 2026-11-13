import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';
import { VideoPreset } from 'livekit-client';
import { clampCaptureBox, planEncode } from './shareEncoderLimits';
import { UNPROCESSED_TRACK_SETTINGS } from './audioInput';
import { linuxHwEncodeDistrusted, noteLinuxHwEncodeFailure } from './linuxHwEncode';
import { portalRetuneTouchesCapture, type CaptureAsk } from './portalCapturePlan';

// ─────────────────────────────────────────────────────────────────────────────
// Screen-share pipeline settings: capture box → codec → publish options →
// RTP sender overrides. Everything here is pure (or takes its browser objects
// as arguments) so the per-option numbers are unit-testable; the call site is
// SidebarConference.handleScreenShareSelect.
//
// Measured basis for the choices below (harness: the app's own Electron 43 +
// livekit-client 2.18.8, publishing through a LiveKit v1.9.12 SFU — see the
// branch's commit message for the numbers):
//   • Without `screenShareEncoding`, LiveKit publishes a screen share at its
//     own publishDefaults (ScreenSharePresets.h1080fps15 = 2.5 Mbps / 15 fps,
//     'maintain-resolution') and only our post-publish setParameters() lifts
//     it. Anything that makes LiveKit re-apply ITS stored encodings (a
//     replaceTrack whose dimensions change, a republish) silently drops the
//     share back to 15 fps, and the SDP start bitrate it munges for VP9 is
//     derived from that 2.5 Mbps (1.75 Mbps start → measured initial
//     bandwidth estimate 2.3 Mbps, vs 5.7 Mbps with a real encoding).
//   • VP9 (which LiveKit forces to L1T3 for screen shares) costs ~5x the
//     encode time of VP8/H.264 in software, and NVIDIA/AMD GPUs have no VP9
//     encoder at all — so on the typical gaming PC it was always libvpx VP9 in
//     software, which is the single biggest reason 1440p90 never happened.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The capture box requested from getDisplayMedia for each picker option.
 *
 * Capture never UPSCALES: a box larger than the source just delivers the
 * source's own size. So 'source' asks for an 8K box — measured in Electron 43
 * on a 5120×1440 display, the old 3840×2160 box delivered 3840×1080 (the
 * source squeezed to fit), while 7680×4320 delivered the native 5120×1440; on
 * a 3840×2160 or 2560×1440 display both deliver the native size. The named
 * options are real boxes: '1440p' on a 4K monitor is a genuine downscale.
 */
export function resolveSSResolution(res: ScreenShareOptions['resolution']): { width: number; height: number } {
    switch (res) {
        case 'source': return { width: 7680, height: 4320 };
        case '1440p':  return { width: 2560, height: 1440 };
        case '1080p':  return { width: 1920, height: 1080 };
        case '720p':   return { width: 1280, height:  720 };
        case '480p':   return { width:  854, height:  480 };
    }
}

/**
 * The capture box actually handed to the capturer: the picker's box, held to
 * what `codec` can encode (shareEncoderLimits.ts). The 'source' box is 8K, and
 * an 8K-wide capture (or a Surround display's native 7680x1440) is a frame no
 * encoder opens - the black screen of 2026-10-13. Chromium fits the display
 * inside the box preserving aspect: 7680x1440 in a 3840x2160 box = 3840x720.
 */
export function captureBoxFor(
    res: ScreenShareOptions['resolution'],
    codec: ScreenShareCodec,
): { width: number; height: number } {
    return clampCaptureBox(codec, resolveSSResolution(res));
}

/** Codecs a screen share can be published with. AV1 is deliberately absent:
 *  livekit-client 2.18.8's E2EE worker throws on AV1 frames ("av1 is not yet
 *  supported for end to end encryption"), and a share is never published
 *  unencrypted. */
export type ScreenShareCodec = 'h264' | 'vp9' | 'vp8' | 'h265';
/** User preference (Settings → Advanced). 'auto' picks per machine. H.265 is
 *  never a preference: it comes only from the room negotiation
 *  (hevcNegotiation.ts), because a viewer who cannot decode it sees nothing. */
export type ScreenShareCodecPref = 'auto' | Exclude<ScreenShareCodec, 'h265'>;

/**
 * Relative bitrate a codec needs for the same picture. VP9 is the baseline
 * the table below was tuned with; H.264 and VP8 need more bits for the same
 * quality, and when an encoder runs out of bits it DROPS FRAMES to stay under
 * the cap (measured: OpenH264 at 360p90 capped at 6 Mbps delivered 63-68 fps;
 * the same stream with a 25 Mbps cap delivered 90). Bandwidth is the cheap
 * side of this trade, frame rate the expensive one, so err generous.
 */
const CODEC_BITRATE_FACTOR: Record<ScreenShareCodec, number> = {
    vp9:  1.0,
    vp8:  1.25,
    h264: 1.5,
    // ~27 % under H.264 — the low end of published HEVC-vs-H.264 gains for
    // low-latency CBR hardware encoders without B-frames.
    h265: 1.1,
};

/**
 * Frame-rate multiplier on the 30 fps base ceilings. Linear up to 30 fps;
 * above that it grows with (fps/30)^0.6, not linearly: at a higher frame rate
 * each frame is a smaller step from the previous one, so the bits per frame
 * a predictive (P-frame) encoder needs fall as the rate rises. Measured rules
 * of thumb put the bitrate for the same quality at ~1.4–1.6x from 30 to 60 fps
 * (YouTube's own 1080p30 → 1080p60 / 1440p30 → 1440p60 recommendations are
 * 1.5x); 0.6 lands on 1.52x at 60 and 1.93x at 90. Rates above 90 (no picker
 * option today) get the 90 fps multiplier, like the old 3x cap did.
 */
export function ssFpsFactor(fps: number): number {
    const f = Math.min(Math.max(fps, 0), 90);
    return f <= 30 ? f / 30 : (f / 30) ** 0.6;
}

/**
 * Absolute ceiling, in VP9-equivalent bits (times CODEC_BITRATE_FACTOR, like
 * the table): VP9 16.4, H.265 18, VP8 20.5, H.264 24.6 Mbps (20 / 22 / 25 / 30 before 2026-10-31, 12.8 / 14.1 / 16 / 19.2 until 2026-11-02).
 *
 * Why there is one at all (2026-10-23 diagnostic reports): a source-resolution
 * 1440p90 H.265 share was allowed 59.4 Mbps and the NVIDIA encoder spent
 * ~57 Mbps of it. The sharer's uplink was fine (0 % loss, ~140 Mbps
 * estimated), but a viewer's downlink could not carry it: 12–26 % loss on the
 * share for long stretches, 3–10 % on every OTHER incoming track (voice
 * included) at the same moments, RTT 76 → 151 ms (a queue filling), 44
 * keyframe requests in two minutes and freezes of 2–20 s. A single layer that
 * size is something the SFU cannot thin for one subscriber. For scale,
 * YouTube's live-encoder guidance for 1440p60 is 9–18 Mbps of H.264; 22 Mbps
 * of H.265 at 1440p90 is 0.066 bits per pixel per frame, so the cap trades
 * little picture for fitting a normal home connection with headroom.
 */
export const SS_MAX_BITRATE_VP9_EQUIV = 16_400_000;

/**
 * 2026-10-31 owner decision: the 1440p90 H.265 full layer comes down from
 * ~22 to ~14 Mbps. Reports 3b0b7b70 / 4667c6fa: a viewer on a 22 Mbps layer
 * was moved to the 720p30 copy by the SFU after a 1.5 % loss blip and never
 * got back up (the SFU cannot confirm ~20 Mbps of headroom on an ordinary
 * downlink), and the layer spent its whole ceiling on game content. Every
 * resolution from 1080p up (and the absolute cap above) is scaled by the same
 * factor, so the codec ratios, the fps curve and the order of the presets are
 * exactly as before; 720p and 480p are NOT scaled - the 720p30 figure is also
 * the lighter copy's ceiling (shareLowLayer), which must not get thinner.
 * 20 -> 12.8 Mbps VP9-equivalent: H.265 x1.1 = 14.08 Mbps.
 *
 * 2026-11-02 owner decision: up to ~18 Mbps (x0.82, 16.4 VP9-equivalent). A viewer
 * saw a Mac's 90 fps H.265 share go blocky at times under the 14 Mbps ceiling, and
 * that Mac's link estimated 37 Mbps in the next test. Not proven to be the cause.
 * Still under the 22 that lost the viewer above; if a viewer
 * drops to the lighter copy after a small loss blip again, this is the first
 * number to look at.
 */
export const SS_HIGH_RES_SCALE = 0.82;

/** The named presets that stand for a fixed picture size, smallest first, with the pixels of their capture box. */
const SS_SIZED_TIERS = ([
    ['480p', 854 * 480],
    ['720p', 1280 * 720],
    ['1080p', 1920 * 1080],
    ['1440p', 2560 * 1440],
] as const).map(([res, pixels]) => ({ res, pixels }));

/**
 * Which preset a captured picture of `width` x `height` is sized like: the
 * NEAREST tier by pixel count on a ratio scale (so 1920x1200, 11 % over 1080p,
 * is a 1080p share and 1366x768 is a 720p one), a tie going to the larger
 * tier. Anything with more pixels than the 1440p tier - a 3024x1964 MacBook
 * screen, 3440x1440, 4K, 8K - returns 'source': those keep the top ceiling
 * (SS_MAX_BITRATE_VP9_EQUIV, raised on purpose on 2026-11-02 for exactly them).
 * Unknown / invalid dimensions return 'source' too (today's behaviour).
 */
export function ssTierForPixels(width: number | undefined, height: number | undefined): ScreenShareOptions['resolution'] {
    if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'source';
    const px = width * height;
    const top = SS_SIZED_TIERS[SS_SIZED_TIERS.length - 1]!;
    if (px > top.pixels) return 'source';
    let chosen = SS_SIZED_TIERS[0]!.res as ScreenShareOptions['resolution'];
    for (let i = 1; i < SS_SIZED_TIERS.length; i++) {
        const lo = SS_SIZED_TIERS[i - 1]!;
        const hi = SS_SIZED_TIERS[i]!;
        // px is nearer (in ratio) to hi than to lo when px^2 >= lo*hi.
        if (px * px >= lo.pixels * hi.pixels) chosen = hi.res;
    }
    return chosen;
}

/** The size of the picture a sender is handed: an explicit size (cropped / HDR shares, whose track reports none), else the track's own settings. */
export function senderCaptureSize(
    sender: RTCRtpSender | undefined,
    sourceSize?: { width: number; height: number },
): { width: number; height: number } | undefined {
    if (sourceSize) return sourceSize;
    const s = sender?.track?.getSettings?.();
    return s?.width && s?.height ? { width: s.width, height: s.height } : undefined;
}

// Compute the RTP maxBitrate CEILING for a screen share. It is a ceiling, not
// a target: the encoder only spends what the content needs and what the
// bandwidth estimate allows — but a hardware encoder in WebRTC's CBR-like
// mode on game content DOES spend all of it, and the receive side can be the
// bottleneck the sender's estimate never sees. Base values are tuned at
// 30fps (VP9), scaled by ssFpsFactor and held under SS_MAX_BITRATE_VP9_EQUIV.
// (History: the multiplier was linear up to 3x — 1440p90 H.265 = 59.4 Mbps,
// H.264 source 90 = 81 Mbps. That was set to stop 90 fps being starved when
// it shared 60 fps's 2x ceiling; the measured starvation was a SOFTWARE
// encoder dropping frames at 6 Mbps, far below anything here.)
// `captured` is the size of the picture the encoder is really handed. The
// 'source' preset is a LABEL ("whatever the screen is"), not a size: on a
// 1920x1080 screen it used to get the ~18 Mbps ceiling meant for a 4K / Retina
// capture, 1.7x what the explicit 1080p preset gets for the same pixels at the
// same fps and codec (diagnostic reports, 2026-11: a 1080p 'source' 90 fps
// H.265 share ramped from ~5 to 15-19 Mbps, a viewer 145-193 ms away lost 22 %
// at ~15 Mbps and froze three times for 2-4 s each, with the encoder idle).
// So a 'source' share is sized by ssTierForPixels(its real pixel count). The
// named presets are unaffected, and so is a 'source' share whose size is not
// known yet (the pre-capture publish options): both keep the label's ceiling.
export function computeSSBitrate(
    res: ScreenShareOptions['resolution'],
    fps: number,
    codec: ScreenShareCodec = 'vp9',
    captured?: { width?: number; height?: number },
): number {
    if (res === 'source' && captured) res = ssTierForPixels(captured.width, captured.height);
    const base: Record<ScreenShareOptions['resolution'], number> = {
        source:  18_000_000 * SS_HIGH_RES_SCALE,
        '1440p': 12_000_000 * SS_HIGH_RES_SCALE,
        '1080p':  6_000_000 * SS_HIGH_RES_SCALE,
        '720p':   2_000_000,
        '480p':    800_000,
    };
    const factor = CODEC_BITRATE_FACTOR[codec];
    const raw = base[res] * ssFpsFactor(fps) * factor;
    // Whole 10 kbps steps, so the table reads cleanly in logs and tests.
    return Math.round(Math.min(raw, SS_MAX_BITRATE_VP9_EQUIV * factor) / 10_000) * 10_000;
}

/** Which codecs this machine can encode in HARDWARE, per
 *  `navigator.mediaCapabilities.encodingInfo({ type: 'webrtc' }).powerEfficient`.
 *  `null` = the API is missing or failed, i.e. unknown. */
export interface HardwareEncoderSupport {
    /** H.264 in the profile LiveKit NEGOTIATES — Constrained Baseline
     *  (42e01f). This is the only H.264 answer that decides anything. */
    h264: boolean;
    vp9: boolean;
    vp8: boolean;
    /** H.264 High (640032) in hardware. The answer that matters when `h264`
     *  is false or unusable: the RTX 2080 Ti reports High ✓ / Constrained
     *  Baseline ✗ (and Chromium's Media Foundation encoder skips NVIDIA for
     *  CB even when the probe says ✓), so High is the only hardware H.264
     *  path on NVIDIA — see preferH264HighOnSender. Optional so a caller that
     *  never asked is not misread as "no". */
    h264High?: boolean;
}

/**
 * The H.264 variant a LiveKit share negotiates BY DEFAULT. LiveKit's SFU
 * (v1.9.12, livekit/protocol codecs.go) registers exactly two H.264 variants
 * for publishers — Constrained Baseline 42e01f and High 640032 — and pion
 * matches an offered H.264 format on profile_idc + constraint byte (level
 * ignored). Chromium's offer lists its software formats (no High) first, so
 * without intervention Constrained Baseline is negotiated. A bare
 * 'video/H264' asks the same question only by accident (a missing
 * profile-level-id defaults to 42e01f per RFC 6184) — spelled out so it is a
 * decision, not a default. High is negotiated only when we put it first on
 * the share's transceiver (preferH264HighOnSender).
 */
export const LIVEKIT_H264_CONTENT_TYPE = 'video/H264;profile-level-id=42e01f;packetization-mode=1';
const H264_HIGH_CONTENT_TYPE = 'video/H264;profile-level-id=640032;packetization-mode=1';

/** Which H.264 profile an H.264 share asks for. 'cb' = LiveKit's default
 *  Constrained Baseline; 'high' = High, reordered first on the transceiver. */
export type H264Profile = 'cb' | 'high';

type EncodingInfoFn = (config: {
    type: 'webrtc';
    video: { contentType: string; width: number; height: number; bitrate: number; framerate: number; scalabilityMode?: string };
}) => Promise<{ supported: boolean; powerEfficient: boolean }>;

/**
 * Ask Chromium which codecs have a hardware encoder, for the exact
 * scalability mode LiveKit will publish with: VP9 screen shares are always
 * L1T3 (livekit-client forces it), the others are a single L1T1 layer. A
 * hardware VP9 encoder that can't do temporal layers would silently fall back
 * to libvpx, so asking about plain VP9 would be the wrong question.
 *
 * Probed at ≤4K: Chromium answers from the GPU's profile list, and asking
 * about the 8K 'source' box would only make a real 4K-capable encoder look
 * unsupported.
 */
export async function probeHardwareEncoders(
    width: number,
    height: number,
    frameRate: number,
    encodingInfo: EncodingInfoFn | undefined =
        (typeof navigator !== 'undefined' && navigator.mediaCapabilities?.encodingInfo)
            ? (c => navigator.mediaCapabilities.encodingInfo(c as MediaEncodingConfiguration))
            : undefined,
): Promise<HardwareEncoderSupport | null> {
    if (!encodingInfo) return null;
    // Linux: the VA-API encoder failed earlier this session (linuxHwEncode.ts): do not take
    // MediaCapabilities' word for "hardware" again until the app restarts. The camera's probe
    // goes through here too.
    if (linuxHwEncodeDistrusted()) return { h264: false, vp9: false, vp8: false, h264High: false };
    const w = Math.min(width, 3840);
    const h = Math.min(height, 2160);
    const ask = async (contentType: string, scalabilityMode: string) => {
        try {
            const r = await encodingInfo({
                type: 'webrtc',
                video: { contentType, width: w, height: h, bitrate: 20_000_000, framerate: frameRate, scalabilityMode },
            });
            return !!(r.supported && r.powerEfficient);
        } catch {
            return false;
        }
    };
    try {
        const [h264, vp9, vp8, h264High] = await Promise.all([
            ask(LIVEKIT_H264_CONTENT_TYPE, 'L1T1'),
            ask('video/VP9', 'L1T3'),
            ask('video/VP8', 'L1T1'),
            ask(H264_HIGH_CONTENT_TYPE, 'L1T1'),
        ]);
        return { h264, vp9, vp8, h264High };
    } catch {
        return null;
    }
}

/** GPU vendors as the main process reports them (electron/capture-flags.ts
 *  summarizeGpuDevices). Only the vendor name is read here. */
export interface GpuVendorInfo { vendor: string }

/**
 * True when every real GPU on the machine is NVIDIA. Chromium's Media
 * Foundation encoder skips NVIDIA for Constrained Baseline H.264
 * (media_foundation_video_encode_accelerator_win.cc, crbug.com/1088650) —
 * AFTER MediaCapabilities has already said "power efficient", because that
 * answer comes from the GPU's profile list, not from the encoder it will
 * actually open. Microsoft's Basic Render Driver has no encoder and is
 * ignored. An empty or missing list is "unknown", not NVIDIA-only.
 */
export function isNvidiaOnly(gpus: readonly GpuVendorInfo[] | null | undefined): boolean {
    const real = (gpus ?? []).filter(g => !/^Microsoft/i.test(g.vendor));
    return real.length > 0 && real.every(g => g.vendor === 'NVIDIA');
}

/**
 * True when the GPU Chromium encodes on is NVIDIA: NVIDIA-only, OR NVIDIA is
 * the FIRST real GPU listed (Chromium's primary adapter, gpuDevice[0] — the
 * D3D11 device the GPU process opens its Media Foundation encoders on).
 *
 * Why not just "NVIDIA-only": the owner's RTX 2080 Ti + Radeon Pro WX 2100
 * (staging.174, 2026-10-24). At 1920x1080 MediaCapabilities said Constrained
 * Baseline is "power efficient" (some encoder's profile list answered), the
 * share went out as CB, and the encoder that actually opened was OpenH264 in
 * SOFTWARE (encoderImplementation "OpenH264", hw:false for the whole share,
 * 1080p60 while a game ran). Media Foundation skipped NVIDIA for CB and did
 * NOT move on to the second card, as this rule used to assume it would. High
 * on the same machine, same session, opened NVIDIA's MFT in hardware at
 * 2560x1440 90 fps. So whenever NVIDIA is the primary adapter, CB is not
 * trusted and High is preferred. (An Optimus laptop lists the Intel iGPU
 * first; its CB encoder is on the primary adapter and stays trusted.)
 */
export function nvidiaIsPrimary(gpus: readonly GpuVendorInfo[] | null | undefined): boolean {
    const real = (gpus ?? []).filter(g => !/^Microsoft/i.test(g.vendor));
    return real.length > 0 && real[0].vendor === 'NVIDIA';
}

export interface ScreenShareCodecDecision {
    codec: ScreenShareCodec;
    /** Short reason, shown in the stream-stats overlay. */
    reason: string;
    /** Only for codec 'h264': which profile to ask for. Absent = 'cb'. */
    h264Profile?: H264Profile;
}

export interface CodecDecisionOptions {
    /** A High-profile hardware encoder produced nothing earlier this session
     *  (watchH264HighStart) — do not pick High again until the app restarts. */
    h264HighFailed?: boolean;
    /** A Constrained Baseline share's encoder reported SOFTWARE this session
     *  (shareSoftwareGuard.ts): the probe's "CB is hardware" is not trusted
     *  again until the app restarts. */
    cbSoftware?: boolean;
}

/**
 * True when the hardware H.264 encoder Chromium will actually open is the
 * High-profile one: High probes as hardware, and Constrained Baseline either
 * does not (Chromium's Windows CBP gate on this GPU), or is on an NVIDIA
 * primary adapter, where Media Foundation skips NVIDIA for CB
 * (crbug.com/1088650) but not for High, or already ran in software this
 * session.
 */
function hardwareH264IsHighOnly(hw: HardwareEncoderSupport, gpus?: readonly GpuVendorInfo[] | null, cbSoftware = false): boolean {
    return !!hw.h264High && (!hw.h264 || nvidiaIsPrimary(gpus) || cbSoftware);
}

/**
 * Pick the screen-share codec (and for H.264, the profile), and say why.
 *
 * Auto prefers whatever the GPU can encode — H.264 first, because it is the
 * one codec every GPU vendor encodes in hardware:
 *   • Constrained Baseline when that is hardware (LiveKit's default profile);
 *   • otherwise High, when High is hardware — the NVIDIA case (RTX 2080 Ti:
 *     CB ✗, High ✓). LiveKit v1.9.12 accepts High from a publisher and
 *     forwards it; measured on a v1.9.12 SFU with E2EE on, a real High
 *     level-5.2 2560×1440 bitstream decrypted and decoded on the subscriber.
 * With no usable hardware encoder it picks VP8: in software it held full
 * resolution best at 1440p (measured on the GPU-less dev box, 1440p90 +
 * E2EE: VP8 45–49 fps at 2560×1440, OpenH264 44–47 fps, VP9 25 fps and
 * downscaled to 1920×1080). High has NO software encoder in Chromium (its
 * OpenH264 is Baseline/Main only), which is why a High share is watched at
 * start and falls back to VP8 if the hardware encoder produces nothing
 * (`h264HighFailed`).
 *
 * An explicit preference always wins, so a tester can A/B codecs against the
 * stats overlay; an explicit H.264 still gets the hardware profile.
 */
export function decideScreenShareCodec(
    pref: ScreenShareCodecPref,
    hw: HardwareEncoderSupport | null,
    gpus?: readonly GpuVendorInfo[] | null,
    opts: CodecDecisionOptions = {},
): ScreenShareCodecDecision {
    const cbSoftware = !!opts.cbSoftware;
    const highUsable = !!hw && !opts.h264HighFailed && hardwareH264IsHighOnly(hw, gpus, cbSoftware);
    if (pref === 'h264') {
        return highUsable
            ? { codec: 'h264', h264Profile: 'high', reason: 'set in Settings · High (HW)' }
            : { codec: 'h264', h264Profile: 'cb', reason: opts.h264HighFailed ? 'set in Settings · High HW failed → CB' : 'set in Settings' };
    }
    if (pref !== 'auto') return { codec: pref, reason: 'set in Settings' };
    if (hw?.h264 && !nvidiaIsPrimary(gpus) && !cbSoftware) return { codec: 'h264', h264Profile: 'cb', reason: 'auto: HW H.264' };
    if (highUsable) {
        return {
            codec: 'h264',
            h264Profile: 'high',
            reason: !hw!.h264 ? 'auto: HW H.264 High (CB not HW)'
                : cbSoftware ? 'auto: HW H.264 High (CB ran in software)'
                    : 'auto: HW H.264 High (NVIDIA skips CB)',
        };
    }
    if (hw?.vp9) return { codec: 'vp9', reason: 'auto: HW VP9' };
    if (!hw) return { codec: 'vp8', reason: 'auto: no probe → VP8' };
    if (opts.h264HighFailed && hw.h264High) return { codec: 'vp8', reason: 'auto: H.264 High HW encoder failed → VP8' };
    if (hw.h264 && cbSoftware) return { codec: 'vp8', reason: 'auto: H.264 CB ran in software → VP8' };
    if (hw.h264 && nvidiaIsPrimary(gpus)) return { codec: 'vp8', reason: 'auto: NVIDIA skips H.264 CB → VP8' };
    return { codec: 'vp8', reason: 'auto: no HW encoder → VP8' };
}

/** Codec only — see decideScreenShareCodec. */
export function chooseScreenShareCodec(
    pref: ScreenShareCodecPref,
    hw: HardwareEncoderSupport | null,
    gpus?: readonly GpuVendorInfo[] | null,
    opts?: CodecDecisionOptions,
): ScreenShareCodec {
    return decideScreenShareCodec(pref, hw, gpus, opts).codec;
}

// ── H.264 High on the share's transceiver ───────────────────────────────────

/** Minimal shape of an RTCRtpCodec (capabilities entry). */
export interface RtpCodecLike { mimeType: string; clockRate?: number; channels?: number; sdpFmtpLine?: string }

/**
 * A High-profile H.264 format LiveKit's SFU will MATCH: pion compares the
 * first two bytes of profile-level-id (profile_idc 0x64 AND constraint byte
 * 0x00) plus packetization-mode, level ignored. So 64001f/640033/640034 all
 * match LiveKit's 640032; Constrained High (640c..) and packetization-mode=0
 * do not.
 */
export function isLiveKitH264High(c: RtpCodecLike): boolean {
    if (!/^video\/h264$/i.test(c.mimeType)) return false;
    const f = c.sdpFmtpLine ?? '';
    return /(?:^|;)\s*profile-level-id=6400[0-9a-f]{2}(?:;|$)/i.test(f)
        && /(?:^|;)\s*packetization-mode=1(?:;|$)/.test(f);
}

/**
 * Codec preference order that makes the SFU answer with H.264 High: the
 * matching High formats first, everything else after in its existing order —
 * Constrained Baseline, VP8 etc. stay in the list, so a server that did not
 * accept High would still answer with something this sender can encode.
 * Returns null when this machine cannot SEND High at all (the sender
 * capabilities only list hardware High), i.e. nothing to change.
 *
 * Why this is enough (livekit v1.9.12, measured): the SFU's answer keeps the
 * preferred codec's variants in the order the offer listed them
 * (configureReceiverCodecs), and Chromium sends the first codec of the
 * answer — High, even with a camera already negotiated on the same
 * publisher connection.
 */
export function orderCodecsForH264High<T extends RtpCodecLike>(codecs: readonly T[]): T[] | null {
    const high = codecs.filter(isLiveKitH264High);
    if (high.length === 0) return null;
    return [...high, ...codecs.filter(c => !isLiveKitH264High(c))];
}

/** The slice of a LiveKit LocalParticipant this module needs. */
export interface PublisherLike {
    engine?: { pcManager?: { publisher?: { getTransceivers(): RTCRtpTransceiver[] } } };
}

/**
 * Put H.264 High first on the transceiver that owns `sender`. Must run
 * before the offer is created — i.e. from LiveKit's synchronous
 * `localSenderCreated` event (installH264HighPreference). Returns what it did,
 * for the log; never throws (a share must not fail over a codec preference).
 */
export function preferH264HighOnSender(
    participant: PublisherLike,
    sender: RTCRtpSender,
    capabilities: () => RtpCodecLike[] | undefined =
        () => (typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video')?.codecs : undefined),
): 'applied' | 'no-high' | 'no-transceiver' | 'failed' {
    try {
        const tr = participant.engine?.pcManager?.publisher?.getTransceivers()
            .find(t => t.sender === sender);
        if (!tr || typeof tr.setCodecPreferences !== 'function') return 'no-transceiver';
        const ordered = orderCodecsForH264High(capabilities() ?? []);
        if (!ordered) return 'no-high';
        tr.setCodecPreferences(ordered as RTCRtpCodec[]);
        return 'applied';
    } catch (err) {
        console.warn('[ScreenShare] could not prefer H.264 High:', err);
        return 'failed';
    }
}

/** LiveKit's participant event surface, narrowed. */
export interface SenderCreatedSource extends PublisherLike {
    on(event: 'localSenderCreated', cb: (sender: RTCRtpSender, track: { source?: string }) => void): unknown;
    off(event: 'localSenderCreated', cb: (sender: RTCRtpSender, track: { source?: string }) => void): unknown;
}

/**
 * Keep asking for H.264 High on every screen-share (or, with `source`
 * 'camera', camera) sender LiveKit creates
 * while `wantHigh()` says so — the first publish AND every republish
 * (LocalParticipant.republishAllTracks runs on each reconnect and builds a
 * new transceiver whose preferences would otherwise be the defaults, i.e.
 * Constrained Baseline in software). LiveKit emits localSenderCreated
 * synchronously between creating the transceiver and negotiating, which is
 * the one moment setCodecPreferences affects the offer. Returns the
 * unsubscribe.
 */
export function installH264HighPreference(
    participant: SenderCreatedSource,
    wantHigh: () => boolean,
    log: (msg: string) => void = m => console.info(m),
    source: 'screen_share' | 'camera' = 'screen_share',
): () => void {
    const onSender = (sender: RTCRtpSender, track: { source?: string }) => {
        if (track?.source !== source || !wantHigh()) return;
        log(`[${source === 'camera' ? 'Camera' : 'ScreenShare'}] H.264 High preference on the ${source === 'camera' ? 'camera' : 'share'}'s transceiver: ${preferH264HighOnSender(participant, sender)}`);
    };
    participant.on('localSenderCreated', onSender);
    return () => { participant.off('localSenderCreated', onSender); };
}

/** One stats entry, narrowed to what the start check reads. */
type StartCheckStat = {
    type: string; kind?: string; framesEncoded?: number; active?: boolean;
    qualityLimitationReason?: string;
    /** candidate-pair */
    nominated?: boolean; state?: string; availableOutgoingBitrate?: number;
};

/**
 * Below this sender-side bandwidth estimate (bits/s) the allocator may leave
 * the top layer of a simulcast share unstarted. A fresh publish starts at
 * GCC's ~300 kbps (or falls back to it - measured: 369 kbps three seconds into
 * an H.264 High 1440p90 share on a 66 Mbps link) and only climbs over tens of
 * seconds, so for that long ONLY the 720p lighter copy is fed.
 */
export const START_CHECK_STARVED_BPS = 2_000_000;
/** How long a bandwidth-starved top layer is given to wake up before the check stops waiting (and does not call it a failure). */
export const START_CHECK_STARVED_WAIT_MS = 30_000;

/**
 * After publishing with H.264 High, confirm the hardware encoder is really
 * producing frames. There is no software fallback for High in Chromium (its
 * OpenH264 does Baseline/Main only), so a High encoder that fails to open —
 * a driver fault, or NVENC's per-GPU session limit already used by a
 * recorder — leaves the share at 0 fps forever (measured on the dev box: the
 * VAAPI High encoder died and framesEncoded stayed 0 for the whole run).
 * Resolves 'ok' as soon as framesEncoded > 0, 'failed' when it is still 0
 * after `timeoutMs`, 'gone' if the sender stops answering (share ended).
 *
 * A silent layer is NOT a dead encoder when the SENDER is bandwidth-starved
 * and another layer is already encoding: libwebrtc's allocator hands the
 * first bits to the 720p copy and starts the full layer only once the
 * estimate can carry it. Owner reports 479af6c7 / 438f97a1 (1.0.24-staging.178):
 * 1440p90 H.264 High on an RTX 2080 Ti, `quality_limitation to=bandwidth`,
 * `avail_kbps=369`, only the 720p layer sending (30 fps) - and the 6 s check
 * called the High encoder dead, marked it failed for the WHOLE app session,
 * and every share after that was software VP8 (then clamped to 30 fps). The
 * same encoder started fine whenever the estimate was already a few Mbps
 * (report 884b6045). So under starvation the check keeps waiting (up to
 * START_CHECK_STARVED_WAIT_MS) and, if the layer is still unstarted, resolves
 * 'limited' - not a verdict on the encoder; the caller leaves the share
 * alone. Without starvation a silent layer is exactly the failure it was.
 */
export async function watchH264HighStart(
    getStats: () => Promise<RTCStatsReport | Iterable<StartCheckStat>>,
    opts: { timeoutMs?: number; intervalMs?: number; starvedWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<'ok' | 'failed' | 'gone' | 'limited'> {
    const timeoutMs = opts.timeoutMs ?? 6000;
    const intervalMs = opts.intervalMs ?? 1000;
    const starvedWaitMs = opts.starvedWaitMs ?? START_CHECK_STARVED_WAIT_MS;
    const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    // Per LAYER since the share got a lower layer: each layer is its own
    // hardware encoder session, and a dead full layer next to a working 720p
    // one is exactly the case to catch (NVENC session limits). 'ok' once every
    // ACTIVE layer has encoded a frame; a layer dynacast paused (active:false)
    // is not judged.
    for (let waited = 0; ; waited += intervalMs) {
        let layers = 0;
        let silent = 0;
        let limitedByBandwidth = false;
        let availBps = NaN; // sender-side bandwidth estimate, bits/s; NaN = not reported
        try {
            const report = await getStats();
            const each = (s: StartCheckStat) => {
                if (s.type === 'candidate-pair') {
                    if (s.nominated === true && s.state === 'succeeded' && typeof s.availableOutgoingBitrate === 'number') availBps = s.availableOutgoingBitrate;
                    return;
                }
                if (s.type !== 'outbound-rtp' || s.kind !== 'video' || s.active === false) return;
                layers++;
                if (!((s.framesEncoded ?? 0) > 0)) silent++;
                if (s.qualityLimitationReason === 'bandwidth') limitedByBandwidth = true;
            };
            if (typeof (report as RTCStatsReport).forEach === 'function') (report as RTCStatsReport).forEach(each as (s: unknown) => void);
            else for (const s of report as Iterable<StartCheckStat>) each(s);
        } catch {
            return 'gone';
        }
        if (layers > 0 && silent === 0) return 'ok';
        // Starved sender with at least one layer already encoding: the silent one is waiting for bits, not broken.
        const starved = silent < layers && (limitedByBandwidth || (Number.isFinite(availBps) && availBps < START_CHECK_STARVED_BPS));
        if (waited >= timeoutMs) {
            if (!starved) return 'failed';
            if (waited >= starvedWaitMs) return 'limited';
        }
        await sleep(intervalMs);
    }
}

/** Once a High encoder has failed to start, stop choosing it for the rest of
 *  this app session (a driver that failed once will fail again; retrying it
 *  on every share would cost each one a 6 s black start). */
let h264HighFailedThisSession = false;
export function markH264HighFailed(): void {
    h264HighFailedThisSession = true;
    // High has no software encoder: if it was the hardware one that died, that is the
    // hardware encoder failing (counted only on Linux with hardware encode on).
    void noteLinuxHwEncodeFailure('high_start', { codec: 'h264' });
}
export function hasH264HighFailed(): boolean { return h264HighFailedThisSession; }
/** Test-only reset. */
export function resetH264HighFailedForTests(): void { h264HighFailedThisSession = false; h264CbSoftwareThisSession = false; }

/**
 * Capture constraints for a share's SYSTEM audio on the Chromium loopback
 * path (getDisplayMedia; the native WASAPI / ScreenCaptureKit path has no
 * processing at all). Owner rule: screen-share audio never goes through noise
 * suppression — and not through echo cancellation or AGC either, which would
 * pump and duck game/music audio. Explicit instead of relying on Chromium's
 * display-capture defaults. Pinned by screenShareAudioUnprocessed.test.ts.
 * The literal lives in audioInput.ts (the one module allowed to spell the
 * echoCancellation flag — echoCancellation.test.ts).
 */
export const SCREEN_SHARE_AUDIO_CAPTURE = UNPROCESSED_TRACK_SETTINGS;

/** A Constrained Baseline share ran on a SOFTWARE encoder (OpenH264) this app
 *  session although the probe called CB hardware (shareSoftwareGuard.ts):
 *  every later share decision stops trusting that probe answer. */
let h264CbSoftwareThisSession = false;
export function markH264CbSoftware(): void { h264CbSoftwareThisSession = true; }
export function hasH264CbSoftware(): boolean { return h264CbSoftwareThisSession; }

// ── Capture pacing ──────────────────────────────────────────────────────────

/**
 * The frame rate to ask the CAPTURER for, given the frame rate the user
 * wants to SEND. Deliberately above the target; the encoder's maxFramerate
 * stays at the target and WebRTC trims the surplus.
 *
 * Why: Chromium schedules each grab `requested_frame_duration` = floor(1000 /
 * fps) ms after the last (desktop_capture_device.cc), and on Windows that
 * timer fires 1–2 ms late every frame — the owner's DXGI log: capture_period
 * 11, measured delta_ms 11.3–13.1, i.e. ~83 fps from a 90 fps request with a
 * 3.6 ms grab. Asking for 25% more (90 → 113 → an 8 ms period) leaves room
 * for that lateness. Measured in the harness (Electron 43, X11 capturer,
 * 1280×720): request 90 → capture_period 11, mean delta 11.54 ms (86.6/s),
 * encoded 88 fps; request 113 → capture_period 8, mean delta 9.12 ms
 * (109.6/s), encoded 90 fps (89–91).
 *
 * It does not lift Chromium's CPU rule (period ≥ 2 × grab time): a 9.7 ms
 * WGC grab still caps at ~52 fps. Capped at 240 (no display we care about
 * refreshes faster, and it bounds the extra grabs).
 */
export function captureFrameRateFor(targetFps: number, ceiling?: number | null): number {
    if (!Number.isFinite(targetFps) || targetFps <= 0) return targetFps;
    // A capturer that cannot deliver more than `ceiling` (Linux Wayland/PipeWire:
    // 60, see electron/capture-flags.ts captureFpsCeiling) gains nothing from
    // being asked for 1.25x a target above it - only a faster poll. The
    // headroom is kept on top of the ceiling: polling a source exactly as fast
    // as it delivers can alias and drop frames, which is what the headroom is for.
    const base = ceiling && ceiling > 0 ? Math.min(targetFps, ceiling) : targetFps;
    return Math.min(240, Math.ceil(base * 1.25));
}

/**
 * The frame rate a capture through the Wayland portal is OPENED at: the one the person chose.
 *
 * Not captureFrameRateFor's 1.25x: that headroom is for a capturer polled by a timer that fires
 * late (DXGI, WGC). The PipeWire capturer is pushed by the compositor and Chromium samples its
 * newest frame once per period, so a 30 fps request is 30 fps (measured, Electron 43.8.1, sway and
 * GNOME: asked max 30, delivered 29.8-30; the stream underneath stays negotiated at 60 whatever is
 * asked - webrtc never lowers maxFramerate - so the request is what keeps the frames reaching the
 * encoder at the chosen rate). Above 30 the headroom stays (aliasing near the 60 ceiling).
 */
export function portalCaptureFps(frameRate: number, ceiling?: number | null): number {
    if (!Number.isFinite(frameRate) || frameRate <= 0) return frameRate;
    return frameRate <= 30 ? frameRate : captureFrameRateFor(frameRate, ceiling);
}

// ── The lower layer ─────────────────────────────────────────────────────────
//
// ON BY DEFAULT since 2026-10-23 — Settings → Advanced → "Lighter copy for
// viewers" — but only on a HARDWARE encoder, only while people watch (≥ 1 on
// a ≥ 60 fps or ≥ 1440p share, ≥ 2 otherwise), backed off for the rest of the
// share at the first sign of cost to the sharer: see shareLowLayer.ts. With it
// off a share is exactly the old single layer. It is also every viewer's
// congestion fallback: the SFU (and remoteVideoQuality's loss fallback) can
// only move a viewer whose downlink cannot carry the full layer to a layer
// that exists. A 1080p share qualifies (short side 1080), H.265 included.
//
// A share used to be ONE layer at up to 30–54 Mbps (1440p/source at 60–90 fps)
// that every viewer pulled in full — 8 viewers of one 1440p60 H.264 share is
// up to ~290 Mbps of SFU egress, from tiles most of them see as a thumbnail.
// Now an H.264 / VP8 share at ≥ 1080p also publishes a 720p ≤ 30 fps layer
// (VP8 2.5 Mbps, H.264 3 Mbps — computeSSBitrate's own 720p30 ceilings, the
// middle of the 2–3 Mbps the research pass recommends). Viewers whose tile is
// small or not focused, or who chose Reduced / Data saver, get that layer
// (remoteVideoQuality.pickShareLayer); a focused or fullscreen share still
// gets the full layer, untouched — same resolution, same 90 fps, same
// ceiling. With dynacast on, the full layer is not even ENCODED while nobody
// is focused on the share.
//
// VP9 stays single-layer: LiveKit forces VP9 screen shares onto L1T3 (one
// spatial layer), and a spatial VP9 layer would be software on every GPU but
// Intel. 720p/480p shares stay single-layer too — a 720p share's "lower"
// layer would save almost nothing.

export const SHARE_LOW_SHORT_SIDE = 720;
export const SHARE_LOW_MAX_FPS = 30;

/** Does a share of this box and codec get a lower layer? */
export function shareHasLowerLayer(res: ScreenShareOptions['resolution'], codec: ScreenShareCodec): boolean {
    if (codec === 'vp9') return false;
    const b = resolveSSResolution(res);
    return Math.min(b.width, b.height) >= 1080;
}

/** The lower layer's frame rate and bitrate ceiling. */
export function shareLowLayer(frameRate: number, codec: ScreenShareCodec): { maxFramerate: number; maxBitrate: number } {
    const fps = Math.min(SHARE_LOW_MAX_FPS, frameRate);
    return { maxFramerate: fps, maxBitrate: computeSSBitrate('720p', fps, codec) };
}

/**
 * The lower layer's encoding for the ACTUAL capture size. LiveKit derives
 * the scale from its 1280×720 preset, which collapses onto the full layer
 * when a window is captured smaller than 720p tall; this re-derives it from
 * the capture: 720p on the short side when the capture is ≥ 1000 px short
 * side, otherwise half size (a 1000×600 window → 500×300), never upscaled.
 * The bitrate shrinks with the pixel count below 720p.
 */
export function shareLowEncoding(
    captureWidth: number | undefined,
    captureHeight: number | undefined,
    frameRate: number,
    codec: ScreenShareCodec,
): { scaleResolutionDownBy: number; maxFramerate: number; maxBitrate: number } {
    const base = shareLowLayer(frameRate, codec);
    const short = Math.min(captureWidth ?? 0, captureHeight ?? 0);
    if (!(short > 0)) return { scaleResolutionDownBy: 2, ...base };
    const scale = short >= 1000 ? short / SHARE_LOW_SHORT_SIDE : 2;
    // By the layer's REAL pixel count against a 1280x720 frame. It used to be
    // (short side / 720)^2, which is the same number for 16:9 and 3x too small
    // for a 5.33:1 Surround share (1920x360 = 0.75 of 720p, not 0.25): the lower
    // layer got ~550 kbps for a racing game and the hardware encoder dropped it
    // to 9-12 fps from a 30 fps source (report 6b3ddab6, 2026-11-10).
    const longSide = Math.max(captureWidth ?? 0, captureHeight ?? 0);
    const lowPixels = (short / scale) * (longSide / scale);
    const area = Math.min(1, lowPixels / (1280 * SHARE_LOW_SHORT_SIDE));
    return {
        scaleResolutionDownBy: Math.round(scale * 1000) / 1000,
        maxFramerate: base.maxFramerate,
        maxBitrate: Math.max(300_000, Math.round((base.maxBitrate * area) / 10_000) * 10_000),
    };
}

/** The subset of livekit-client's TrackPublishOptions a screen share sets. */
export interface ScreenSharePublishOptions {
    simulcast: boolean;
    videoCodec: ScreenShareCodec;
    backupCodec: false;
    screenShareEncoding: { maxBitrate: number; maxFramerate: number; priority: RTCPriorityType };
    /** Present only with a lower layer (simulcast). */
    screenShareSimulcastLayers?: VideoPreset[];
    degradationPreference: RTCDegradationPreference;
}

/**
 * Publish options for a screen share, handed to setScreenShareEnabled().
 *
 * `screenShareEncoding` is the load-bearing field: it is what LiveKit stores
 * as the track's encoding and re-applies itself (republish, replaceTrack with
 * new dimensions), and what its VP9 start-bitrate SDP munge is derived from.
 * Leaving it unset meant all of those used LiveKit's default of 2.5 Mbps /
 * 15 fps. `degradationPreference` likewise: LiveKit re-applies its stored
 * value every time it assigns a new sender, and its default for a screen
 * share is 'maintain-resolution' — trade frame rate away first.
 *
 * `simulcast` + `screenShareSimulcastLayers`: the 720p lower layer (see
 * shareHasLowerLayer); LiveKit then publishes [720p, full] as rids q / h, so
 * the full layer is the MEDIUM quality to the SFU — viewers ask by layer, not
 * by name (remoteVideoQuality.pickShareLayer). `backupCodec: false` —
 * LiveKit disables backup codecs under E2EE anyway.
 */
export function buildScreenSharePublishOptions(
    res: ScreenShareOptions['resolution'],
    frameRate: number,
    codec: ScreenShareCodec,
    opts: { lowerLayer?: boolean; /** The picture's real size, when the track exists already (a codec switch): sizes a 'source' share (computeSSBitrate). */ captured?: { width?: number; height?: number } } = {},
): ScreenSharePublishOptions {
    const layered = !!opts.lowerLayer && shareHasLowerLayer(res, codec);
    const low = shareLowLayer(frameRate, codec);
    return {
        simulcast: layered,
        videoCodec: codec,
        backupCodec: false,
        screenShareEncoding: {
            maxBitrate: computeSSBitrate(res, frameRate, codec, opts.captured),
            maxFramerate: frameRate,
            priority: 'high',
        },
        ...(layered ? { screenShareSimulcastLayers: [new VideoPreset(1280, 720, low.maxBitrate, low.maxFramerate, 'high')] } : {}),
        degradationPreference: 'maintain-framerate',
    };
}

/** Narrow an arbitrary string (a LiveKit track's `codec`) to a screen-share codec. */
export function asScreenShareCodec(codec: string | undefined): ScreenShareCodec | undefined {
    return codec === 'h264' || codec === 'vp9' || codec === 'vp8' || codec === 'h265' ? codec : undefined;
}

/**
 * Encoder overrides a screen share needs on its RTP sender.
 *
 * Since `buildScreenSharePublishOptions` hands LiveKit the right encoding up
 * front, this is now the belt to that pair of braces: it re-asserts the same
 * values after any path that could have replaced them.
 *
 * Idempotent and re-appliable on purpose: these live on the RTCRtpSender, and
 * LiveKit builds a NEW sender whenever it republishes. Screen shares are exempt
 * from its restartTrack path but NOT from republishing —
 * LocalParticipant.republishAllTracks() runs on every reconnect and calls
 * publishOrRepublishTrack() for the screen share regardless. So after any
 * network blip these silently reverted to defaults, dropping a 90 fps share
 * back to default framerate handling with nothing in the UI to indicate it.
 *
 * (This used to also set a non-standard `startBitrate`. Chromium drops unknown
 * encoding members — getParameters() after the call never contains it — so it
 * never did anything. The start bitrate that DOES apply is LiveKit's
 * x-google-start-bitrate SDP munge, which is why screenShareEncoding matters.)
 */
export async function applyScreenShareSenderParams(
    sender: RTCRtpSender,
    frameRate: number,
    maxBitrate: number,
    opts: {
        codec?: ScreenShareCodec;
        /** The size the sender is actually handed, when the track cannot say
         *  (a cropped, generated track reports none). Default: the track's own settings. */
        sourceSize?: { width: number; height: number };
        /** Black-screen fallback step (shareEncoderLimits RESOLUTION_STEP_PIXELS). Default 0. */
        step?: number;
        /** The user's resolution choice as a box, for a source the capturer did not
         *  fit to it (a cropped screen): the encoding is scaled to fit inside. */
        box?: { width: number; height: number };
    } = {},
): Promise<void> {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
    }
    // With a lower layer, LiveKit orders the encodings low → full: only the
    // LAST is the full layer (the requested frame rate and ceiling). The
    // lower one gets its own ≤ 30 fps / ~2.5–3 Mbps, re-derived from the
    // actual capture size. `active` is never touched — dynacast owns it.
    const n = params.encodings.length;
    const settings = sender.track?.getSettings?.();
    const size = opts.sourceSize ?? { width: settings?.width, height: settings?.height };
    // The encoder-size clamp, from the size the sender REALLY receives: the
    // capture box (captureBoxFor) normally already kept it legal; this holds
    // the line when it did not (a source the box could not shrink, a fallback
    // step after an encoder stall). Scale 1 = nothing to do.
    const limitPlan = planEncode(opts.codec ?? 'h264', size.width, size.height, opts.step ?? 0);
    const boxScale = opts.box && size.width && size.height
        ? Math.max(1, size.width / opts.box.width, size.height / opts.box.height)
        : 1;
    const plan = { scale: Math.ceil(Math.max(limitPlan.scale, boxScale) * 1e6) / 1e6 };
    const low = n > 1 ? shareLowEncoding(size.width, size.height, frameRate, opts.codec ?? 'vp8') : null;
    params.encodings.forEach((enc, i) => {
        if (low && i < n - 1) {
            // The lighter copy must stay lighter than a clamped full layer.
            enc.scaleResolutionDownBy = plan.scale > 1
                ? Math.max(low.scaleResolutionDownBy, Math.round(plan.scale * 1.5 * 1000) / 1000)
                : low.scaleResolutionDownBy;
            enc.maxFramerate = low.maxFramerate;
            enc.maxBitrate   = low.maxBitrate;
        } else {
            enc.maxFramerate = frameRate;
            enc.maxBitrate   = maxBitrate;
            if (plan.scale > 1) enc.scaleResolutionDownBy = plan.scale;
            // Undo OUR earlier downscale when the capture no longer needs it.
            else if (enc.scaleResolutionDownBy !== undefined && enc.scaleResolutionDownBy > 1) enc.scaleResolutionDownBy = 1;
        }
        // Raise stream priority so GCC probes this flow aggressively. Chromium
        // takes the priority of the WHOLE sender from encodings[0] and rejects
        // any change to another encoding's ("Attempted to set an unimplemented
        // parameter" — measured with two layers in the harness), so only the
        // first is touched.
        if (i === 0) {
            enc.priority        = 'high';
            enc.networkPriority = 'high';
        }
    });
    // Drop RESOLUTION, never framerate, under congestion. The default for screen
    // content is the opposite, which renders games at single-digit fps in
    // exchange for a crisp still image.
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
}

/**
 * Retarget a LIVE screen-share track's quality in place — no unpublish, no
 * re-acquire, no renegotiation.
 *
 * A quality change keeps the SAME capture source, so there is nothing to
 * re-acquire. Both knobs can be retargeted on the running track:
 *   • capture side — applyConstraints() retargets the display capturer's
 *     scale/rate with no new handshake.
 *   • encoder side — applyScreenShareSenderParams() is idempotent and
 *     re-appliable by design, and is what actually governs maxFramerate /
 *     maxBitrate.
 * Neither touches the RTCRtpSender's track identity, so subscribers keep the
 * same publication and never see the share drop.
 *
 * Through the Wayland portal (opts.viaPortal) a changed constraint is a new portal
 * session (measured: +1 ScreenCast.Start per change, up and down), and a re-open stalls
 * the capture (portalCapturePlan.ts has the numbers). The capture is opened once at the
 * SOURCE's size and the chosen rate (sharePlatformSupport.portalCaptureRequest); the size
 * is then the sender's alone (scaleResolutionDownBy from the user's box), a lower rate is
 * the sender's (maxFramerate), and only a HIGHER rate than the capture was opened at
 * re-opens it (opts.onReopen says so first, so the caller can show "Applying...").
 *
 * Returns true when the retune landed. Returns false — having changed nothing
 * observable — when there is no live track/sender to retune, or when the
 * platform refuses the constraints (OverconstrainedError, a track that went
 * stale between lookup and call). The caller then falls back to the original
 * stop-then-republish, so the worst case is exactly the old behaviour rather
 * than a dead share.
 *
 * Deliberately module-scope, like applyScreenShareSenderParams above: it is
 * pure plumbing over the LiveKit/WebRTC objects it is handed, it keeps the
 * performance.now() instrumentation out of a function that React's compiler
 * treats as render-reachable, and it is unit-testable without a component.
 */
export async function retuneScreenShareInPlace(
    // `codec` is LiveKit's LocalVideoTrack.codec (set at publish) — it picks the
    // bitrate ceiling's codec factor so a retune keeps the same headroom the
    // share was published with.
    track: { mediaStreamTrack?: MediaStreamTrack; sender?: RTCRtpSender; codec?: string } | undefined,
    resolution: ScreenShareOptions['resolution'],
    frameRate: ScreenShareOptions['frameRate'],
    // `captured`: the size the share is delivering at NATIVE size, for a 'source'
    // retune (computeSSBitrate). Only the caller knows whether the track's
    // current settings are native - after a switch FROM a named preset they
    // still read that preset's box until the next frame - so it is passed in,
    // and absent means the label's ceiling.
    // `viaPortal`: the capture is the desktop portal's (Linux Wayland). Its capturer answers a changed
    // constraint with a NEW portal session - the desktop's chooser again - so a retune there never
    // touches the capture: the frame rate is the sender's maxFramerate and the size is the sender's
    // scaleResolutionDownBy, from the capture the share was started with (sharePlatformSupport
    // retuneTouchesCapture / portalCaptureRequest). Off the portal: unchanged.
    //
    // Whether the capture is re-opened on the portal is portalCapturePlan.portalRetuneTouchesCapture: on a
    // desktop whose portal restores a listed source with no dialog (`restoreListed`) it always follows the new
    // quality, up and down; elsewhere only when the new quality needs more than the capture was asked for
    // (`asked`). `onAsked` receives what the capture was asked for after a re-open.
    opts: {
        step?: number; captured?: { width?: number; height?: number }; viaPortal?: boolean;
        restoreListed?: boolean; asked?: CaptureAsk | null; ceiling?: number | null; onAsked?: (a: CaptureAsk) => void;
        /** The capture is about to be re-opened (portal only): a short stall the caller may want to say out loud. */
        onReopen?: () => void;
    } = {},
): Promise<boolean> {
    const msTrack = track?.mediaStreamTrack;
    const sender  = track?.sender;
    if (!msTrack || msTrack.readyState !== 'live' || !sender) {
        console.warn('[ScreenShare] no live track/sender for in-place retune — republishing');
        return false;
    }
    const t0 = performance.now();
    try {
        const codecNow = asScreenShareCodec(track.codec) ?? 'vp8';
        const dims = captureBoxFor(resolution, codecNow);
        // Through the portal the capture is the SOURCE's size and the picked resolution is the sender's scale
        // (portalCapturePlan): only a higher frame rate than the capture was opened at re-opens it.
        const native = opts.viaPortal ? captureBoxFor('source', codecNow) : dims;
        const wantAsk: CaptureAsk = { fps: opts.viaPortal ? portalCaptureFps(frameRate, opts.ceiling) : captureFrameRateFor(frameRate), width: native.width, height: native.height };
        const touchCapture = !opts.viaPortal || portalRetuneTouchesCapture({ restoreListed: opts.restoreListed === true, asked: opts.asked ?? null, want: wantAsk });
        if (touchCapture) {
            if (opts.viaPortal) opts.onReopen?.();
            await msTrack.applyConstraints({
                width:     { max: wantAsk.width },
                height:    { max: wantAsk.height },
                // Capture above the target (captureFrameRateFor); the encoder's
                // maxFramerate below stays at the target. (The portal's capture is
                // asked for exactly the chosen rate: portalCaptureFps.)
                frameRate: { max: wantAsk.fps },
            });
            if (opts.viaPortal) opts.onAsked?.(wantAsk);
        }
        const tConstraints = performance.now();
        await applyScreenShareSenderParams(
            sender, frameRate, computeSSBitrate(resolution, frameRate, asScreenShareCodec(track.codec), opts.captured),
            // Through the portal the capture is always the source's size, so the chosen size is a scale on the sender.
            { codec: asScreenShareCodec(track.codec), step: opts.step, ...(opts.viaPortal ? { box: dims } : {}) },
        );
        const tParams = performance.now();

        const applied = msTrack.getSettings();
        console.info(
            `[ScreenShare] quality retuned in place in ${(tParams - t0).toFixed(0)}ms ` +
            `(${!touchCapture ? 'capture untouched (portal)' : `applyConstraints ${(tConstraints - t0).toFixed(0)}ms`}, ` +
            `setParameters ${(tParams - tConstraints).toFixed(0)}ms) — ` +
            `capture now ${applied.width ?? '?'}x${applied.height ?? '?'}@${applied.frameRate ?? '?'}fps`
        );
        return true;
    } catch (err) {
        console.warn('[ScreenShare] in-place retune failed, falling back to republish:', err);
        return false;
    }
}

/**
 * The highest frame rate a share of this source may ask for. A single window
 * goes through Windows.Graphics.Capture, which delivered 55-58 fps on the owner's
 * PC with the encoder running at 85+ (window capture also needs a capture path of
 * our own to go faster, owner 2026-10-31: later). So 90 is offered for an entire
 * screen only, instead of promising what a window share cannot deliver.
 */
export function maxShareFps(
    sourceId: string | null | undefined,
    platform: string | undefined = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined,
): 60 | 90 {
    // Linux: the cap is a Windows.Graphics.Capture measurement and does not apply
    // there, and the id cannot be trusted to tell a screen from a window: the
    // owner picked an entire screen on Linux (2026-11-03, 1.0.24-staging.192) and
    // the picker called it a window and refused 90.
    if (platform === 'linux') return 90;
    return sourceId?.startsWith('window:') ? 60 : 90;
}

/** `frameRate`, held to what this source can deliver. */
export function clampShareFps(
    frameRate: ScreenShareOptions['frameRate'],
    sourceId: string | null | undefined,
): ScreenShareOptions['frameRate'] {
    return frameRate > maxShareFps(sourceId) ? maxShareFps(sourceId) : frameRate;
}
