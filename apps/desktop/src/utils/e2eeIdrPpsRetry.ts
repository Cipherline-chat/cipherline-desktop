/**
 * H.264 IDR keyframes: re-encrypt (fresh IV) until a libwebrtc RECEIVER can
 * still read the slice's `pic_parameter_set_id` from the transmitted bytes.
 * The JS equivalent of libwebrtc's `kMaxPpsIdEncryptAttempts` loop.
 *
 * ── The asymmetry this closes
 *
 * livekit-client's cryptor leaves an H.264 frame in the clear up to the first
 * slice NAL's header + ONE byte (naluUtils findSliceNALUUnencryptedBytes:
 * `index + 2`). Every libwebrtc receiver (Chromium viewers AND the phone's
 * LiveKit Android/iOS SDKs) parses the first three ue(v) fields of an IDR
 * slice header — first_mb_in_slice, slice_type, pic_parameter_set_id — BEFORE
 * decryption:
 *   - modules/rtp_rtcp/source/video_rtp_depacketizer_h264.cc
 *     (ProcessStapAOrSingleNalu / ParseFuaNalu → PpsParser::ParseSliceHeader);
 *   - modules/video_coding/h26x_packet_buffer.cc FixH264Packet: an IDR whose
 *     id names no known PPS is dropped ("No PPS with id .. received") and the
 *     packet buffer reports `buffer_cleared` = a keyframe request.
 * With slice_type 7 (what x264 and many hardware encoders write for an IDR)
 * the two ue(v) codes take 8 bits, so the pps id starts at the first CIPHERTEXT
 * bit: the receiver reads random bits and drops about half of such keyframes
 * (measured 46-51 % delivery, mobile lane share-rx, 2026-11-16).
 *
 * libwebrtc's own (native) sender copes: api/crypto/frame_crypto_transformer.cc
 * (webrtc-sdk m150_release) re-encrypts with a new IV, up to 16 attempts, until
 * `ParseH264IdrPpsId(<sent slice>) == <true id>`. The receiver takes the IV
 * from the trailer, so no receiver change. This module does the same around
 * LiveKit's JS cryptor, without touching it.
 *
 * ── How (no change to keys, cipher, AAD or the clear-prefix rule)
 *
 *   upstream → [hold stage] → LiveKit cryptor → [check stage] → real sender sink
 *
 * The hold stage forwards every frame; for an H.264 IDR keyframe it also keeps
 * a copy of the plaintext (the canonical Annex-B frame the cryptor will see)
 * and then WAITS (later frames queue upstream) until the check stage has seen
 * that frame come out. The check stage parses what is about to go on the wire
 * exactly as libwebrtc's receiver does; if the id is wrong it restores the
 * plaintext into the SAME frame object and feeds it to the cryptor again.
 * LiveKit's makeIV() takes a new sendCount on every call (the third IV word
 * is `timestamp - sendCount % 0xffff`), so every attempt is encrypted under a
 * distinct IV with the same key: AES-GCM nonce uniqueness is preserved (16
 * consecutive counts are always distinct mod 0xffff). After the last attempt
 * the frame is sent as it is, like libwebrtc. Per-keyframe only; delta frames,
 * audio and non-H.264 codecs are forwarded untouched. A timeout releases the
 * hold if the cryptor drops the frame (missing key etc.).
 *
 * H.265 has NO equivalent pre-decrypt id parse: video_rtp_depacketizer_h265.cc
 * reads only first_slice_segment_in_pic_flag (a ciphertext bit), and its
 * result is overwritten by H26xPacketBuffer::MaybeAssembleFrame — so nothing
 * to retry for HEVC.
 */

/** libwebrtc kMaxPpsIdEncryptAttempts. */
export const MAX_PPS_ID_ATTEMPTS = 16;
/** Safety valve: if the cryptor never hands the frame back, stop holding. */
export const PPS_RETRY_HOLD_TIMEOUT_MS = 500;
/** Bytes of a slice (after its NAL header) that hold all three ue(v) fields (as libwebrtc's sender reads). */
const HEADER_WINDOW = 16;

