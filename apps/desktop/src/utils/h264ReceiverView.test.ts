import { describe, it, expect } from 'vitest';
import { ReceiverViewNormalizer, parseSps, withReceiverStableVui } from './h264ReceiverView';

class W {
    a: number[] = []; n = 0;
    bit(v: number) { if ((this.n & 7) === 0) this.a.push(0); if (v) this.a[this.n >> 3] |= 0x80 >> (this.n & 7); this.n++; return this; }
    u(n: number, v: number) { for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1); return this; }
    ue(v: number) { const x = v + 1, l = Math.floor(Math.log2(x)); this.u(l, 0); this.u(l + 1, x); return this; }
    done() { this.bit(1); while (this.n & 7) this.bit(0); return Uint8Array.from(this.a); }
}
function nal(ref: number, type: number, rbsp: Uint8Array, sc4 = true): number[] {
    const out = sc4 ? [0, 0, 0, 1] : [0, 0, 1]; out.push((ref << 5) | type);
    let z = 0; for (const b of rbsp) { if (z >= 2 && b <= 3) { out.push(3); z = 0; } out.push(b); z = b === 0 ? z + 1 : 0; }
    return out;
}
/** Constrained Baseline SPS, optionally with the VUI bitstream_restriction. */
function sps(opts: { vui: 'none' | 'timing-only' | 'restriction'; reorder?: number; maxDec?: number }): Uint8Array {
    const w = new W().u(8, 66).u(8, 0x40).u(8, 40).ue(0).ue(4).ue(2).ue(1).bit(0).ue(119).ue(67).bit(1).bit(1).bit(0);
    if (opts.vui === 'none') w.bit(0);
    else {
        w.bit(1).bit(0).bit(0).bit(1).u(3, 5).bit(0).bit(1).u(8, 1).u(8, 1).u(8, 1).bit(0).bit(0).bit(0).bit(0).bit(0);
        if (opts.vui === 'timing-only') w.bit(0);
        else w.bit(1).bit(1).ue(0).ue(0).ue(15).ue(15).ue(opts.reorder ?? 0).ue(opts.maxDec ?? 1);
    }
    return w.done();
}
const pps = () => new W().ue(0).ue(0).bit(0).bit(0).ue(0).ue(0).ue(0).bit(0).u(2, 0).ue(0).ue(0).ue(0).bit(1).bit(0).bit(0).done();
/** IDR slice header (first_mb 0, `sliceType`, pps 0, frame_num, idr_pic_id, marking, qp delta, deblock) + filler payload bits. */
function slice(sliceType: number, payloadBits = 61): Uint8Array {
    const w = new W().ue(0).ue(sliceType).ue(0).u(4, 0).ue(1).bit(0).bit(0);
    for (let i = 0; i < payloadBits; i++) w.bit((i * 7 + 3) & 1);
    return w.done();
}
const au = (s: Uint8Array, sl: Uint8Array, sc4 = true) => Uint8Array.from([...nal(3, 7, s), ...nal(3, 8, pps()), ...nal(3, 5, sl, sc4)]);
function findSlice(d: Uint8Array): number {
    for (let i = 0; i + 3 < d.length; i++) if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1 && (d[i + 3] & 0x1f) === 5) return i + 3;
    return -1;
}

