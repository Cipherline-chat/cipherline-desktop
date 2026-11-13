/**
 * Applying a new resolution / frame rate to a share that is ALREADY LIVE, the
 * same way whichever UI asked for it.
 *
 * There used to be two paths with different guarantees:
 *   - "Adjust quality" (the chips in the share controls) retuned the live
 *     track in place: applyConstraints on the capture (the paced capture rate,
 *     captureFrameRateFor) AND the sender encodings (maxFramerate,
 *     scaleResolutionDownBy / maxBitrate, the shareEncoderLimits clamp), then
 *     kept the share's bookkeeping in step.
 *   - the PICKER opened mid-share ("change source", also usable to re-pick the
 *     same screen at another quality) went to the hot swap, which acquired a
 *     capture with its own constraints (frameRate max = the target, not the
 *     paced capture rate), never refreshed the stored share options / the
 *     sender-param context, and logged no share_codec / share_clamp - so a
 *     higher resolution or frame rate picked there did not take effect for
 *     viewers the way the chips did.
 *
 * Now both go through the functions below. `LiveShareApplier` is the seam: the
 * component supplies the real retune (retuneScreenShareInPlace on the live
 * LiveKit track) and the bookkeeping + events; tests supply spies.
 */
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';
import type { ScreenShareCodec } from './screenShare';
import { planEncode } from './shareEncoderLimits';

type Layout = ScreenShareOptions['layout'];

/** "Whole display" is `undefined`; a slice is identified by count + index. */
export function sameShareLayout(a: Layout, b: Layout): boolean {
    const ak = a?.kind ?? 'whole';
    const bk = b?.kind ?? 'whole';
    if (ak !== bk) return false;
    if (a?.kind === 'slice' && b?.kind === 'slice') return a.count === b.count && a.index === b.index;
    return true;
}

/** The app a Linux Wayland window share takes its audio from (the handle), or null: no app, or audio off. */
const audioAppOf = (o: ScreenShareOptions): string | null => (o.audio ? o.appAudio?.handle ?? null : null);

/** True when `next` points at the very same capture source, layout and audio setting (and audio app) as the live share. */
export function sameLiveCapture(cur: ScreenShareOptions, next: ScreenShareOptions): boolean {
    return cur.sourceId === next.sourceId
        && sameShareLayout(cur.layout, next.layout)
        && !!cur.audio === !!next.audio
        && audioAppOf(cur) === audioAppOf(next);
}

/** True when the quality (resolution or frame rate) differs. */
export function qualityDiffers(cur: ScreenShareOptions, next: ScreenShareOptions): boolean {
    return cur.resolution !== next.resolution || cur.frameRate !== next.frameRate;
}

export interface LiveShareApplier {
    /** A cropped (single-screen) share has no display-capture track to retune; it must be rebuilt instead. */
    cropActive(): boolean;
    /**
     * The live share is encoded by a HARDWARE encoder (H.265, or H.264 on a GPU
     * that has it). Optional: an applier that cannot say is treated as software.
     * A hardware encoder is not re-opened at a new size in place - see
     * resolutionChangeNeedsFresh.
     */
    hardwareEncoder?(): boolean;
    /** liveFrameUnchanged for this change (the applier knows the live capture's size and the codec). Optional: absent = not proven. */
    frameUnchanged?(cur: ScreenShareOptions, next: ScreenShareOptions): boolean;
    /** retuneScreenShareInPlace on the live track: capture constraints + sender encodings. true = landed. */
    retune(resolution: ScreenShareOptions['resolution'], frameRate: ScreenShareOptions['frameRate']): Promise<boolean>;
    /**
     * The new quality is in force: record it as the current share, refresh the
     * sender-param context and the diagnostics session, and log
     * share_codec + share_clamp. `how`: 'retune' (same source, in place) or
     * 'swap' (a different source was swapped onto the sender first).
     */
    commit(next: ScreenShareOptions, how: 'retune' | 'swap'): void;
}

