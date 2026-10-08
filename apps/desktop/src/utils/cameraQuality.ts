/**
 * Outgoing camera quality — what we capture, the simulcast ladder we publish,
 * and which encoder we ask for. Pure: no LiveKit objects, no DOM (the impure
 * half is utils/cameraPublish.ts).
 *
 * Why this exists (measured, see the commit): the camera used to publish a
 * fixed ladder — LiveKit presets h180 / h360 at 20 fps under a 1280×720
 * top — from a capture that never asked for more than 720p, all three layers
 * encoded in software VP8 all the time (dynacast off). Two consequences:
 *   1. a focused tile could never look better than 720p at ~1.7 Mbps, and the
 *      mid layer that the 2–6 person grids showed was 360p at 20 fps;
 *   2. encoding every layer constantly kept the encoder busy enough that
 *      WebRTC's CPU adaptation ('balanced') shrank ALL layers (the top fell to
 *      960×540 in the harness) for the rest of the call — the "it's soft even
 *      when focused" report.
 *
 * Now:
 *   - CAPTURE at the camera's best NATIVE mode up to the tier cap (Auto =
 *     2560×1440) at 30 fps. Ideal constraints only: Chromium picks the
 *     closest real mode and never upscales, so a 720p camera publishes a
 *     720p top layer. A camera whose high modes are slow (a USB2 cam that
 *     does 1080p at 5 fps) is stepped down until it gives ≥ 24 fps: a crisp
 *     30 at a lower resolution beats a slideshow at a higher one.
 *   - LADDER built from the ACTUAL capture size: top / half / quarter, all
 *     at 30 fps. 1440p camera → 360p · 720p · 1440p; 1080p → 270p · 540p ·
 *     1080p; 720p → 180p · 360p · 720p. Powers of two keep the downscaler
 *     sharp and give every capture size the same shape, so the viewer-side
 *     tile picker (remoteVideoQuality.ts) can reason in pixels.
 *   - BITRATE per layer from pixel count (anchors below), × codec factor.
 *   - ENCODER: hardware H.264 when this machine has one (decideCameraCodec),
 *     else software VP8. Every layer is still end-to-end encrypted: LiveKit's
 *     E2EE worker encrypts VP8 (10/3 clear header bytes) and H.264 (NALU
 *     aware) frames; it throws on AV1, and VP9 would be software libvpx-vp9
 *     on NVIDIA/AMD — measured 5× VP8's encode time — so neither is offered.
 */

export type CameraQualityTier = 'auto' | '1440p' | '1080p' | '720p' | '480p';
export const CAMERA_QUALITY_TIERS: readonly CameraQualityTier[] = ['auto', '1440p', '1080p', '720p', '480p'];

/** Cap boxes (16:9). Auto aims for 1440p and takes whatever the camera has. */
const TIER_BOX: Record<Exclude<CameraQualityTier, 'auto'>, { width: number; height: number }> = {
    '1440p': { width: 2560, height: 1440 },
    '1080p': { width: 1920, height: 1080 },
    '720p': { width: 1280, height: 720 },
    '480p': { width: 854, height: 480 },
};

/** Cameras publish at 30: "a crisp 30" (owner). Never chase 60 for a webcam. */
export const CAMERA_FPS = 30;
/** Below this, a capture mode counts as too slow and we step down a tier. */
export const CAMERA_MIN_ACCEPTABLE_FPS = 24;

export function parseCameraQualityTier(raw: string | null | undefined): CameraQualityTier {
    return (CAMERA_QUALITY_TIERS as readonly string[]).includes(raw ?? '') ? raw as CameraQualityTier : 'auto';
}

/** The box a tier caps capture at. */
export function tierBox(tier: CameraQualityTier): { width: number; height: number } {
    return TIER_BOX[tier === 'auto' ? '1440p' : tier];
}

/**
 * The tier actually captured. Auto means "up to 1440p" only with a HARDWARE
 * encoder: measured libvpx VP8 realtime cost (cpu-used 6, i7-8700T, per
 * 30 fps) is 0.38 core at 720p, 1.06 cores at 1080p and ~4.7 cores at 1440p —
 * a software 1440p camera would starve a gaming PC (and did starve the dev
 * box: 10 fps). So Auto + software encoder = 1080p. An explicit 1440p
 * choice is honoured either way (the performance offer catches a PC that
 * cannot keep up).
 */
