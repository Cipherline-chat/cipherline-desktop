/**
 * Make a native-encoder H.264 access unit look, byte for byte in the part LiveKit authenticates, like what Chromium's RECEIVER will
 * reconstruct. Two hazards, both found with a live E2EE call (2026-11-10, pcm test backend, right-key viewer decoded 0 frames):
 *
 * 1. SPS rewrite. WebRTC's receive-side depacketizer (SpsVuiRewriter) adds a VUI `bitstream_restriction` (num_reorder_frames = 0) to any
 *    SPS that lacks one BEFORE the frame reaches LiveKit's cryptor. The cryptor authenticates the clear prefix of the frame (everything up
 *    to the first slice's NAL header + 1 byte, i.e. SPS + PPS + 2 bytes) as AES-GCM additional data, so a rewritten SPS changes the
 *    receiver's prefix, authentication fails and EVERY key frame is dropped. (Same class as e2eeAnnexB.ts: start codes.) An SPS that already
 *    carries the restriction is left alone by WebRTC, which is why the earlier VA-API run worked. NVENC's SPS is written by the driver and
 *    was never checked.
 * 2. Slice header bytes in the clear. Only ONE byte after the slice NAL header stays clear. `pic_parameter_set_id` is read by the
 *    receiver's SPS/PPS tracker BEFORE decryption. With slice_type 7 (all-I, 7-bit code) on an IDR the pps_id bit lands in the encrypted
 *    second byte, the tracker reads garbage ("No PPS with id N") and drops about half of the IDRs. The canonical short form (7 -> 2, 5 -> 0)
 *    keeps first_mb_in_slice + slice_type + pps_id inside that clear byte. Equivalent for a one-slice picture; needs CAVLC (a bit shift
 *    would break CABAC alignment), which is what every backend here uses (Constrained Baseline).
 *
 * Pure, DOM-free, tested against a live decoder (ffmpeg) and with the real LiveKit cryptor in the harness.
 */

// ── NAL splitting / RBSP ────────────────────────────────────────────────────

interface Nal { type: number; refIdc: number; body: Uint8Array /* bytes after the 1-byte header, still escaped */; sc: number; end: number }

function splitNals(d: Uint8Array): Nal[] | null {
    const starts: { sc: number; hdr: number }[] = [];
    for (let i = 0; i + 3 < d.length; i++) {
        if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) { starts.push({ sc: i > 0 && d[i - 1] === 0 ? i - 1 : i, hdr: i + 3 }); i += 2; }
    }
    if (!starts.length || starts[0].sc !== 0) return null; // not canonical Annex-B (leading garbage): leave it to the existing canonicalizer
    const out: Nal[] = [];
    for (let k = 0; k < starts.length; k++) {
        const end = k + 1 < starts.length ? starts[k + 1].sc : d.length;
        const h = d[starts[k].hdr];
        out.push({ type: h & 0x1f, refIdc: (h >> 5) & 3, body: d.subarray(starts[k].hdr + 1, end), sc: starts[k].sc, end });
    }
    return out;
}

function unescape(b: Uint8Array): Uint8Array {
    const o = new Uint8Array(b.length); let n = 0, z = 0;
    for (let i = 0; i < b.length; i++) {
        if (z >= 2 && b[i] === 3) { z = 0; continue; }
        o[n++] = b[i]; z = b[i] === 0 ? z + 1 : 0;
    }
    return o.subarray(0, n);
}

function escape(b: Uint8Array): Uint8Array {
    const o = new Uint8Array(b.length + (b.length >> 1) + 4); let n = 0, z = 0;
    for (let i = 0; i < b.length; i++) {
        if (z >= 2 && b[i] <= 3) { o[n++] = 3; z = 0; }
        o[n++] = b[i]; z = b[i] === 0 ? z + 1 : 0;
    }
    return o.subarray(0, n);
}