/** H264::ParseRbsp (common_video/h264/h264_common.cc): drop the 0x03 of every 00 00 03. */
export function parseRbsp(data: Uint8Array): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < data.length;) {
        if (data.length - i >= 3 && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
            out.push(data[i++], data[i++]);
            i++; // the emulation-prevention byte
        } else {
            out.push(data[i++]);
        }
    }
    return Uint8Array.from(out);
}

/** BitstreamReader::ReadExponentialGolomb semantics: null when the data runs out (or > 32 leading zeros). */
function readUe(d: Uint8Array, bit: { p: number }): number | null {
    let zeros = 0;
    for (;;) {
        if (bit.p >= d.length * 8) return null;
        const b = (d[bit.p >> 3] >> (7 - (bit.p & 7))) & 1;
        bit.p++;
        if (b) break;
        if (++zeros >= 32) return null;
    }
    let v = 0;
    for (let i = 0; i < zeros; i++) {
        if (bit.p >= d.length * 8) return null;
        v = v * 2 + ((d[bit.p >> 3] >> (7 - (bit.p & 7))) & 1);
        bit.p++;
    }
    return (2 ** zeros - 1) + v;
}

/** PpsParser::ParseSliceHeader: `slice` = the slice NAL's bytes AFTER its 1-byte header. Null = the receiver fails to parse. */
export function parseSliceHeaderPpsId(slice: Uint8Array): number | null {
    const d = parseRbsp(slice.subarray(0, Math.min(slice.length, HEADER_WINDOW)));
    const bit = { p: 0 };
    if (readUe(d, bit) === null) return null; // first_mb_in_slice
    if (readUe(d, bit) === null) return null; // slice_type
    return readUe(d, bit); // pic_parameter_set_id
}

export interface FirstSlice { type: number; /** offset of the NAL header byte */ payload: number; size: number }

/**
 * Offset of the next 3-byte start code's payload (00 00 01 at i..i+2 → i+3), searching from `from`
 * up to `limit` (exclusive upper bound for the start of the code), or -1. Same stepping as
 * WebRTC's FindNaluIndices, but lazy: the first slice sits right after the (few) prefix NALs,
 * so a keyframe of several hundred KB is never scanned whole.
 */
function nextStartCode(b: Uint8Array, from: number, limit: number): number {
    const end = Math.min(b.length - 3, limit);
    for (let i = from; i < end;) {
        const b2 = b[i + 2];
        if (b2 > 1) i += 3;
        else if (b2 === 1) { if (b[i + 1] === 0 && b[i] === 0) return i + 3; i += 3; }
        else i++;
    }
    return -1;
}

/** The first type-1/5 NAL unit — the one LiveKit's cryptor and libwebrtc's frame cryptor both key off. */
export function firstH264Slice(frame: Uint8Array): FirstSlice | null {
    for (let p = nextStartCode(frame, 0, frame.length); p >= 0 && p < frame.length;) {
        const type = frame[p] & 0x1f;
        if (type === 1 || type === 5) {
            // NAL size only matters up to the header window: stop at the next start code inside it.
            const nxt = nextStartCode(frame, p + 1, p + 1 + HEADER_WINDOW + 1);
            // WebRTC counts a 4-byte code's leading zero as the code, not the NAL (see findNaluIndices).
            let size = nxt < 0 ? frame.length - p : nxt - 3 - p;
            if (nxt >= 0 && nxt - 4 > p && frame[nxt - 4] === 0) size--;
            return { type, payload: p, size };
        }
        p = nextStartCode(frame, p + 1, frame.length);
    }
    return null;
}

/** pps id a libwebrtc receiver reads from the first slice of this (plaintext or on-the-wire) frame, only when it is an IDR slice. */
export function idrPpsIdAsReceiverReads(frame: Uint8Array): number | null {
    const s = firstH264Slice(frame);
    if (!s || s.type !== 5 || s.size < 2) return null;
    return parseSliceHeaderPpsId(frame.subarray(s.payload + 1, s.payload + s.size));
}

/** Would a libwebrtc receiver read the true pps id from `sent`? (`plain` = the frame before encryption.) */
export function ppsIdSurvives(plainPpsId: number, sent: Uint8Array): boolean {
    return idrPpsIdAsReceiverReads(sent) === plainPpsId;
}

