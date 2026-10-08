/**
 * Make an H.264 / H.265 frame's Annex-B framing match what the RECEIVER will
 * see, before LiveKit's E2EE worker encrypts it.
 *
 * ── The bug this closes (viewer sees a keyframe every ~3 s; staging .147)
 *
 * livekit-client 2.18.8's frame cryptor leaves an H.26x frame in the clear up
 * to and including the first slice's NAL header (naluUtils
 * findSliceNALUUnencryptedBytes: `index + 2`) and authenticates that clear
 * prefix as AES-GCM additional data (FrameCryptor.encodeFunction /
 * decryptFrame: `additionalData: data[0 .. unencryptedBytes)`). So the
 * receiver must reconstruct the sender's prefix BYTE FOR BYTE, start codes
 * included — and it does not, whenever the encoder wrote a 3-byte start code:
 *
 *   - start codes never cross the wire: WebRTC's packetizers split the frame
 *     at start codes (common_video/h264/h264_common.cc FindNaluIndices) and
 *     send only the NAL units;
 *   - the receiver's depacketizers re-insert a 4-byte {0,0,0,1} before EVERY
 *     NAL unit (video_rtp_depacketizer_h265.cc kStartCode; H.264 likewise);
 *   - so a sender prefix like `00 00 01 <slice hdr>` (or `.. PPS 00 00 01
 *     <slice hdr>`) arrives as `00 00 00 01 <slice hdr>`: different additional
 *     data, GCM authentication fails, and the worker silently DROPS the frame.
 *
 * Which frames die depends only on the encoder's start-code habits — not on
 * the codec (H.264 and H.265 share the code path), the network, or the GPU on
 * the viewing side. Chromium hands hardware-encoder output to WebRTC as the
 * driver wrote it (media_foundation_video_encode_accelerator_win.cc copies the
 * MFT buffer; d3d12_video_encode_h26{4,5}_delegate.cc explicitly accepts a
 * driver slice starting with either `00 00 01` or `00 00 00 01`). When only
 * the delta frames carry a short start code, every delta is dropped, the
 * viewer's frame buffer starves, WebRTC asks for a keyframe after its 3 s
 * no-frame timeout, and the picture updates once per keyframe: Chrome reports
 * steady bitrate, no packet loss, no frames dropped by the decoder, and NO
 * framesPerSecond (fewer than two decoded frames in any one-second window),
 * while the publisher's pliCount climbs ~1 per 3 s. When keyframes carry one
 * too, nothing decodes at all until a lucky one — "takes forever to see their
 * camera". Encoders that always write 4-byte codes (VideoToolbox, OpenH264)
 * never hit it, which is why the Mac harness looked perfect.
 * Reproduced with the real 2.18.8 worker on real x264 / x265 / h264_vaapi
 * bitstreams and, end to end, in Electron 43 through a LiveKit 1.9.12 SFU
 * (delta frames given 3-byte codes: 0 fps, a keyframe and a PLI every ~3 s,
 * no framesPerSecond; canonicalized: 30 fps, 0 PLI). Pinned with the real
 * worker by e2eeAnnexB.test.ts: any 3-byte start code before the first slice
 * → that frame fails; canonicalized first → every frame round-trips.
 *
 * ── The fix
 *
 * Rewrite the frame exactly the way the receiver will see it — each NAL unit
 * that WebRTC's own FindNaluIndices finds, prefixed by {0,0,0,1}, any bytes
 * before the first start code dropped (WebRTC never sends those either) —
 * BEFORE LiveKit encrypts it. Then the sender's clear prefix and additional
 * data are what the receiver reconstructs, by construction. The NAL unit
 * payloads are untouched and the decoder gets an equivalent Annex-B stream;
 * nothing about the encryption changes (same key, same cipher, same frames
 * encrypted, same clear/encrypted split relative to the NAL units). Frames
 * that are already canonical (the common case) are passed through unchanged.
 *
 * Runs inside the E2EE worker (workers/e2eeWorker.ts): it wraps LiveKit's
 * `onmessage` and puts this transform in front of each sender's encoded
 * stream before LiveKit's cryptor sees it.
 */

export type E2EEVideoCodec = 'vp8' | 'h264' | 'vp9' | 'av1' | 'h265';