describe('h264ReceiverView: SPS', () => {
    it('parses the VUI position of a plain Constrained Baseline SPS', () => {
        const v = parseSps(sps({ vui: 'none' }));
        expect(v.hasVui).toBe(false); expect(v.maxNumRefFrames).toBe(1);
        const r = parseSps(sps({ vui: 'restriction' }));
        expect(r.hasRestriction).toBe(true); expect(r.numReorder).toBe(0); expect(r.maxDecBuf).toBe(1);
    });
    it('adds the bitstream_restriction WebRTC will not rewrite when the SPS has no VUI (the live E2EE failure)', () => {
        const fixed = withReceiverStableVui(sps({ vui: 'none' }));
        expect(fixed).not.toBeNull();
        const v = parseSps(fixed!);
        expect(v.hasVui && v.hasRestriction && v.numReorder === 0 && v.maxDecBuf === 1).toBe(true);
    });
    it('adds only the restriction to a VUI that has other fields, keeping them', () => {
        const fixed = withReceiverStableVui(sps({ vui: 'timing-only' }))!;
        const v = parseSps(fixed); expect(v.hasRestriction).toBe(true);
        // the BT.709 colour description (video_signal_type) sits before the restriction and must survive verbatim
        const orig = sps({ vui: 'timing-only' });
        const hdr = orig.length - 4; // everything but the last bytes is common prefix
        expect(Array.from(fixed.subarray(0, hdr))).toEqual(Array.from(orig.subarray(0, hdr)));
    });
    it('normalises a restriction that asks for reordering', () => {
        const fixed = withReceiverStableVui(sps({ vui: 'restriction', reorder: 2, maxDec: 4 }))!;
        const v = parseSps(fixed); expect(v.numReorder).toBe(0); expect(v.maxDecBuf).toBe(1);
    });
    it('leaves an already-stable SPS untouched (returns null)', () => {
        expect(withReceiverStableVui(sps({ vui: 'restriction' }))).toBeNull();
    });
});

describe('h264ReceiverView: slice header', () => {
    it('shortens slice_type 7 so pps_id lands in the clear byte', () => {
        const n = new ReceiverViewNormalizer();
        const input = au(sps({ vui: 'restriction' }), slice(7));
        const out = n.normalize(input);
        expect(n.stats.sliceFixed).toBe(1);
        // first_mb '1', slice_type 2 = '011', pps_id '1' -> '1011 1' inside the first 5 bits of the byte after the NAL header
        expect(out[findSlice(out) + 1] >> 3).toBe(0b10111);
        // negative control for the test itself: the legacy form has first_mb '1' + ue(7) '0001000' filling byte 1 completely,
        // so the pps_id bit sits in byte 2 (the encrypted one)
        expect(input[findSlice(input) + 1]).toBe(0b10001000);
        expect(out.length).toBeLessThanOrEqual(input.length);
    });
    it('leaves an already-short header alone', () => {
        const n = new ReceiverViewNormalizer();
        const a = au(sps({ vui: 'restriction' }), slice(2));
        expect(n.normalize(a)).toBe(a);
        expect(n.stats.sliceFixed).toBe(0);
    });
    it('refuses to bit-shift a CABAC slice and says so', () => {
        const n = new ReceiverViewNormalizer();
        const cabacPps = new W().ue(0).ue(0).bit(1).bit(0).ue(0).ue(0).ue(0).bit(0).u(2, 0).ue(0).ue(0).ue(0).bit(1).bit(0).bit(0).done();
        const a = Uint8Array.from([...nal(3, 7, sps({ vui: 'restriction' })), ...nal(3, 8, cabacPps), ...nal(3, 5, slice(7))]);
        const out = n.normalize(a);
        expect(out).toBe(a); expect(n.stats.sliceUnrepairable).toBe(1);
    });
    it('handles 3-byte start codes and emulation-prevention bytes', () => {
        const n = new ReceiverViewNormalizer();
        const sl = new W().ue(0).ue(7).ue(0).u(4, 0).ue(1).bit(0).bit(0);
        for (let i = 0; i < 60; i++) sl.bit(0); // a run of zeros forces emulation prevention
        sl.bit(1).u(8, 1);
        const input = au(sps({ vui: 'none' }), sl.done(), false);
        const out = n.normalize(input);
        expect(n.stats.sliceFixed).toBe(1); expect(n.stats.spsFixed).toBe(1);
        expect(Array.from(out.subarray(0, 4))).toEqual([0, 0, 0, 1]);
        // no forbidden 00 00 00 / 00 00 01 / 00 00 02 inside any NAL body after the first start code of each NAL
        const s = Array.from(out); let bad = 0;
        for (let i = 0; i + 2 < s.length; i++) if (s[i] === 0 && s[i + 1] === 0 && s[i + 2] <= 2) { if (!(s[i + 2] === 1 || (s[i + 2] === 0 && s[i + 3] === 1))) bad++; }
        expect(bad).toBe(0);
    });
    it('returns non-canonical input unchanged', () => {
        const n = new ReceiverViewNormalizer(); const junk = Uint8Array.from([9, 9, 0, 0, 1, 0x65, 0x88]);
        expect(n.normalize(junk)).toBe(junk);
    });
});