/** Cryptor's own codec guess for a frame with no known codec: first NAL that is a slice in either codec. */
function guessH264(frame: Uint8Array): boolean {
    for (let p = nextStartCode(frame, 0, frame.length); p >= 0 && p < frame.length; p = nextStartCode(frame, p + 1, frame.length)) {
        const b = frame[p];
        const t264 = b & 0x1f;
        if (t264 === 1 || t264 === 5) return true;
        const t265 = (b >> 1) & 0x3f;
        if (t265 <= 9 || (t265 >= 16 && t265 <= 21)) return false;
    }
    return false;
}

/** Structural frame (same shape as e2eeAnnexB's EncodedFrameLike). */
export interface RetryFrameLike {
    data: ArrayBuffer;
    type?: string;
    getMetadata?(): { payloadType?: number };
}

export interface PpsRetryStats {
    /** IDR frames whose pps id was at risk and got checked. */
    checked: number;
    /** Checked frames that needed at least one retry. */
    retried: number;
    /** Total extra encryptions. */
    extraAttempts: number;
    /** Frames dropped because a restored/retried attempt did not look encrypted (cryptor pass-through). */
    notEncrypted: number;
    /** Frames sent still unreadable after MAX attempts. */
    gaveUp: number;
    /** Hold timeouts (cryptor never returned the frame). */
    timeouts: number;
}

export interface PpsRetryOptions {
    /** Codec of this frame ('h264' | 'h265' | 'vp8' ... or undefined if unknown). */
    codecOf(frame: RetryFrameLike): string | undefined;
    stats?: PpsRetryStats;
    maxAttempts?: number;
    holdTimeoutMs?: number;
}

interface Pending<F extends RetryFrameLike> {
    frame: F;
    plain: Uint8Array;
    /** Length of the plaintext frame; kept so the F1 check never reads `plain` after it is zeroed. */
    plainLen: number;
    ppsId: number;
    attempts: number;
    /** The buffer most recently put back into the frame for a retry (plaintext until the cryptor overwrites it). */
    restored: Uint8Array | null;
    done(): void;
}

/** AES-GCM tag (16) + IV (12) + LiveKit's 2-byte trailer: what an encrypted frame adds over its plaintext. */
export const ENCRYPTION_OVERHEAD_BYTES = 30;
export const MIN_PPS_ATTEMPTS = 1;
export const MAX_PPS_ATTEMPTS_CAP = 64;

/** An encrypted frame is at least plainLen + 30 bytes (escaping only adds) and is never the plaintext itself. */
function looksEncrypted(out: Uint8Array, plain: Uint8Array, plainLen: number): boolean {
    if (out.byteLength < plainLen + ENCRYPTION_OVERHEAD_BYTES) return false;
    if (out.byteLength === plain.byteLength) { // unreachable given the length test; kept as a belt-and-braces equality check
        let same = true;
        for (let i = 0; i < out.byteLength; i++) if (out[i] !== plain[i]) { same = false; break; }
        if (same) return false;
    }
    return true;
}

/**
 * The pair of stages. `hold` goes in front of LiveKit's cryptor, `wrapSink`
 * around the writable LiveKit's cryptor pipes into.
 *
 * Invariant: a RESTORED (retried) attempt never reaches the sink unless it is
 * ciphertext-shaped (looksEncrypted). LiveKit's cryptor forwards a frame
 * UNMODIFIED when E2EE is not enabled, and on a retry the frame holds the
 * restored plaintext, so without this the plaintext keyframe would be sent.
 * The FIRST attempt is deliberately not gated: with E2EE genuinely off for
 * the whole call the cryptor passes every frame through and this stage must
 * stay the same pass-through (a pass-through first attempt reads as "pps id
 * survives", so it never triggers a retry and nothing is restored).
 */
