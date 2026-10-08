/**
 * Switch a LIVE screen share to another codec without stopping it —
 * make-before-break, the same mechanics as the camera's
 * (cameraPublish.republishCamera): publish a second screen-share publication
 * carrying a clone of the same capture with the new codec's options, re-apply
 * our sender overrides, then unpublish the old one. The capture is never
 * re-acquired (no picker, no OS prompt), and viewers' tiles keep showing the
 * old publication until it is gone, by which time the new one is flowing.
 *
 * Used by the H.265 negotiation (hevcNegotiation.ts): a viewer who cannot
 * decode H.265 joins → the share moves to its normal codec at once; they
 * leave → back to H.265 after the hysteresis. Same E2EE room, so the new
 * publication is encrypted exactly like the first. Share audio is a separate
 * publication and is not touched.
 */
import { Track } from 'livekit-client';
import {
    buildScreenSharePublishOptions, applyScreenShareSenderParams, type ScreenShareCodec,
} from './screenShare';
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';
import { logCallEvent } from './callEventLog';
import { REPUBLISH_HOLD_MS, sleepMs } from './cameraPublish';

export interface ShareParticipantLike {
    getTrackPublication(source: Track.Source): { track?: unknown; trackSid?: string } | undefined;
    publishTrack(track: never, options: Record<string, unknown>): Promise<unknown>;
    unpublishTrack(track: never, stopOnUnpublish?: boolean): Promise<unknown>;
}

interface ShareTrackLike {
    mediaStreamTrack: MediaStreamTrack;
    codec?: string;
    sender?: RTCRtpSender;
}

export async function swapShareCodec(
    lp: ShareParticipantLike,
    codec: ScreenShareCodec,
    share: Pick<ScreenShareOptions, 'resolution' | 'frameRate'>,
    deps: {
        /** `t => new LocalVideoTrack(t, undefined, true)` — user-provided: a screen capture cannot be re-opened by getUserMedia. */
        makeTrack: (mst: MediaStreamTrack) => unknown;
        /** Publish the 720p lighter copy (screenShare.shareHasLowerLayer + the HW / setting gate). */
        lowerLayer: boolean;
        reason: string;
        log?: (m: string) => void;
        holdMs?: number;
        sleep?: (ms: number) => Promise<void>;
    },
): Promise<boolean> {
    const log = deps.log ?? (m => console.info(m));
    const old = lp.getTrackPublication(Track.Source.ScreenShare)?.track as ShareTrackLike | undefined;
    if (!old?.mediaStreamTrack || old.mediaStreamTrack.readyState === 'ended') return false;
    if (old.codec === codec) return false;
    const clone = old.mediaStreamTrack.clone();
    clone.contentHint = 'motion';
    const fresh = deps.makeTrack(clone) as ShareTrackLike;
    const opts = buildScreenSharePublishOptions(share.resolution, share.frameRate, codec, { lowerLayer: deps.lowerLayer });
    try {
        await lp.publishTrack(fresh as never, { source: Track.Source.ScreenShare, ...opts });
    } catch (e) {
        clone.stop();
        log(`[ScreenShare] codec switch to ${codec} failed, keeping ${old.codec ?? '?'}: ${String(e)}`);
        return false;
    }
    if (fresh.sender) {
        await applyScreenShareSenderParams(fresh.sender, share.frameRate, opts.screenShareEncoding.maxBitrate, { codec }).catch(() => {});
    }
    // Hold both while viewers subscribe to the new one (see cameraPublish
    // REPUBLISH_HOLD_MS), then stop the old track object — the clone keeps
    // the capture source alive.
    await (deps.sleep ?? sleepMs)(deps.holdMs ?? REPUBLISH_HOLD_MS);
    try { await lp.unpublishTrack(old as never, true); } catch { /* already gone */ }
    logCallEvent('h265_switch', { track: 'self-screen', codec, reason: deps.reason });
    log(`[ScreenShare] codec switched to ${codec} (${deps.reason})`);
    return true;
}