/**
 * Does this quality change have to be a FRESH publish (new sender, new
 * encoder) instead of an in-place retune or a hot swap?
 *
 * Yes when it keeps the same capture source but changes the RESOLUTION on a
 * HARDWARE encoder. applyConstraints() / replaceTrack() hand the running
 * encoder frames of a new size, so libwebrtc re-opens it mid-stream with
 * frames in flight. Report 45a5e136 (1.0.24-staging.179, RTX 2080 Ti, Media
 * Foundation H.265 / H.264 High): source -> 1080p in place left the sender on
 * VP8 two seconds later (share_codec_drift), and 1080p -> source in place
 * killed the renderer 0.2 s after the retune (renderer:gone exit=-1073741819,
 * 0xC0000005). A frame-rate-only change keeps the capture size and stays in
 * place; so does a software encoder, which re-opens cheaply and safely.
 */
export function resolutionChangeNeedsFresh(
    cur: ScreenShareOptions | null,
    next: ScreenShareOptions,
    hardwareEncoder: boolean,
    /** liveFrameUnchanged: the encoder keeps receiving frames of the SAME size, so nothing is re-opened. */
    frameUnchanged = false,
): boolean {
    return !!cur && hardwareEncoder && sameLiveCapture(cur, next) && cur.resolution !== next.resolution && !frameUnchanged;
}

/**
 * Would a new resolution leave the frames the encoder receives exactly as they are? True only when
 * that is PROVEN from the live capture's own size: the capture is strictly inside the CURRENT
 * size box in both dimensions (so the capturer is delivering the screen's native size, not a
 * scaled-down copy of it) and it also fits the NEW box. A capture that touches the current box in
 * either dimension might be clamped by it (a 1080p preset on a 1440p screen), so a bigger box could
 * change the size: not proven, so false and the caller republishes fresh as before.
 *
 * Why this is safe where a resolution change is not: the crash (45a5e136) and the codec fall-off
 * came from frames of a NEW size reaching a running hardware encoder. Here no frame changes size;
 * only the capture's `max` constraint and the sender's bitrate cap move, the same two things a
 * frame-rate retune already changes in place on a hardware encoder.
 */
export function liveFrameUnchanged(
    live: { width?: number; height?: number } | null | undefined,
    curBox: { width: number; height: number },
    nextBox: { width: number; height: number },
): boolean {
    const w = live?.width;
    const h = live?.height;
    if (!(typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0)) return false;
    if (!(w < curBox.width && h < curBox.height)) return false;
    return w <= nextBox.width && h <= nextBox.height;
}

/**
 * Does switching the live share to a DIFFERENT capture source have to be a
 * FRESH publish instead of the hot swap (replaceTrack onto the running sender)?
 *
 * Yes on a HARDWARE encoder. The hot swap keeps the encoder and hands it frames
 * from another capturer (WGC window <-> DXGI screen) at another size; libwebrtc
 * re-opens the hardware encoder mid-stream with frames in flight, the same
 * failure resolutionChangeNeedsFresh keeps off a resolution change. Every hot
 * swap on a hardware encoder in the reports failed:
 *   abb0f871 (1.0.24-staging.180)  window -> screen on H.264 High: the renderer
 *            died 0.2 s later (exit -1073741819, 0xC0000005);
 *   dd3e84e3 (same PC)             screen -> window on H.265: the sender fell
 *            back to OpenH264 4 s later (share_codec_drift), H.265 was latched
 *            off for the session and the share was republished anyway;
 *   e951243d (staging.176)         H.265 -> VP8 after a swap, viewers got 0 kbps.
 * A software encoder re-opens cheaply and safely and keeps the hot swap (no gap
 * for viewers). The same source (audio toggle, quality change) is not a swap.
 * A fresh publish costs viewers a short gap (the drift republish it replaces
 * took 0.3-0.6 s), against a dead stream for seconds or a crashed client.
 */
export function sourceSwapNeedsFresh(
    cur: ScreenShareOptions | null,
    next: ScreenShareOptions,
    hardwareEncoder: boolean,
): boolean {
    return !!cur && hardwareEncoder && cur.sourceId !== next.sourceId;
}