export interface NaluIndex {
    /** Offset of the start code (including the leading zero of a 4-byte code). */
    start: number;
    /** Offset of the NAL unit header. */
    payload: number;
    /** NAL unit length in bytes (up to the next start code, as WebRTC counts it). */
    size: number;
}

/**
 * WebRTC's H264::FindNaluIndices (common_video/h264/h264_common.cc), also
 * used by its H.265 packetizer — the exact split the sender's packetizer
 * makes, so the exact NAL units the receiver gets back.
 */
export function findNaluIndices(buf: Uint8Array): NaluIndex[] {
    const seq: NaluIndex[] = [];
    if (buf.length < 3) return seq;
    const end = buf.length - 3;
    for (let i = 0; i < end;) {
        const b2 = buf[i + 2];
        if (b2 > 1) {
            i += 3;
        } else if (b2 === 1) {
            if (buf[i + 1] === 0 && buf[i] === 0) {
                const idx: NaluIndex = { start: i, payload: i + 3, size: 0 };
                if (idx.start > 0 && buf[idx.start - 1] === 0) idx.start--;
                const prev = seq[seq.length - 1];
                if (prev) prev.size = idx.start - prev.payload;
                seq.push(idx);
            }
            i += 3;
        } else {
            i++;
        }
    }
    const last = seq[seq.length - 1];
    if (last) last.size = buf.length - last.payload;
    return seq;
}

export type AnnexBLayout =
    /** Already exactly what the receiver reconstructs. */
    | 'canonical'
    /** Some start code is 3 bytes (the AAD-breaking case). */
    | 'short_start_code'
    /** Bytes before the first start code (dropped by WebRTC's packetizer). */
    | 'leading_data'
    /** No start code at all — not Annex B; left alone. */
    | 'not_annexb';

/** How a frame's framing differs from the receiver's reconstruction. */
export function classifyAnnexB(buf: Uint8Array, nalus: NaluIndex[] = findNaluIndices(buf)): AnnexBLayout {
    if (nalus.length === 0) return 'not_annexb';
    if (nalus[0].start !== 0) return 'leading_data';
    for (const n of nalus) if (n.payload - n.start !== 4) return 'short_start_code';
    return 'canonical';
}

const START_CODE = [0, 0, 0, 1] as const;

/**
 * The frame as the receiver's depacketizer will rebuild it: every NAL unit
 * WebRTC finds, each behind {0,0,0,1}. Returns null when the frame is already
 * canonical or is not Annex B (nothing to do).
 */
export function canonicalizeAnnexB(buf: Uint8Array): Uint8Array | null {
    const nalus = findNaluIndices(buf);
    const layout = classifyAnnexB(buf, nalus);
    if (layout === 'canonical' || layout === 'not_annexb') return null;
    let total = 0;
    for (const n of nalus) total += 4 + n.size;
    const out = new Uint8Array(total);
    let o = 0;
    for (const n of nalus) {
        out.set(START_CODE, o);
        out.set(buf.subarray(n.payload, n.payload + n.size), o + 4);
        o += 4 + n.size;
    }
    return out;
}

// ── The worker hook ─────────────────────────────────────────────────────────

/** The parts of an RTCEncodedVideoFrame this touches (structural, testable). */
export interface EncodedFrameLike {
    data: ArrayBuffer;
    type?: string;
    getMetadata?(): { payloadType?: number };
}

/** Counts reported to the page (no identities, no content). */
export interface AnnexBStats {
    frames: number;
    rewritten: number;
    shortStartCode: number;
    leadingData: number;
    keyRewritten: number;
    deltaRewritten: number;
}

export const ANNEXB_STATS_KIND = 'cl:annexb-stats';
export const ANNEXB_STATS_EVERY_MS = 10_000;

/**
 * Is this an H.26x frame? Mirrors how LiveKit's cryptor decides
 * (FrameCryptor.getUnencryptedBytes: `rtpMap.get(payloadType) ?? videoCodec`),
 * and for an unknown codec only frames that already begin with a start code
 * (LiveKit would try NAL parsing on those too). Audio frames have no `type`.
 */
