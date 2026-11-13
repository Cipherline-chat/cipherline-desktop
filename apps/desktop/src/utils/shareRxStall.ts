/**
 * Receive side: a remote share whose frames KEEP ARRIVING while none is decoded.
 *
 * ── The report (Windows viewer, RTX + D3D11 H.265, 2026-11-02)
 *
 * A Mac's share changed size mid-stream (libwebrtc's own cpu downscale,
 * 3024x1964 -> 2268x1472). The viewer decoded the new size's first keyframe
 * (keyFramesDecoded +1, frameWidth 2268) and then, for 22 s: framesReceived
 * 89.7/s, framesDecoded 0, framesDropped 90/s, packets lost 0, NACKs 0, and
 * pliCount 0 - the viewer never asked for a keyframe. It ended the moment the
 * sender's size changed back (a new keyframe). The decoder string never left
 * `ExternalDecoder (D3D11VideoDecoder)`; an earlier share in the same report
 * showed the same shape and the decoder name turned into `NullVideoDecoder
 * (fallback from: ExternalDecoder (D3D11VideoDecoder)...`. No existing event
 * could tell WHERE the frames died:
 *   - dropped by the jitter buffer / frame buffer before the decoder
 *     (jitterBufferEmittedCount stops rising with framesReceived),
 *   - handed to the decoder and not decoded (emitted keeps rising, decoded flat),
 *   - undecryptable (framesReceived would NOT rise: LiveKit's cryptor drops a
 *     frame it cannot authenticate before WebRTC counts it, and says so as
 *     e2ee_decrypt_error).
 * and whether a keyframe was requested at all. This logs those, once per stall.
 *
 * ── Why it happens (reports cd4f4ce5, c704ba3e, 2026-11-08, read with the source
 *    of Chromium 150 and libwebrtc branch 7871; not reproduced on real hardware)
 *
 * Same shape again: 2560x1440 H.265 at 88 fps on D3D11, stalls of 12, 12 and 28 s
 * with emit = drop = rx, decoded 0, loss 0, PLI 0. Two pieces of the browser explain
 * every one of those numbers:
 *   - RTCVideoDecoderAdapter drops its queue and asks for a keyframe when 8 frames
 *     are pending, but only `if (HasSoftwareFallback(codec))`, which is false for
 *     HEVC. An H.265 decoder that falls behind gets an unbounded queue, returns OK
 *     to everything, and nothing ever asks for a keyframe: PLI 0.
 *   - libwebrtc remembers the last 10 frames it handed to the decoder
 *     (kDecoderFrameMemoryLength). Each new frame evicts the oldest, which counts
 *     as dropped: drop = emit. An output older than that is thrown away uncounted
 *     ("Too many frames backed up in the decoder"): decoded 0.
 * So once the queue is more than 10 frames deep every picture the decoder produces
 * is discarded, and it stays that way while frames keep coming about as fast as the
 * decoder finishes them. The windows just before a stall (rx 86, dec 52, drop 32)
 * are the depth hovering around 10.
 *
 * Frame rate: at 88 fps those 10 frames are 113 ms of decoder delay (167 ms at 60,
 * 333 ms at 30), and the queue only shrinks by what the decoder can do above the
 * input rate. Every stall in these reports is at 67 fps or more (the 2026-11-02 one
 * at 90); the same viewer decoded this sender at 72, 45 and 22 fps with at most
 * 0.9 drops/s. So 90 fps narrows the margin, but it is not shown to be sufficient:
 * at 84-91 fps the same decoder also ran clean for ~15 s at a time. What deepens the
 * queue first is unproven (one stall follows a 14 Mbit/s burst and a keyframe, others
 * do not).
 *
 * Recovery: shareRxStallRecovery.ts. Counts, rates and a decoder implementation name only.
 */
import type { ShareRxSnapshot } from './shareRxStats';

type Detail = Record<string, string | number | boolean>;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Frames must be arriving at least this fast for "arriving but not decoding" to mean anything. */
export const STALL_MIN_RX_FPS = 5;
/** Not decoding for this long (two monitor ticks) before it is a stall. */
export const STALL_MS = 3_500;
/** A size change this recent before the stall began is recorded as its likely trigger. */
export const STALL_RESIZE_WINDOW_MS = 15_000;

interface Open { since: number; kf0: number; req0: number }

export class RxStallWatch {
    private prev: ShareRxSnapshot | null = null;
    private candidateSince: number | null = null;
    private open: Open | null = null;
    private lastSize = '';
    private resizedAt = -Infinity;
    private ref: string | undefined;
    private track = '';

    setRef(ref: string | undefined): void { if (ref) this.ref = ref; }

    /** A stall has been declared and has not ended. */
    get stalled(): boolean { return this.open !== null; }

    /** Feed every monitor tick. Returns the event detail to log, if any. */
    observe(now: number, cur: ShareRxSnapshot, track: string): Detail | null {
        this.track = track;
        const prev = this.prev;
        this.prev = cur;
        const size = cur.width && cur.height ? `${cur.width}x${cur.height}` : '';
        if (size && this.lastSize && size !== this.lastSize) this.resizedAt = now;
        if (size) this.lastSize = size;
        if (!prev) return null;
        const dt = (cur.at - prev.at) / 1000;
        if (!(dt >= 0.5)) return null;
        if (cur.framesReceived < prev.framesReceived || cur.framesDecoded < prev.framesDecoded) { this.candidateSince = null; return null; }
        const rx = (cur.framesReceived - prev.framesReceived) / dt;
        const dec = (cur.framesDecoded - prev.framesDecoded) / dt;
        const emit = (cur.jbEmitted - prev.jbEmitted) / dt;
        const drop = (cur.framesDropped - prev.framesDropped) / dt;
        const stalled = rx >= STALL_MIN_RX_FPS && dec === 0;

        if (this.open) {
            if (dec > 0) {
                const o = this.open;
                this.open = null; this.candidateSince = null;
                return this.detail('end', {
                    ms: Math.round(now - o.since),
                    kf: Math.max(0, (cur.keyFrames ?? 0) - o.kf0),
                    pli: Math.max(0, (cur.kfRequests ?? 0) - o.req0),
                }, cur);
            }
            return null;
        }
        if (!stalled) { this.candidateSince = null; return null; }
        if (this.candidateSince === null) this.candidateSince = now;
        if (now - this.candidateSince < STALL_MS) return null;
        this.open = {
            since: this.candidateSince, kf0: prev.keyFrames ?? 0, req0: prev.kfRequests ?? 0,
        };
        return this.detail('start', {
            rx_fps: r1(rx), emit_fps: r1(emit), drop_fps: r1(drop),
            pli: Math.max(0, (cur.kfRequests ?? 0) - (prev.kfRequests ?? 0)),
            resized: this.candidateSince - this.resizedAt <= STALL_RESIZE_WINDOW_MS,
        }, cur);
    }

    private detail(phase: 'start' | 'end', extra: Detail, cur: ShareRxSnapshot): Detail {
        const d: Detail = { phase };
        if (this.ref) d.share_ref = this.ref;
        if (this.track) d.track = this.track;
        for (const [k, v] of Object.entries(extra)) if (typeof v !== 'number' || fin(v)) d[k] = v;
        if (cur.decoder) d.decoder = cur.decoder;
        if (cur.width && cur.height) d.res = `${cur.width}x${cur.height}`;
        return d;
    }
}