/**
 * Only the AUDIO flag differs: same source, same layout, same resolution and
 * frame rate. Nothing about the video changes, so nothing about the video
 * should be touched.
 *
 * "Disable audio" used to be routed like any other change: not a quality
 * change (the retune needs the same audio), not a different source
 * (sourceSwapNeedsFresh), so it fell to the HOT SWAP - a second getDisplayMedia
 * of the very same screen, swapped onto the running encoder with
 * replaceTrack(). On a hardware encoder that is the in-flight re-open the two
 * functions above keep off the other routes, and it is what killed the renderer
 * when the owner toggled audio on a whole-screen share (2026-10-31). The audio
 * is a separate publication (the native WASAPI capture, or the Chromium
 * loopback track), so it is switched on its own and the video is left alone.
 */
export function isAudioOnlyChange(cur: ScreenShareOptions | null, next: ScreenShareOptions): boolean {
    return !!cur
        && cur.sourceId === next.sourceId
        && sameShareLayout(cur.layout, next.layout)
        && cur.resolution === next.resolution
        && cur.frameRate === next.frameRate
        && (!!cur.audio !== !!next.audio || audioAppOf(cur) !== audioAppOf(next));
}

/**
 * The audio flag AND the quality change in one selection (the picker opened
 * mid-share, re-picking the same screen with audio off and another resolution /
 * frame rate). Neither the retune route (it needs the same audio) nor an
 * audio-only change matches, so it would fall to the hot swap - on a hardware
 * encoder a fresh publish instead, like every other hot swap there.
 */
export function audioPlusQualityNeedsFresh(
    cur: ScreenShareOptions | null,
    next: ScreenShareOptions,
    hardwareEncoder: boolean,
): boolean {
    return !!cur && hardwareEncoder && cur.sourceId === next.sourceId
        && !!cur.audio !== !!next.audio && qualityDiffers(cur, next);
}

/**
 * Same capture source, new quality: retune in place and commit. Returns false,
 * having changed nothing, when an in-place retune is not possible (the caller
 * then republishes, as before).
 */
export async function retuneLiveShare(
    applier: LiveShareApplier,
    current: ScreenShareOptions,
    resolution: ScreenShareOptions['resolution'],
    frameRate: ScreenShareOptions['frameRate'],
): Promise<boolean> {
    if (applier.cropActive()) return false;
    const nextOpts = { ...current, resolution, frameRate };
    if (resolutionChangeNeedsFresh(current, nextOpts, applier.hardwareEncoder?.() ?? false, applier.frameUnchanged?.(current, nextOpts) ?? false)) return false;
    if (!(await applier.retune(resolution, frameRate))) return false;
    applier.commit({ ...current, resolution, frameRate }, 'retune');
    return true;
}

/**
 * The route for a picker selection made while a share is live:
 *   'retune'  same source / layout / audio, different quality: the Adjust-quality path - no re-acquire, no republish
 *   'other'   anything else (a new source, a layout or audio change, or nothing changed): hot swap or republish
 */
export function routeLiveSelection(
    live: boolean,
    cur: ScreenShareOptions | null,
    next: ScreenShareOptions,
): 'retune' | 'other' {
    if (!live || !cur) return 'other';
    return sameLiveCapture(cur, next) && qualityDiffers(cur, next) ? 'retune' : 'other';
}

/**
 * Handle a picker selection made mid-share when it only changes quality.
 * Returns true when it was fully handled (retuned); false = take the hot swap / republish route.
 */
export async function applyLiveSelection(
    applier: LiveShareApplier,
    live: boolean,
    cur: ScreenShareOptions | null,
    next: ScreenShareOptions,
): Promise<boolean> {
    if (routeLiveSelection(live, cur, next) !== 'retune' || !cur) return false;
    return retuneLiveShare(applier, cur, next.resolution, next.frameRate);
}

