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

/** True when `next` points at the very same capture source, layout and audio setting as the live share. */
export function sameLiveCapture(cur: ScreenShareOptions, next: ScreenShareOptions): boolean {
    return cur.sourceId === next.sourceId
        && sameShareLayout(cur.layout, next.layout)
        && !!cur.audio === !!next.audio;
}

/** True when the quality (resolution or frame rate) differs. */
export function qualityDiffers(cur: ScreenShareOptions, next: ScreenShareOptions): boolean {
    return cur.resolution !== next.resolution || cur.frameRate !== next.frameRate;
}

export interface LiveShareApplier {
    /** A cropped (single-screen) share has no display-capture track to retune; it must be rebuilt instead. */
    cropActive(): boolean;
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
    /** The black-screen fallback step. */
    step: number;
    layout: 'whole' | 'slice';
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
    const plan = planEncode(codec, i.capture?.width, i.capture?.height, i.step);
    const hasCap = !!(i.capture?.width && i.capture?.height);
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
            res: plan.width ? `${plan.width}x${plan.height}` : '',
            scale: plan.scale,
            layout: i.layout,
            step: i.step,
            over: plan.overLimit,
        },
    };
}