export function effectiveTier(tier: CameraQualityTier, hardwareEncoder: boolean): CameraQualityTier {
    return tier === 'auto' && !hardwareEncoder ? '1080p' : tier;
}

/** Human label for a tier (Settings, the performance offer). */
export function tierLabel(tier: CameraQualityTier): string {
    return tier === 'auto' ? 'Auto (best your camera does)' : tier;
}

/**
 * LiveKit VideoResolution for getUserMedia. Bare values are IDEAL
 * constraints (livekit-client constraintsForOptions flattens them), so an
 * unsupported size never throws: Chromium takes the nearest native mode and
 * only ever scales DOWN to the ideal, never up. No aspectRatio — forcing
 * 16:9 would crop a 4:3 camera instead of letting it deliver its own shape.
 */
export function captureResolutionFor(tier: CameraQualityTier): { width: number; height: number; frameRate: number } {
    const b = tierBox(tier);
    return { width: b.width, height: b.height, frameRate: CAMERA_FPS };
}

/** Tiers below the given capture height, best first (step-down order). */
const STEP_DOWN: readonly Exclude<CameraQualityTier, 'auto'>[] = ['1440p', '1080p', '720p', '480p'];

export interface CaptureSettingsLike { width?: number; height?: number; frameRate?: number }
export interface CaptureCapabilitiesLike { height?: { max?: number } }

/**
 * After a capture opens: is it too slow, and if so which tier to try next?
 * Returns null to keep what we have. Rules:
 *   - ≥ 24 fps → keep (that is the 30 fps mode, or close to it);
 *   - slower → the next tier strictly below the CURRENT capture height, never
 *     below 480p and never above the camera's reported max height;
 *   - nothing left → keep (a slow 480p beats no camera).
 */
export function nextStepDown(
    settings: CaptureSettingsLike,
    caps?: CaptureCapabilitiesLike | null,
): Exclude<CameraQualityTier, 'auto'> | null {
    const fps = settings.frameRate ?? 0;
    const h = Math.min(settings.width ?? 0, settings.height ?? 0) || (settings.height ?? 0);
    if (fps >= CAMERA_MIN_ACCEPTABLE_FPS || h <= 0) return null;
    const maxH = caps?.height?.max ?? Infinity;
    for (const t of STEP_DOWN) {
        const th = TIER_BOX[t].height;
        if (th < h && th <= maxH) return t;
    }
    return null;
}

// ── Ladder ─────────────────────────────────────────────────────────────────

/** 'h265' only through the room negotiation (hevcNegotiation.ts), never as a base decision. */
export type CameraCodec = 'h264' | 'vp8' | 'h265';

export interface CameraLayer { width: number; height: number; maxBitrate: number; maxFramerate: number }

/**
 * Bitrate anchors at 30 fps (VP8; pixels → bits/s). The 720p point sits in
 * the middle of the usual 1.7–2.5 Mbps band (LiveKit's own h720 is 1.7 Mbps,
 * which smears a noisy webcam picture); 1440p at 5.5 Mbps is mid-band of the
 * 4–6 Mbps a clean 1440p30 camera needs. Between anchors: log-log.
 */
const BITRATE_ANCHORS: readonly [number, number][] = [
    [320 * 180, 200_000],
    [640 * 360, 600_000],
    [960 * 540, 1_200_000],
    [1280 * 720, 2_000_000],
    [1920 * 1080, 3_500_000],
    [2560 * 1440, 5_500_000],
];
/** Hardware H.264 needs a little more than libvpx VP8 for the same picture. */
/** H.265 ≈ 0.85× VP8 (≈ 26 % under the H.264 ladder) — LiveKit's own presets
 *  scale H.265 to 0.7×; 0.85 stays on the safe side for low-latency CBR
 *  hardware encoders without B-frames. */
const CODEC_FACTOR: Record<CameraCodec, number> = { vp8: 1, h264: 1.15, h265: 0.85 };