export function isH26xFrame(frame: EncodedFrameLike, rtpMap: ReadonlyMap<number, string>, pinned: string | undefined): boolean {
    if (!('type' in frame)) return false;
    const pt = frame.getMetadata?.().payloadType;
    const codec = (pt !== undefined ? rtpMap.get(pt) : undefined) ?? pinned;
    if (codec === 'h264' || codec === 'h265') return true;
    if (codec) return false;
    const d = new Uint8Array(frame.data, 0, Math.min(4, frame.data.byteLength));
    return d.length >= 3 && d[0] === 0 && d[1] === 0 && (d[2] === 1 || (d[2] === 0 && d[3] === 1));
}

/** Canonicalize one sender frame in place; returns its layout (for stats). */
export function canonicalizeFrame(frame: EncodedFrameLike): AnnexBLayout {
    const buf = new Uint8Array(frame.data);
    const nalus = findNaluIndices(buf);
    const layout = classifyAnnexB(buf, nalus);
    if (layout === 'short_start_code' || layout === 'leading_data') {
        const out = canonicalizeAnnexB(buf);
        if (out) frame.data = out.buffer as ArrayBuffer;
    }
    return layout;
}

interface WorkerScopeLike {
    onmessage: ((ev: MessageEvent) => unknown) | null;
    postMessage(msg: unknown): void;
}

/**
 * Wrap LiveKit's worker `onmessage` (already installed by importing its
 * worker module) so every sender ('encode') stream passes through
 * canonicalizeFrame before LiveKit's cryptor. Decode streams, keys, data
 * packets and everything else go to LiveKit untouched. Returns false (and
 * changes nothing) when there is no LiveKit handler to wrap.
 */
export function installAnnexBCanonicalizer(scope: WorkerScopeLike, now: () => number = () => Date.now()): boolean {
    const inner = scope.onmessage;
    if (typeof inner !== 'function') return false;
    let rtpMap: ReadonlyMap<number, string> = new Map();
    const pinned = new Map<string, string>();
    const stats: AnnexBStats = { frames: 0, rewritten: 0, shortStartCode: 0, leadingData: 0, keyRewritten: 0, deltaRewritten: 0 };
    let lastReport = now();
    let reported = false;
    const report = () => {
        const t = now();
        if (t - lastReport < ANNEXB_STATS_EVERY_MS) return;
        lastReport = t;
        if (stats.frames === 0 || (reported && stats.rewritten === 0)) return;
        reported = true;
        try { scope.postMessage({ kind: ANNEXB_STATS_KIND, data: { ...stats } }); } catch { /* page gone */ }
        stats.frames = stats.rewritten = stats.shortStartCode = stats.leadingData = stats.keyRewritten = stats.deltaRewritten = 0;
    };

    scope.onmessage = function (this: unknown, ev: MessageEvent) {
        const msg = ev?.data as { kind?: string; data?: Record<string, unknown> } | undefined;
        try {
            if (msg?.kind === 'setRTPMap' && msg.data?.map instanceof Map) {
                rtpMap = msg.data.map as Map<number, string>;
            } else if (msg?.kind === 'updateCodec' && typeof msg.data?.trackId === 'string' && typeof msg.data?.codec === 'string') {
                pinned.set(msg.data.trackId, msg.data.codec);
            } else if (msg?.kind === 'encode' && msg.data?.readableStream instanceof ReadableStream) {
                const trackId = typeof msg.data.trackId === 'string' ? msg.data.trackId : '';
                const codecArg = typeof msg.data.codec === 'string' ? msg.data.codec : undefined;
                const canonical = new TransformStream<EncodedFrameLike, EncodedFrameLike>({
                    transform(frame, controller) {
                        try {
                            if (isH26xFrame(frame, rtpMap, pinned.get(trackId) ?? codecArg)) {
                                stats.frames++;
                                const layout = canonicalizeFrame(frame);
                                if (layout === 'short_start_code' || layout === 'leading_data') {
                                    stats.rewritten++;
                                    if (layout === 'short_start_code') stats.shortStartCode++; else stats.leadingData++;
                                    if (frame.type === 'key') stats.keyRewritten++; else stats.deltaRewritten++;
                                }
                                report();
                            }
                        } catch { /* never block a frame on the hook */ }
                        controller.enqueue(frame);
                    },
                });
                const readableStream = (msg.data.readableStream as ReadableStream<EncodedFrameLike>).pipeThrough(canonical);
                ev = { data: { ...msg, data: { ...msg.data, readableStream } } } as MessageEvent;
            }
        } catch { /* fall through to LiveKit with the original message */ }
        return inner.call(this, ev);
    };
    return true;
}
