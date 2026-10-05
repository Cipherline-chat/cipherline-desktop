import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

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

/** Codecs a screen share can be published with. AV1 is deliberately absent:
 *  livekit-client 2.18.8's E2EE worker throws on AV1 frames ("av1 is not yet
 *  supported for end to end encryption"), and a share is never published
 *  unencrypted. */
export type ScreenShareCodec = 'h264' | 'vp9' | 'vp8';
/** User preference (Settings → Advanced). 'auto' picks per machine. */
export type ScreenShareCodecPref = 'auto' | ScreenShareCodec;

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
};

// Compute the RTP maxBitrate CEILING for a screen share. It is a ceiling, not
// a target: the encoder only spends what the content needs and what the
// bandwidth estimate allows. Base values are tuned at 30fps (VP9) and scale
// linearly with fps up to 3× so 90fps actually has enough bits to land on
// target. Previously capped at 2× — that meant 60fps and 90fps shared the same
// bitrate ceiling, which starved the encoder at 90fps and produced the "stuck
// near 80fps" symptom.
export function computeSSBitrate(
    res: ScreenShareOptions['resolution'],
    fps: number,
    codec: ScreenShareCodec = 'vp9',
): number {
    const base: Record<ScreenShareOptions['resolution'], number> = {
        source:  18_000_000,
        '1440p': 12_000_000,
        '1080p':  6_000_000,
        '720p':   2_000_000,
        '480p':    800_000,
    };
    return Math.round(base[res] * Math.min(fps / 30, 3) * CODEC_BITRATE_FACTOR[codec]);
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
 * actually open. With another vendor's encoder present (an Intel iGPU) it
 * moves on to that one; with none it falls back to OpenH264 in software.
 * Microsoft's Basic Render Driver has no encoder and is ignored. An empty or
 * missing list is "unknown", not NVIDIA-only.
 */
export function isNvidiaOnly(gpus: readonly GpuVendorInfo[] | null | undefined): boolean {
    const real = (gpus ?? []).filter(g => !/^Microsoft/i.test(g.vendor));
    return real.length > 0 && real.every(g => g.vendor === 'NVIDIA');
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
}

/**
 * True when the hardware H.264 encoder Chromium will actually open is the
 * High-profile one: High probes as hardware, and Constrained Baseline either
 * does not (Chromium's Windows CBP gate on this GPU) or does only on an
 * NVIDIA-only machine, where Media Foundation skips NVIDIA for CB
 * (crbug.com/1088650) but not for High.
 */
function hardwareH264IsHighOnly(hw: HardwareEncoderSupport, gpus?: readonly GpuVendorInfo[] | null): boolean {
    return !!hw.h264High && (!hw.h264 || isNvidiaOnly(gpus));
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
    const highUsable = !!hw && !opts.h264HighFailed && hardwareH264IsHighOnly(hw, gpus);
    if (pref === 'h264') {
        return highUsable
            ? { codec: 'h264', h264Profile: 'high', reason: 'set in Settings · High (HW)' }
            : { codec: 'h264', h264Profile: 'cb', reason: opts.h264HighFailed ? 'set in Settings · High HW failed → CB' : 'set in Settings' };
    }
    if (pref !== 'auto') return { codec: pref, reason: 'set in Settings' };
    if (hw?.h264 && !isNvidiaOnly(gpus)) return { codec: 'h264', h264Profile: 'cb', reason: 'auto: HW H.264' };
    if (highUsable) {
        return {
            codec: 'h264',
            h264Profile: 'high',
            reason: hw!.h264 ? 'auto: HW H.264 High (NVIDIA skips CB)' : 'auto: HW H.264 High (CB not HW)',
        };
    }
    if (hw?.vp9) return { codec: 'vp9', reason: 'auto: HW VP9' };
    if (!hw) return { codec: 'vp8', reason: 'auto: no probe → VP8' };
    if (opts.h264HighFailed && hw.h264High) return { codec: 'vp8', reason: 'auto: H.264 High HW encoder failed → VP8' };
    if (hw.h264 && isNvidiaOnly(gpus)) return { codec: 'vp8', reason: 'auto: NVIDIA skips H.264 CB → VP8' };
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
 * Keep asking for H.264 High on every screen-share sender LiveKit creates
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
): () => void {
    const onSender = (sender: RTCRtpSender, track: { source?: string }) => {
        if (track?.source !== 'screen_share' || !wantHigh()) return;
        log(`[ScreenShare] H.264 High preference on the share's transceiver: ${preferH264HighOnSender(participant, sender)}`);
    };
    participant.on('localSenderCreated', onSender);
    return () => { participant.off('localSenderCreated', onSender); };
}

/**
 * After publishing with H.264 High, confirm the hardware encoder is really
 * producing frames. There is no software fallback for High in Chromium (its
 * OpenH264 does Baseline/Main only), so a High encoder that fails to open —
 * a driver fault, or NVENC's per-GPU session limit already used by a
 * recorder — leaves the share at 0 fps forever (measured on the dev box: the
 * VAAPI High encoder died and framesEncoded stayed 0 for the whole run).
 * Resolves 'ok' as soon as framesEncoded > 0, 'failed' when it is still 0
 * after `timeoutMs`, 'gone' if the sender stops answering (share ended).
 */
export async function watchH264HighStart(
    getStats: () => Promise<RTCStatsReport | Iterable<{ type: string; kind?: string; framesEncoded?: number }>>,
    opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<'ok' | 'failed' | 'gone'> {
    const timeoutMs = opts.timeoutMs ?? 6000;
    const intervalMs = opts.intervalMs ?? 1000;
    const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    for (let waited = 0; ; waited += intervalMs) {
        let frames = 0;
        try {
            const report = await getStats();
            const each = (s: { type: string; kind?: string; framesEncoded?: number }) => {
                if (s.type === 'outbound-rtp' && s.kind === 'video') frames += s.framesEncoded ?? 0;
            };
            if (typeof (report as RTCStatsReport).forEach === 'function') (report as RTCStatsReport).forEach(each);
            else for (const s of report as Iterable<{ type: string; kind?: string; framesEncoded?: number }>) each(s);
        } catch {
            return 'gone';
        }
        if (frames > 0) return 'ok';
        if (waited >= timeoutMs) return 'failed';
        await sleep(intervalMs);
    }
}

/** Once a High encoder has failed to start, stop choosing it for the rest of
 *  this app session (a driver that failed once will fail again; retrying it
 *  on every share would cost each one a 6 s black start). */
let h264HighFailedThisSession = false;
export function markH264HighFailed(): void { h264HighFailedThisSession = true; }
export function hasH264HighFailed(): boolean { return h264HighFailedThisSession; }
/** Test-only reset. */
export function resetH264HighFailedForTests(): void { h264HighFailedThisSession = false; }

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
export function captureFrameRateFor(targetFps: number): number {
    if (!Number.isFinite(targetFps) || targetFps <= 0) return targetFps;
    return Math.min(240, Math.ceil(targetFps * 1.25));
}

/** The subset of livekit-client's TrackPublishOptions a screen share sets. */
export interface ScreenSharePublishOptions {
    simulcast: false;
    videoCodec: ScreenShareCodec;
    backupCodec: false;
    screenShareEncoding: { maxBitrate: number; maxFramerate: number; priority: RTCPriorityType };
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
 * `simulcast: false` — one full-resolution layer; publishDefaults'
 * videoSimulcastLayers (≤720p) are for cameras. `backupCodec: false` —
 * LiveKit disables backup codecs under E2EE anyway, and a second simulcast
 * codec would force dynacast on.
 */
export function buildScreenSharePublishOptions(
    res: ScreenShareOptions['resolution'],
    frameRate: number,
    codec: ScreenShareCodec,
): ScreenSharePublishOptions {
    return {
        simulcast: false,
        videoCodec: codec,
        backupCodec: false,
        screenShareEncoding: {
            maxBitrate: computeSSBitrate(res, frameRate, codec),
            maxFramerate: frameRate,
            priority: 'high',
        },
        degradationPreference: 'maintain-framerate',
    };
}

/** Narrow an arbitrary string (a LiveKit track's `codec`) to a screen-share codec. */
export function asScreenShareCodec(codec: string | undefined): ScreenShareCodec | undefined {
    return codec === 'h264' || codec === 'vp9' || codec === 'vp8' ? codec : undefined;
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
): Promise<void> {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
    }
    for (const enc of params.encodings) {
        enc.maxFramerate = frameRate;
        enc.maxBitrate   = maxBitrate;
        // Raise stream priority so GCC probes this flow aggressively.
        enc.priority        = 'high';
        enc.networkPriority = 'high';
    }
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
): Promise<boolean> {
    const msTrack = track?.mediaStreamTrack;
    const sender  = track?.sender;
    if (!msTrack || msTrack.readyState !== 'live' || !sender) {
        console.warn('[ScreenShare] no live track/sender for in-place retune — republishing');
        return false;
    }
    const t0 = performance.now();
    try {
        const dims = resolveSSResolution(resolution);
        await msTrack.applyConstraints({
            width:     { max: dims.width },
            height:    { max: dims.height },
            // Capture above the target (captureFrameRateFor); the encoder's
            // maxFramerate below stays at the target.
            frameRate: { max: captureFrameRateFor(frameRate) },
        });
        const tConstraints = performance.now();
        await applyScreenShareSenderParams(
            sender, frameRate, computeSSBitrate(resolution, frameRate, asScreenShareCodec(track.codec)),
        );
        const tParams = performance.now();

        const applied = msTrack.getSettings();
        console.info(
            `[ScreenShare] quality retuned in place in ${(tParams - t0).toFixed(0)}ms ` +
            `(applyConstraints ${(tConstraints - t0).toFixed(0)}ms, ` +
            `setParameters ${(tParams - tConstraints).toFixed(0)}ms) — ` +
            `capture now ${applied.width ?? '?'}x${applied.height ?? '?'}@${applied.frameRate ?? '?'}fps`
        );
        return true;
    } catch (err) {
        console.warn('[ScreenShare] in-place retune failed, falling back to republish:', err);
        return false;
    }
}
