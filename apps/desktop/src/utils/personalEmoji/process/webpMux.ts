/**
 * Animated-WebP muxer.
 *
 * Browsers can encode a single still WebP (canvas `convertToBlob`) but not an
 * animated one, and no maintained MIT/BSD pure-JS animated-WebP encoder is
 * worth a dependency for this. The container is small and fully specified
 * (https://developers.google.com/speed/webp/docs/riff_container), so each
 * frame is encoded by the browser as a still WebP and this module wraps those
 * frames into one animated file: VP8X + ANIM + one ANMF per frame, each
 * carrying the still's own ALPH / VP8 / VP8L chunks verbatim. No image data is
 * re-encoded here.
 *
 * Every frame covers the whole canvas and is written "do not blend", so a
 * frame replaces the previous one outright (correct for transparent frames).
 *
 * Pure bytes in, bytes out: no DOM, so it runs in the worker and in tests.
 */

const ascii = (s: string) => Uint8Array.from([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const u16 = (n: number) => [n & 255, (n >>> 8) & 255];

export interface RiffChunk { fourcc: string; payload: Uint8Array }

/** Split a WebP file into its RIFF chunks. Throws on anything malformed. */
export function readWebpChunks(file: Uint8Array): RiffChunk[] {
    const s = (i: number) => String.fromCharCode(file[i], file[i + 1], file[i + 2], file[i + 3]);
    if (file.length < 20 || s(0) !== 'RIFF' || s(8) !== 'WEBP') throw new Error('not a WebP file');
    const rd32 = (i: number) => (file[i] | (file[i + 1] << 8) | (file[i + 2] << 16) | (file[i + 3] << 24)) >>> 0;
    const riffEnd = Math.min(file.length, 8 + rd32(4));
    const out: RiffChunk[] = [];
    let i = 12;
    while (i + 8 <= riffEnd) {
        const size = rd32(i + 4);
        const start = i + 8;
        if (start + size > file.length) throw new Error('truncated WebP chunk');
        out.push({ fourcc: s(i), payload: file.subarray(start, start + size) });
        i = start + size + (size & 1);
    }
    return out;
}

export interface MuxFrame {
    /** A complete still WebP file for this frame, canvas-sized. */
    webp: Uint8Array;
    /** Display time in ms. */
    durationMs: number;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/** `fourcc | size | payload | pad` */
function chunk(fourcc: string, payload: Uint8Array): Uint8Array {
    const parts = [ascii(fourcc), Uint8Array.from(u32(payload.length)), payload];
    if (payload.length & 1) parts.push(new Uint8Array(1));
    return concat(parts);
}

/** Wrap still-WebP frames into an animated WebP of `width` x `height`. */
export function muxAnimatedWebp(frames: MuxFrame[], width: number, height: number, loopCount = 0): Uint8Array {
    if (frames.length === 0) throw new Error('no frames');
    if (width < 1 || height < 1 || width > 0xffffff || height > 0xffffff) throw new Error('bad canvas size');

    let hasAlpha = false;
    const anmfs: Uint8Array[] = [];
    for (const f of frames) {
        const bitstream: Uint8Array[] = [];
        let hasImage = false;
        for (const c of readWebpChunks(f.webp)) {
            if (c.fourcc === 'ALPH') { hasAlpha = true; bitstream.push(chunk('ALPH', c.payload)); }
            else if (c.fourcc === 'VP8 ') { hasImage = true; bitstream.push(chunk('VP8 ', c.payload)); }
            else if (c.fourcc === 'VP8L') {
                // alpha_is_used is bit 28 of the 32 bits that follow the 0x2F signature.
                if (c.payload.length >= 5 && (c.payload[4] & 0x10)) hasAlpha = true;
                hasImage = true;
                bitstream.push(chunk('VP8L', c.payload));
            }
        }
        if (!hasImage) throw new Error('frame has no image data');
        const dur = Math.max(1, Math.min(0xffffff, Math.round(f.durationMs)));
        // x, y, width-1, height-1, duration, flags (bit1 = do not blend, bit0 = dispose to background: off)
        const head = Uint8Array.from([...u24(0), ...u24(0), ...u24(width - 1), ...u24(height - 1), ...u24(dur), 0x02]);
        anmfs.push(chunk('ANMF', concat([head, ...bitstream])));
    }

    const vp8x = chunk('VP8X', Uint8Array.from([(hasAlpha ? 0x10 : 0) | 0x02, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]));
    const anim = chunk('ANIM', Uint8Array.from([0, 0, 0, 0, ...u16(loopCount)]));
    const body = concat([ascii('WEBP'), vp8x, anim, ...anmfs]);
    return concat([ascii('RIFF'), Uint8Array.from(u32(body.length)), body]);
}