export function createIdrPpsRetry<F extends RetryFrameLike>(opts: PpsRetryOptions): {
    hold: TransformStream<F, F>;
    wrapSink(real: WritableStream<F>): WritableStream<F>;
} {
    const rawMax = Number.isFinite(opts.maxAttempts) ? Math.floor(opts.maxAttempts as number) : MAX_PPS_ID_ATTEMPTS;
    const max = Math.min(MAX_PPS_ATTEMPTS_CAP, Math.max(MIN_PPS_ATTEMPTS, rawMax));
    const timeoutMs = opts.holdTimeoutMs ?? PPS_RETRY_HOLD_TIMEOUT_MS;
    const stats = opts.stats;
    let pending: Pending<F> | null = null;
    let toCryptor!: TransformStreamDefaultController<F>;

    const isCandidate = (frame: F): Pending<F> | null => {
        if (frame.type !== 'key') return null;
        const codec = opts.codecOf(frame);
        const data = new Uint8Array(frame.data);
        if (codec !== 'h264' && !(codec === undefined && guessH264(data))) return null;
        const ppsId = idrPpsIdAsReceiverReads(data);
        if (ppsId === null) return null;
        return { frame, plain: data.slice(), plainLen: data.byteLength, ppsId, attempts: 1, restored: null, done: () => {} };
    };
    const scrub = (p: Pending<F>) => {
        p.plain.fill(0);
        if (p.restored) { try { p.restored.fill(0); } catch { /* detached */ } p.restored = null; }
    };

    const hold = new TransformStream<F, F>({
        start(c) { toCryptor = c; },
        async transform(frame, controller) {
            let p: Pending<F> | null = null;
            try { p = isCandidate(frame); } catch { p = null; }
            if (!p) { controller.enqueue(frame); return; }
            let timer: ReturnType<typeof setTimeout> | undefined;
            const released = new Promise<void>(resolve => {
                p!.done = resolve;
                timer = setTimeout(() => { if (pending === p) { pending = null; if (stats) stats.timeouts++; } scrub(p!); resolve(); }, timeoutMs);
            });
            pending = p;
            if (stats) stats.checked++;
            controller.enqueue(frame);
            await released;
            clearTimeout(timer);
        },
    });

    const wrapSink = (real: WritableStream<F>): WritableStream<F> => {
        const writer = real.getWriter();
        return new WritableStream<F>({
            async write(frame) {
                const p = pending;
                if (p && frame === p.frame) {
                    // The cryptor has consumed the previous restored buffer by now (it overwrote frame.data).
                    if (p.restored && frame.data !== p.restored.buffer) { try { p.restored.fill(0); } catch { /* detached */ } p.restored = null; }
                    // true = pps id readable, false = not, null = the check threw
                    let survives: boolean | null;
                    try { survives = ppsIdSurvives(p.ppsId, new Uint8Array(frame.data)); } catch { survives = null; }
                    if (survives === false && p.attempts < max) {
                        p.attempts++;
                        if (stats) { if (p.attempts === 2) stats.retried++; stats.extraAttempts++; }
                        // Same frame object, same plaintext, the cryptor takes a fresh IV (new sendCount).
                        const sentData = frame.data;
                        const restored = p.plain.slice();
                        p.restored = restored;
                        frame.data = restored.buffer as ArrayBuffer;
                        try {
                            toCryptor.enqueue(frame);
                        } catch {
                            // Cryptor side already closed: NEVER let the plaintext we just restored reach the sink.
                            frame.data = sentData;
                            pending = null;
                            scrub(p);
                            p.done();
                            return;
                        }
                        return;
                    }
                    // Final write. A restored attempt (attempts > 1) must be ciphertext-shaped; if the pps check
                    // itself threw, require it for the first attempt too (fail closed).
                    pending = null;
                    let out: Uint8Array | null = null;
                    try { out = new Uint8Array(frame.data); } catch { out = null; }
                    if ((p.attempts > 1 || survives === null) && !(out && looksEncrypted(out, p.plain, p.plainLen))) {
                        if (stats) stats.notEncrypted++;
                        try { if (out) out.fill(0); } catch { /* detached */ }
                        scrub(p);
                        p.done();
                        return;
                    }
                    if (stats && p.attempts >= max && survives === false) stats.gaveUp++;
                    try { await writer.write(frame); } finally { scrub(p); p.done(); }
                    return;
                }
                await writer.write(frame);
            },
            async close() { pending = null; await writer.close(); },
            async abort(reason) { pending = null; await writer.abort(reason); },
        });
    };

    return { hold, wrapSink };
}
