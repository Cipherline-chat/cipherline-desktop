import { describe, expect, it } from 'vitest';
import { buildOpusHead, muxOpusWebm, opusHeadPreSkip, vintSize, DEFAULT_OPUS_PRE_SKIP } from './webm';
import { hasEbmlMagic } from './constants';

/** A tiny EBML reader, enough to walk what the muxer wrote. */
function readVint(b: Uint8Array, o: number, keepMarker: boolean): { value: number; len: number } {
    const first = b[o];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? first : first & ((0x80 >> (len - 1)) - 1);
    for (let i = 1; i < len; i++) v = v * 256 + b[o + i];
    return { value: v, len };
}
interface El { id: number; data: Uint8Array }
function children(b: Uint8Array): El[] {
    const out: El[] = [];
    let o = 0;
    while (o < b.length) {
        const id = readVint(b, o, true); o += id.len;
        const size = readVint(b, o, false); o += size.len;
        out.push({ id: id.value, data: b.subarray(o, o + size.value) });
        o += size.value;
    }
    expect(o).toBe(b.length);
    return out;
}
const find = (els: El[], id: number) => els.find(e => e.id === id)!;
const uintOf = (d: Uint8Array) => d.reduce((n, x) => n * 256 + x, 0);
const strOf = (d: Uint8Array) => new TextDecoder().decode(d);

describe('vintSize', () => {
    it('uses the shortest form and never the reserved all-ones', () => {
        expect([...vintSize(0)]).toEqual([0x80]);
        expect([...vintSize(126)]).toEqual([0xfe]);
        expect([...vintSize(127)]).toEqual([0x40, 0x7f]); // 0xff would mean "unknown"
        expect([...vintSize(300)]).toEqual([0x41, 0x2c]);
    });
});

describe('OpusHead', () => {
    it('is the RFC 7845 layout and round-trips the pre-skip', () => {
        const h = buildOpusHead(312);
        expect(h.length).toBe(19);
        expect(strOf(h.subarray(0, 8))).toBe('OpusHead');
        expect(h[8]).toBe(1);
        expect(h[9]).toBe(1);
        expect(opusHeadPreSkip(h)).toBe(312);
        expect(opusHeadPreSkip(new Uint8Array(19))).toBeNull();
    });
});

describe('muxOpusWebm', () => {
    const packets = Array.from({ length: 5 }, (_, i) => ({ data: new Uint8Array([0xfc, i, i + 1]), timestampUs: i * 20_000 }));
    const file = muxOpusWebm({ packets, durationMs: 100 });

    it('starts with the EBML magic and is a well-formed tree', () => {
        expect(hasEbmlMagic(file)).toBe(true);
        const top = children(file);
        expect(top.map(e => e.id)).toEqual([0x1a45dfa3, 0x18538067]);
        expect(strOf(find(children(top[0].data), 0x4282).data)).toBe('webm');
    });

    it('declares one mono 48 kHz A_OPUS track with its OpusHead and codec delay', () => {
        const seg = children(children(file)[1].data);
        const entry = children(find(seg, 0x1654ae6b).data)[0];
        const t = children(entry.data);
        expect(strOf(find(t, 0x86).data)).toBe('A_OPUS');
        expect(uintOf(find(t, 0x83).data)).toBe(2);
        expect(opusHeadPreSkip(find(t, 0x63a2).data)).toBe(DEFAULT_OPUS_PRE_SKIP);
        expect(uintOf(find(t, 0x56aa).data)).toBe(Math.round(DEFAULT_OPUS_PRE_SKIP * 1e9 / 48_000));
        const audio = children(find(t, 0xe1).data);
        expect(new DataView(find(audio, 0xb5).data.slice().buffer).getFloat64(0)).toBe(48_000);
        expect(uintOf(find(audio, 0x9f).data)).toBe(1);
        const info = children(find(seg, 0x1549a966).data);
        expect(uintOf(find(info, 0x2ad7b1).data)).toBe(1_000_000);
    });

    it('writes every packet as a keyframe SimpleBlock at its ms offset, in order', () => {
        const seg = children(children(file)[1].data);
        const cluster = children(find(seg, 0x1f43b675).data);
        const blocks = cluster.filter(e => e.id === 0xa3);
        expect(blocks.length).toBe(5);
        blocks.forEach((b, i) => {
            expect(b.data[0]).toBe(0x81);
            expect(new DataView(b.data.slice().buffer).getInt16(1)).toBe(i * 20);
            expect(b.data[3]).toBe(0x80);
            expect([...b.data.subarray(4)]).toEqual([0xfc, i, i + 1]);
        });
    });

    it('uses the encoder\'s OpusHead when it gives one', () => {
        const f = muxOpusWebm({ packets, durationMs: 100, opusHead: buildOpusHead(120) });
        const seg = children(children(f)[1].data);
        const t = children(children(find(seg, 0x1654ae6b).data)[0].data);
        expect(opusHeadPreSkip(find(t, 0x63a2).data)).toBe(120);
    });

    it('refuses an empty packet list', () => {
        expect(() => muxOpusWebm({ packets: [], durationMs: 0 })).toThrow();
    });
});
