/**
 * A minimal WebM (Matroska) muxer for ONE mono Opus track, so the WebCodecs
 * encoder's raw Opus packets become a file every Chromium `<audio>` and
 * `decodeAudioData` plays. Pure: bytes in, bytes out; unit-tested by parsing
 * its own output back.
 *
 * Layout (all sizes known, so no "unknown size" elements, no Cues/SeekHead:
 * a 2.5 s clip in one Cluster needs neither):
 *
 *   EBML  { EBMLVersion 1, ReadVersion 1, MaxIDLength 4, MaxSizeLength 8, DocType "webm", 4, 2 }
 *   Segment {
 *     Info   { TimecodeScale 1 ms, MuxingApp, WritingApp, Duration (ms, float) }
 *     Tracks { TrackEntry { 1, UID, audio, "A_OPUS", CodecPrivate = OpusHead,
 *                           CodecDelay = pre-skip, SeekPreRoll 80 ms,
 *                           Audio { 48000.0 Hz, 1 channel } } }
 *     Cluster { Timecode 0, SimpleBlock* (track 1, keyframe, int16 ms offset) }
 *   }
 */

export interface OpusPacket {
    data: Uint8Array;
    /** Presentation time, microseconds (WebCodecs EncodedAudioChunk.timestamp). */
    timestampUs: number;
}

const enc = new TextEncoder();

/** Matroska variable-length size: the shortest encoding (1..8 bytes). */
export function vintSize(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('bad size');
    for (let len = 1; len <= 8; len++) {
        // all-ones is reserved for "unknown"
        if (n < 2 ** (7 * len) - 1) {
            const out = new Uint8Array(len);
            let v = n;
            for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
            out[0] |= 1 << (8 - len);
            return out;
        }
    }
    throw new Error('size too large');
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/** An element: id bytes (with their marker bits, as in the spec) + size + payload. */
function el(id: number, payload: Uint8Array): Uint8Array {
    const idBytes: number[] = [];
    for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v % 256);
    return concat([Uint8Array.from(idBytes), vintSize(payload.length), payload]);
}

function uint(v: number): Uint8Array {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('bad uint');
    const bytes: number[] = [];
    for (let x = v; x > 0; x = Math.floor(x / 256)) bytes.unshift(x % 256);
    return Uint8Array.from(bytes.length ? bytes : [0]);
}

function float64(v: number): Uint8Array {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, false);
    return b;
}

const str = (s: string) => enc.encode(s);
const kids = (...parts: Uint8Array[]) => concat(parts);

/** The 19-byte OpusHead (RFC 7845 §5.1) for a mono stream. */
export function buildOpusHead(preSkip: number, inputSampleRate = 48_000, channels = 1): Uint8Array {
    const b = new Uint8Array(19);
    b.set(str('OpusHead'), 0);
    const v = new DataView(b.buffer);
    v.setUint8(8, 1);              // version
    v.setUint8(9, channels);
    v.setUint16(10, preSkip, true);
    v.setUint32(12, inputSampleRate, true);
    v.setInt16(16, 0, true);       // output gain
    v.setUint8(18, 0);             // mapping family 0 (mono/stereo)
    return b;
}

/** Pre-skip from an OpusHead, or null if it is not one. */
export function opusHeadPreSkip(head: Uint8Array | null | undefined): number | null {
    if (!head || head.length < 19) return null;
    for (let i = 0; i < 8; i++) if (head[i] !== 'OpusHead'.charCodeAt(i)) return null;
    return head[10] | (head[11] << 8);
}

/** libopus' usual look-ahead at 48 kHz, for when the encoder hands no OpusHead over. */
export const DEFAULT_OPUS_PRE_SKIP = 312;

export interface MuxInput {
    packets: readonly OpusPacket[];
    /** OpusHead from the encoder's decoderConfig.description, if it gave one. */
    opusHead?: Uint8Array | null;
    durationMs: number;
}

export function muxOpusWebm({ packets, opusHead, durationMs }: MuxInput): Uint8Array {
    if (packets.length === 0) throw new Error('no packets');
    const head = opusHead && opusHeadPreSkip(opusHead) !== null ? opusHead : buildOpusHead(DEFAULT_OPUS_PRE_SKIP);
    const preSkip = opusHeadPreSkip(head) ?? DEFAULT_OPUS_PRE_SKIP;

    const ebml = el(0x1a45dfa3, kids(
        el(0x4286, uint(1)), el(0x42f7, uint(1)), el(0x42f2, uint(4)), el(0x42f3, uint(8)),
        el(0x4282, str('webm')), el(0x4287, uint(4)), el(0x4285, uint(2)),
    ));
    const info = el(0x1549a966, kids(
        el(0x2ad7b1, uint(1_000_000)),
        el(0x4d80, str('cipherline')),
        el(0x5741, str('cipherline')),
        el(0x4489, float64(durationMs)),
    ));
    const tracks = el(0x1654ae6b, el(0xae, kids(
        el(0xd7, uint(1)),
        el(0x73c5, uint(1)),
        el(0x83, uint(2)),          // audio
        el(0x86, str('A_OPUS')),
        el(0x63a2, head),
        el(0x56aa, uint(Math.round(preSkip * 1e9 / 48_000))), // CodecDelay, ns
        el(0x56bb, uint(80_000_000)),                         // SeekPreRoll, ns
        el(0xe1, kids(el(0xb5, float64(48_000)), el(0x9f, uint(1)))),
    )));
    const t0 = packets[0].timestampUs;
    const blocks = packets.map(p => {
        const relMs = Math.round((p.timestampUs - t0) / 1000);
        if (relMs < -32768 || relMs > 32767) throw new Error('clip too long for one cluster');
        const hdr = new Uint8Array(4);
        hdr[0] = 0x81;                                  // track 1 (vint)
        new DataView(hdr.buffer).setInt16(1, relMs, false);
        hdr[3] = 0x80;                                  // keyframe (every Opus packet is)
        return el(0xa3, concat([hdr, p.data]));
    });
    const cluster = el(0x1f43b675, kids(el(0xe7, uint(0)), ...blocks));
    return concat([ebml, el(0x18538067, kids(info, tracks, cluster))]);
}
