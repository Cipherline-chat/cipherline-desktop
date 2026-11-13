/**
 * Receive side: a remote video whose H.265 decoder DIED mid-stream.
 *
 * ── What the reports showed (1.0.24-staging.187, viewer on D3D11)
 *
 * A 1080x1920 H.265 share decoded fine on the hardware decoder for minutes, sat
 * at 1 fps (static content), then the streamer's content moved and it went to
 * 88 fps. Within one 2 s monitor tick the inbound stats read
 *
 *     decoder "NullVideoDecoder (fallback from: ExternalDecoder (D3D11VideoDecoder))"
 *
 * and from then on rx_fps stayed 88, dec_fps 0, drop_fps 88: every packet
 * arrived, none became a picture, and the tile stayed blank until the stream
 * ended (pli_count 0: nothing ever asked for anything). The owner's note was
 * "unfocused a screenshare and it went blank" - the unfocus fell inside the same
 * 12 s stats window as the failure, so the log cannot say which came first.
 *
 * Chromium has no software HEVC, so when the hardware decoder errors there is
 * nothing to fall back to and libwebrtc installs a decoder that outputs nothing.
 * The failure was per stream: the same viewer's camera (H.265) and a share
 * published later (H.265) decoded on D3D11 fine in the same call.
 *
 * ── What this does
 *
 *  - RxDecoderLostWatch says, once per death, that a video's decoder is the
 *    "nothing" decoder, and how long ago that video's displayed <video> element
 *    last changed (the unfocus / fullscreen / grid moves swap it): the one thing
 *    the log could not tell. Counts and enums only.
 *  - withdrawH265Decode() takes H.265 out of what WE advertise (cl.vdec "1:"), the
 *    lever every desktop publisher already obeys: their HevcPolicy sees "someone
 *    cannot decode H.265" and republishes as H.264 / VP8 on its next 1 s tick,
 *    through the make-before-break swap and the viewer hold. Reversible after
 *    HEVC_RETRY_MS (hevcNegotiation.markHevcDecodeFailed). Cheaper to the viewer
 *    than the alternative of staying blank, and it needs no new message.
 */
import { HEVC_ATTR, formatDecodeCaps, markHevcDecodeFailed } from './hevcNegotiation';

/** libwebrtc's name for "the decoder gave up and nothing replaced it". */
export function isDecoderDead(decoder: string | undefined | null): boolean {
    return typeof decoder === 'string' && /NullVideoDecoder/i.test(decoder);
}

export interface RxDecoderLost {
    codec?: string;
    /** Short side of the displayed element, px. */
    tile?: number;
    /** ms since the displayed <video> element last changed (to the sampling tick); -1 = it never has. */
    el_ms: number;
}

export interface RxDecoderObservation {
    decoder?: string;
    codec?: string;
}

export class RxDecoderLostWatch {
    private dead = false;
    private key: object | null = null;
    private keyAt = -1;

    /** Feed every stats sample of one remote video. Returns a value once per death. */
    observe(now: number, snap: RxDecoderObservation | null | undefined, ctx: { tile?: number; playbackKey: object | null }): RxDecoderLost | null {
        if (ctx.playbackKey !== this.key) {
            // The first element is not a change; a different one later is.
            if (this.key !== null && ctx.playbackKey !== null) this.keyAt = now;
            if (ctx.playbackKey !== null) this.key = ctx.playbackKey;
        }
        if (!snap) return null;
        const dead = isDecoderDead(snap.decoder);
        if (!dead) { this.dead = false; return null; }
        if (this.dead) return null;
        this.dead = true;
        const out: RxDecoderLost = { el_ms: this.keyAt >= 0 ? Math.max(0, Math.round(now - this.keyAt)) : -1 };
        if (snap.codec) out.codec = snap.codec;
        if (ctx.tile !== undefined) out.tile = ctx.tile;
        return out;
    }
}

export interface DecoderLostRoom {
    localParticipant: { setAttributes(attrs: Record<string, string>): Promise<unknown> };
}

/**
 * Whether a dead decoder should take H.265 out of this client's capabilities.
 * Only H.265 can be in this state (H.264 / VP8 / VP9 fall back to software), so
 * any other codec is left alone; an unknown codec on the "nothing" decoder is
 * treated as H.265.
 */
export function shouldWithdrawH265(lost: RxDecoderLost): boolean {
    return lost.codec === undefined || lost.codec === 'h265';
}

/** Stop advertising H.265 decode. Returns whether it did. Never throws. */
export function withdrawH265Decode(room: DecoderLostRoom, lost: RxDecoderLost, now: number = Date.now()): boolean {
    if (!shouldWithdrawH265(lost)) return false;
    markHevcDecodeFailed(now);
    void room.localParticipant.setAttributes({ [HEVC_ATTR]: formatDecodeCaps({ h265: false }) }).catch(() => { /* room closing */ });
    return true;
}