class BitReader {
    pos = 0;
    readonly d: Uint8Array;
    constructor(d: Uint8Array) { this.d = d; }
    get bits(): number { return this.d.length * 8; }
    bit(): number { if (this.pos >= this.bits) throw new RangeError('eof'); const v = (this.d[this.pos >> 3] >> (7 - (this.pos & 7))) & 1; this.pos++; return v; }
    u(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
    ue(): number { let z = 0; while (this.bit() === 0) { if (++z > 31) throw new RangeError('ue'); } return (2 ** z) - 1 + (z ? this.u(z) : 0); }
    se(): number { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
}

class BitWriter {
    private a: number[] = []; n = 0;
    bit(v: number): void { if ((this.n & 7) === 0) this.a.push(0); if (v) this.a[this.n >> 3] |= 0x80 >> (this.n & 7); this.n++; }
    u(n: number, v: number): void { for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1); }
    ue(v: number): void { const x = v + 1; const len = Math.floor(Math.log2(x)); this.u(len, 0); this.u(len + 1, x); }
    /** copy bits [from, to) of another buffer */
    copy(src: Uint8Array, from: number, to: number): void { for (let p = from; p < to; p++) this.bit((src[p >> 3] >> (7 - (p & 7))) & 1); }
    finishWithStopBit(): Uint8Array { this.bit(1); while (this.n & 7) this.bit(0); return Uint8Array.from(this.a); }
}

/** Position (in bits) of the rbsp stop bit (last 1 bit). -1 when there is none. */
function stopBitPos(b: Uint8Array): number {
    for (let i = b.length - 1; i >= 0; i--) {
        if (b[i] === 0) continue;
        let t = 0; while (((b[i] >> t) & 1) === 0) t++;
        return i * 8 + (7 - t);
    }
    return -1;
}

function nalBytes(refIdc: number, type: number, rbsp: Uint8Array): Uint8Array {
    const e = escape(rbsp); const o = new Uint8Array(5 + e.length);
    o[3] = 1; o[4] = (refIdc << 5) | type; o.set(e, 5); return o;
}

// ── SPS ─────────────────────────────────────────────────────────────────────

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number): void {
    let last = 8, next = 8;
    for (let j = 0; j < size; j++) { if (next !== 0) { next = (last + r.se() + 256) % 256; } last = next === 0 ? last : next; }
}
function skipHrd(r: BitReader): void {
    const cnt = r.ue() + 1; r.u(4); r.u(4);
    for (let i = 0; i < cnt; i++) { r.ue(); r.ue(); r.bit(); }
    r.u(5); r.u(5); r.u(5); r.u(5);
}

export interface SpsView { maxNumRefFrames: number; vuiFlagPos: number; hasVui: boolean; restrictionFlagPos: number; hasRestriction: boolean; numReorder: number; maxDecBuf: number; restrictionEnd: number }