export function cameraLayerBitrate(width: number, height: number, codec: CameraCodec = 'vp8'): number {
    const px = Math.max(1, width * height);
    const a = BITRATE_ANCHORS;
    let bps: number;
    if (px <= a[0][0]) bps = a[0][1] * Math.sqrt(px / a[0][0]);
    else if (px >= a[a.length - 1][0]) bps = a[a.length - 1][1];
    else {
        let i = 0;
        while (px > a[i + 1][0]) i++;
        const [p0, b0] = a[i];
        const [p1, b1] = a[i + 1];
        const f = Math.log(px / p0) / Math.log(p1 / p0);
        bps = Math.exp(Math.log(b0) + f * (Math.log(b1) - Math.log(b0)));
    }
    return Math.round((bps * CODEC_FACTOR[codec]) / 10_000) * 10_000;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export interface CameraLadder {
    /** The full-resolution layer ('f'), = the capture. */
    top: CameraLayer;
    /** Lower layers, smallest first — LiveKit's videoSimulcastLayers. */
    lower: CameraLayer[];
}

/**
 * The simulcast ladder for an ACTUAL capture size. LiveKit builds three
 * layers (q/h/f) when the long side is ≥ 960 px, two (q/f) from 480, one
 * below; we hand it quarter + half (or just half) so its
 * scaleResolutionDownBy comes out as exactly 4 and 2.
 */
export function cameraLadder(width: number, height: number, codec: CameraCodec = 'vp8'): CameraLadder {
    const layer = (w: number, h: number): CameraLayer => ({
        width: w, height: h, maxBitrate: cameraLayerBitrate(w, h, codec), maxFramerate: CAMERA_FPS,
    });
    const top = layer(width, height);
    const long = Math.max(width, height);
    const half = layer(even(width / 2), even(height / 2));
    const quarter = layer(even(width / 4), even(height / 4));
    if (long >= 960) return { top, lower: [quarter, half] };
    if (long >= 480) return { top, lower: [half] };
    return { top, lower: [] };
}

/** Total send rate with every layer on (the worst case for the uplink). */
export function ladderTotalBitrate(l: CameraLadder): number {
    return l.top.maxBitrate + l.lower.reduce((s, x) => s + x.maxBitrate, 0);
}

/**
 * The camera's publish options, as plain data (cameraPublish.ts turns the
 * lower layers into LiveKit VideoPresets).
 *
 * degradationPreference is pinned to 'balanced' on purpose: LiveKit's own
 * default flips to 'maintain-resolution' for any capture ≥ 1080p
 * (getDefaultDegradationPreference), which under CPU pressure keeps the
 * resolution and drops FRAMES — a slideshow. "Prioritize call video while
 * gaming" (utils/gamingVideoMode.ts on that branch) overrides this at runtime
 * with 'maintain-framerate' and restores the value it found ('balanced') when
 * switched off; it reads the track's current preference, so the two never
 * fight: the gaming mode wins while it is on, this default applies otherwise.
 */
export interface CameraPublishPlan {
    /** false = one full layer only (a 1:1 call — see CameraLayeringPolicy). */
    simulcast: boolean;
    videoCodec: CameraCodec;
    backupCodec: false;
    videoEncoding: { maxBitrate: number; maxFramerate: number };
    lower: CameraLayer[];
    degradationPreference: RTCDegradationPreference;
}

export function cameraPublishPlan(width: number, height: number, codec: CameraCodec, opts: { single?: boolean } = {}): CameraPublishPlan {
    const ladder = cameraLadder(width, height, codec);
    const single = !!opts.single;
    return {
        simulcast: !single,
        videoCodec: codec,
        // LiveKit disables backup codecs under E2EE anyway; a second codec
        // would also force dynacast-style dual encoding we do not want.
        backupCodec: false,
        videoEncoding: { maxBitrate: ladder.top.maxBitrate, maxFramerate: ladder.top.maxFramerate },
        lower: single ? [] : ladder.lower,
        degradationPreference: 'balanced',
    };
}

// ── 1:1 calls: one layer ───────────────────────────────────────────────────
//
// Dynacast only pauses layers ABOVE the best quality anyone watches, so in a
// 1:1 call with the other person watching our top layer the two lower layers
// are still encoded and uploaded for nobody — ~31% of a 1080p camera's
// upload (0.38 + 1.2 of 5.08 Mbps), ~32% at 1440p, ~29% at 720p. With exactly
// one other person in the room the camera publishes ONE layer (the top);
// the moment a third person has been there UP_MS it switches back to the
// ladder. Switching = make-before-break republish (cameraPublish.relayerCamera).
//
// Hysteresis, so a brief join/leave never flaps:
//   - to simulcast: someone else present for ≥ UP_MS (3 s) — a newcomer gets
//     our top layer for those seconds, which is only a cost, never a blank;
//   - to single: back to one other person for ≥ DOWN_MS (30 s);
//   - at most one switch per MIN_GAP_MS (20 s) either way.

export const LAYERING_UP_MS = 3_000;
export const LAYERING_DOWN_MS = 30_000;
export const LAYERING_MIN_GAP_MS = 20_000;

export type CameraLayering = 'single' | 'simulcast';

/** What a fresh publish should use, given how many OTHER people are in the room. */
export function initialLayering(remoteCount: number): CameraLayering {
    return remoteCount <= 1 ? 'single' : 'simulcast';
}

export class CameraLayeringPolicy {
    private current: CameraLayering;
    private want: CameraLayering;
    private wantSince: number;
    private lastSwitch: number;

    constructor(current: CameraLayering, now: number) {
        this.current = current;
        this.want = current;
        this.wantSince = now;
        this.lastSwitch = -Infinity;
    }

    get mode(): CameraLayering { return this.current; }

    /** The camera was (re)published with `mode` — e.g. after a fresh camera-on. */
    reset(mode: CameraLayering, now: number): void {
        this.current = mode;
        this.want = mode;
        this.wantSince = now;
    }

    /**
     * Feed the number of OTHER participants; returns the layering to switch
     * to now, or null. The caller performs the switch and then calls
     * applied() (or not, if it failed — it will be asked again).
     */
    observe(remoteCount: number, now: number): CameraLayering | null {
        const want: CameraLayering = remoteCount <= 1 ? 'single' : 'simulcast';
        if (want !== this.want) { this.want = want; this.wantSince = now; }
        if (want === this.current) return null;
        const hold = want === 'simulcast' ? LAYERING_UP_MS : LAYERING_DOWN_MS;
        if (now - this.wantSince < hold) return null;
        if (now - this.lastSwitch < LAYERING_MIN_GAP_MS) return null;
        return want;
    }

    applied(mode: CameraLayering, now: number): void {
        this.current = mode;
        this.lastSwitch = now;
    }
}

// ── Encoder choice ─────────────────────────────────────────────────────────

export type CameraCodecPref = 'auto' | CameraCodec;
/** 'h265' = like Auto, but H.265 whenever the room negotiation allows it,
 *  even with "Allow H.265 when everyone supports it" switched off. */
export const CAMERA_CODEC_PREFS: readonly CameraCodecPref[] = ['auto', 'h264', 'vp8', 'h265'];

export function parseCameraCodecPref(raw: string | null | undefined): CameraCodecPref {
    return (CAMERA_CODEC_PREFS as readonly string[]).includes(raw ?? '') ? raw as CameraCodecPref : 'auto';
}

/** Same shape as screenShare.ts HardwareEncoderSupport (structural). */
export interface CameraHwSupport { h264: boolean; h264High?: boolean; vp8: boolean }
export interface GpuVendorLike { vendor: string }

export interface CameraCodecDecision {
    codec: CameraCodec;
    /** For h264: which profile to ask for ('high' = put High first on the transceiver). */
    h264Profile?: 'cb' | 'high';
    /** Short reason, shown in the stream-stats overlay. */
    reason: string;
    /** Expected to run on a hardware encoder (decides whether Auto may go to 1440p). */
    hardware?: boolean;
}

function nvidiaOnly(gpus: readonly GpuVendorLike[] | null | undefined): boolean {
    const real = (gpus ?? []).filter(g => !/^Microsoft/i.test(g.vendor));
    return real.length > 0 && real.every(g => g.vendor === 'NVIDIA');
}

/**
 * Pick the camera encoder. Auto = hardware H.264 when the GPU has one,
 * otherwise software VP8:
 *   - Constrained Baseline in hardware (Intel Quick Sync, AMD AMF, and
 *     NVIDIA when another vendor's encoder is present) → H.264 CB. CB also
 *     has a software fallback (OpenH264), so a hardware encoder that refuses
 *     a layer degrades to software instead of going black.
 *   - NVIDIA-only (Chromium's Media Foundation encoder skips NVIDIA for CB,
 *     crbug.com/1088650; the owner's RTX 2080 Ti probes CB ✗ High ✓) → H.264
 *     High, the same route the screen share already ships. High has NO
 *     software encoder, so cameraPublish watches the first seconds and
 *     republishes as VP8 if any layer produced nothing.
 *   - Either H.264 path is ALSO checked after start: if Chromium ended up on
 *     a software encoder anyway (e.g. its simulcast adapter fell back), the
 *     camera is republished as VP8 for the session — software H.264 costs
 *     about what VP8 does and looks worse per bit, so it is never worth it.
 *   - No probe / no hardware → VP8 (what every camera used before).
 * `hwFailed` = an H.264 camera already failed this session: stay on VP8.
 * An explicit preference wins (testers A/B against the stats overlay).
 */
export function decideCameraCodec(
    pref: CameraCodecPref,
    hw: CameraHwSupport | null,
    gpus?: readonly GpuVendorLike[] | null,
    opts: { hwFailed?: boolean } = {},
): CameraCodecDecision {
    const nv = nvidiaOnly(gpus);
    const cbHw = !!hw?.h264 && !nv;
    const highHw = !!hw?.h264High && (!hw.h264 || nv);
    if (pref === 'vp8') return { codec: 'vp8', reason: 'set in Settings' };
    if (pref === 'h265') return decideCameraCodec('auto', hw, gpus, opts);
    if (pref === 'h264') {
        if (highHw && !cbHw) return { codec: 'h264', h264Profile: 'high', reason: 'set in Settings · High (HW)', hardware: true };
        return { codec: 'h264', h264Profile: 'cb', reason: 'set in Settings', hardware: cbHw };
    }
    if (opts.hwFailed) return { codec: 'vp8', reason: 'auto: HW H.264 did not hold → VP8' };
    if (!hw) return { codec: 'vp8', reason: 'auto: no probe → VP8' };
    if (cbHw) return { codec: 'h264', h264Profile: 'cb', reason: 'auto: HW H.264', hardware: true };
    if (highHw) return { codec: 'h264', h264Profile: 'high', reason: nv ? 'auto: HW H.264 High (NVIDIA)' : 'auto: HW H.264 High (CB not HW)', hardware: true };
    return { codec: 'vp8', reason: 'auto: no HW H.264 → VP8' };
}

/** The negotiated H.265 decision (hevcNegotiation.HevcPolicy said 'h265'). */
export const HEVC_CAMERA_DECISION: CameraCodecDecision = { codec: 'h265', reason: 'H.265 (everyone can decode)', hardware: true };

/**
 * The post-start check for an H.264 camera. Given each layer's encoder
 * report a few seconds in, decide whether to keep it:
 *   - 'no-frames' — some active layer encoded nothing (High's missing
 *     software fallback, an NVENC session limit) → republish as VP8;
 *   - 'software'  — frames, but not from a hardware encoder → VP8 is better;
 *   - 'ok'        — hardware is encoding.
 * `hardware` per layer is streamStatsHud.isHardwareCodec's answer (null =
 * unknown, which never by itself triggers a fallback).
 */
export interface LayerEncodeReport { active: boolean; framesEncoded: number; hardware: boolean | null }

export function judgeHardwareCameraStart(layers: readonly LayerEncodeReport[]): 'ok' | 'no-frames' | 'software' {
    const live = layers.filter(l => l.active);
    if (live.length === 0) return 'ok'; // dynacast paused everything: nothing to judge
    if (live.some(l => l.framesEncoded === 0)) return 'no-frames';
    if (live.every(l => l.hardware === false)) return 'software';
    return 'ok';
}