/**
 * After a hot swap put a NEW source on the live sender: apply the chosen
 * quality with the very same retune Adjust quality uses (capture constraints +
 * sender encodings), then commit. The retune failing is not fatal - the swap
 * already carried the constraints it was acquired with - but the commit still
 * happens so bookkeeping and events describe the live share.
 * Returns whether the retune landed.
 */
export async function applyQualityAfterSwap(
    applier: LiveShareApplier,
    next: ScreenShareOptions,
): Promise<boolean> {
    let landed = false;
    try { landed = await applier.retune(next.resolution, next.frameRate); } catch { landed = false; }
    applier.commit(next, 'swap');
    return landed;
}

// ── The events a quality change leaves in the call event log ────────────────

export interface QualityEventInput {
    /** The live track's codec, if known. */
    codec: ScreenShareCodec | undefined;
    /** wantH264HighRef: the H.264 High profile is in use. */
    h264High: boolean;
    /** The encoder is a hardware one (H.265, or H.264 on a GPU that has it). */
    hardware: boolean;
    /** More than one encoding on the sender (the lighter copy). */
    lighterCopy: boolean;
    next: Pick<ScreenShareOptions, 'resolution' | 'frameRate'>;
    how: 'retune' | 'swap';
    /** The live capture's size (track settings), if readable. */
    capture?: { width?: number; height?: number };
    /**
     * The user's size choice as a box, when the capture is NOT fitted to it (the portal: the capture
     * stays at the display's own size and the sender scales it, sharePlatformSupport.retuneTouchesCapture).
     * `res` in share_clamp is then what the sender is held to (the box's fit of the capture, then the
     * codec's limits), not the capture's own size.
     */
    box?: { width: number; height: number };
    /** The black-screen fallback step. */
    step: number;
    layout: 'whole' | 'slice';
    /** Extra share_clamp keys (the size handshake of a hot swap: shareFirstFrame.settleEventDetails). */
    extra?: Record<string, string | number | boolean>;
}

/**
 * The same two events a fresh publish writes (SidebarConference.startScreenShareFrom):
 * `share_codec` (what encodes, at which target) and `share_clamp` (the capture's
 * size, what the encoder is held to, the scale between them). Keys and meanings
 * are identical; only share_codec's `reason` says it came from a retune.
 */
export function qualityEventDetails(i: QualityEventInput): {
    codec: Record<string, string | number | boolean>;
    clamp: Record<string, string | number | boolean>;
} {
    const codec: ScreenShareCodec = i.codec ?? 'vp8';
    const hasCap = !!(i.capture?.width && i.capture?.height);
    // The codec's limits / the fallback step on the capture itself...
    const limit = planEncode(codec, i.capture?.width, i.capture?.height, i.step);
    // ...and the user's box, when the capture was NOT fitted to it (the portal): the sender takes the
    // stricter of the two (applyScreenShareSenderParams), so does this.
    const boxScale = hasCap && i.box
        ? Math.max(1, i.capture!.width! / i.box.width, i.capture!.height! / i.box.height)
        : 1;
    const scale = Math.ceil(Math.max(limit.scale, boxScale) * 1e6) / 1e6;
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const outW = hasCap ? (scale === limit.scale ? limit.width : even(i.capture!.width! / scale)) : 0;
    const outH = hasCap ? (scale === limit.scale ? limit.height : even(i.capture!.height! / scale)) : 0;
    return {
        codec: {
            codec,
            profile: codec === 'h264' ? (i.h264High ? 'high' : 'cb') : 'none',
            hardware: i.hardware,
            reason: i.how === 'swap' ? 'source-swap' : 'retune',
            res: i.next.resolution,
            fps: i.next.frameRate,
            lighter_copy: i.lighterCopy,
        },
        clamp: {
            codec: i.codec ?? 'none',
            cap_res: hasCap ? `${i.capture!.width}x${i.capture!.height}` : '',
            res: outW ? `${outW}x${outH}` : '',
            scale,
            layout: i.layout,
            step: i.step,
            over: limit.overLimit,
            ...(i.extra ?? {}),
        },
    };
}