/** Parse far enough to know where the VUI sits. Throws on anything it does not understand (caller leaves the SPS alone). */
export function parseSps(rbsp: Uint8Array): SpsView {
    const r = new BitReader(rbsp);
    const profile = r.u(8); r.u(8); r.u(8); r.ue();
    if (HIGH_PROFILES.has(profile)) {
        const cf = r.ue(); if (cf === 3) r.bit();
        r.ue(); r.ue(); r.bit();
        if (r.bit()) { const n = cf !== 3 ? 8 : 12; for (let i = 0; i < n; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64); }
    }
    r.ue();                                  // log2_max_frame_num_minus4
    const poc = r.ue();
    if (poc === 0) r.ue();
    else if (poc === 1) { r.bit(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
    const maxNumRefFrames = r.ue(); r.bit(); r.ue(); r.ue();
    if (!r.bit()) r.bit();                   // frame_mbs_only_flag (0 => mb_adaptive_frame_field_flag)
    r.bit();                                 // direct_8x8_inference_flag
    if (r.bit()) { r.ue(); r.ue(); r.ue(); r.ue(); }
    const vuiFlagPos = r.pos;
    const hasVui = r.bit() === 1;
    const v: SpsView = { maxNumRefFrames, vuiFlagPos, hasVui, restrictionFlagPos: -1, hasRestriction: false, numReorder: -1, maxDecBuf: -1, restrictionEnd: -1 };
    if (!hasVui) return v;
    if (r.bit()) { if (r.u(8) === 255) r.u(32); }          // aspect_ratio
    if (r.bit()) r.bit();                                  // overscan
    if (r.bit()) { r.u(3); r.bit(); if (r.bit()) r.u(24); } // video signal
    if (r.bit()) { r.ue(); r.ue(); }                       // chroma loc
    if (r.bit()) { r.u(32); r.u(32); r.bit(); }            // timing
    const nal = r.bit(); if (nal) skipHrd(r);
    const vcl = r.bit(); if (vcl) skipHrd(r);
    if (nal || vcl) r.bit();                               // low_delay_hrd_flag
    r.bit();                                               // pic_struct_present_flag
    v.restrictionFlagPos = r.pos;
    if (r.bit()) {
        v.hasRestriction = true; r.bit(); r.ue(); r.ue(); r.ue(); r.ue();
        v.numReorder = r.ue(); v.maxDecBuf = r.ue(); v.restrictionEnd = r.pos;
    }
    return v;
}

/** The values WebRTC's receiver leaves alone (proven live: VA-API and pcm streams with these decode through the E2EE cryptor). */
function wantedMaxDecBuf(v: SpsView): number { return Math.max(1, v.maxNumRefFrames); }

/** Returns the SPS RBSP with a VUI bitstream_restriction WebRTC will not rewrite, or null when it is already so. */
export function withReceiverStableVui(rbsp: Uint8Array): Uint8Array | null {
    const v = parseSps(rbsp);
    if (v.hasVui && v.hasRestriction && v.numReorder === 0 && v.maxDecBuf === wantedMaxDecBuf(v)) return null;
    const stop = stopBitPos(rbsp); if (stop < 0) throw new RangeError('no stop bit');
    const w = new BitWriter();
    w.copy(rbsp, 0, v.vuiFlagPos);
    w.bit(1);                                              // vui_parameters_present_flag
    if (!v.hasVui) {
        for (let i = 0; i < 5; i++) w.bit(0);              // aspect, overscan, video_signal, chroma_loc, timing
        for (let i = 0; i < 3; i++) w.bit(0);              // nal_hrd, vcl_hrd, pic_struct
        w.bit(1); w.bit(1); w.ue(0); w.ue(0); w.ue(15); w.ue(15); w.ue(0); w.ue(wantedMaxDecBuf(v));
    } else if (!v.hasRestriction) {
        w.copy(rbsp, v.vuiFlagPos + 1, v.restrictionFlagPos);
        w.bit(1); w.bit(1); w.ue(0); w.ue(0); w.ue(15); w.ue(15); w.ue(0); w.ue(wantedMaxDecBuf(v));
    } else {
        // keep the existing restriction fields, normalise only num_reorder_frames / max_dec_frame_buffering
        const r = new BitReader(rbsp); r.pos = v.restrictionFlagPos + 1;
        w.copy(rbsp, v.vuiFlagPos + 1, v.restrictionFlagPos + 1);
        const mv = r.bit(); const a = r.ue(), b = r.ue(), c = r.ue(), d = r.ue();
        w.bit(mv); w.ue(a); w.ue(b); w.ue(c); w.ue(d); w.ue(0); w.ue(wantedMaxDecBuf(v));
        void v.restrictionEnd;
    }
    return w.finishWithStopBit();
}

// ── slice header ────────────────────────────────────────────────────────────

/** pps_id -> entropy_coding_mode_flag, learned from the PPS NALs that precede slices. */
export class ReceiverViewNormalizer {
    private cavlc = new Map<number, boolean>();
    stats = { spsFixed: 0, spsUnparsed: 0, sliceFixed: 0, sliceUnrepairable: 0, passthrough: 0 };

    /** `data`: one Annex-B AU. Returns the same array when nothing needed changing. */
    normalize(data: Uint8Array): Uint8Array {
        const nals = splitNals(data);
        if (!nals) { this.stats.passthrough++; return data; }
        let changed = false; const parts: Uint8Array[] = [];
        for (const n of nals) {
            let out: Uint8Array | null = null;
            try {
                if (n.type === 7) {
                    const nr = withReceiverStableVui(unescape(n.body));
                    if (nr) { out = nalBytes(n.refIdc, 7, nr); this.stats.spsFixed++; }
                } else if (n.type === 8) {
                    const r = new BitReader(unescape(n.body)); const id = r.ue(); r.ue(); this.cavlc.set(id, r.bit() === 0);
                } else if (n.type === 1 || n.type === 5) {
                    const nr = this.fixSlice(n);
                    if (nr === 'bad') this.stats.sliceUnrepairable++;
                    else if (nr) { out = nr; this.stats.sliceFixed++; }
                }
            } catch { if (n.type === 7) this.stats.spsUnparsed++; else if (n.type !== 8) this.stats.sliceUnrepairable++; }
            if (out) changed = true;
            parts.push(out ?? data.subarray(n.sc, n.end));
        }
        if (!changed) { this.stats.passthrough++; return data; }
        let len = 0; for (const p of parts) len += p.length;
        const res = new Uint8Array(len); let o = 0; for (const p of parts) { res.set(p, o); o += p.length; }
        return res;
    }

    private fixSlice(n: Nal): Uint8Array | 'bad' | null {
        const rbsp = unescape(n.body);
        const r = new BitReader(rbsp);
        const first = r.ue(); let st = r.ue(); const pps = r.ue();
        const total = (x: number) => 2 * Math.floor(Math.log2(x + 1)) + 1;
        if (total(first) + total(st) + total(pps) <= 8) return null;
        if (st >= 5) st -= 5;
        if (total(first) + total(st) + total(pps) > 8) return 'bad';
        if (this.cavlc.get(pps) !== true) return 'bad'; // CABAC or unknown PPS: a bit shift would break alignment
        const stop = stopBitPos(rbsp); if (stop < 0) return 'bad';
        const w = new BitWriter(); w.ue(first); w.ue(st); w.ue(pps);
        w.copy(rbsp, r.pos, stop);
        return nalBytes(n.refIdc, n.type, w.finishWithStopBit());
    }
}
