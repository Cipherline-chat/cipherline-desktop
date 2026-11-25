/**
 * The .ico reader (ico.ts) on real favicons saved live 2026-11-23 and on
 * hand-built files: directory parsing, which picture is chosen, PNG entries
 * handed over as-is, bitmap entries decoded (32-bit alpha, 24 / 8 / 4 / 1-bit
 * with the AND mask), and malformed files refused (positive controls).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { decodeIco, decodeIcoBitmap, isIco, parseIcoDirectory, pickIcoEntry, type IcoEntry } from './ico';

const LIVE = path.join(__dirname, '..', '..', '..', 'electron', 'unfurl', '__fixtures__', 'live');
const bytes = (name: string) => new Uint8Array(fs.readFileSync(path.join(LIVE, name)));

// ── builders ────────────────────────────────────────────────────────────────

const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/** A BITMAPINFOHEADER bitmap entry: `pixel(x, y)` → [r, g, b, a] (y = 0 is the TOP row). */
function dib(w: number, h: number, bpp: 32 | 24 | 8 | 4 | 1, pixel: (x: number, y: number) => number[], opts: { palette?: number[][]; mask?: (x: number, y: number) => boolean } = {}): number[] {
    const head = [...le32(40), ...le32(w), ...le32(h * 2), ...le16(1), ...le16(bpp), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le32(opts.palette?.length ?? 0), ...le32(0)];
    const pal = (opts.palette ?? []).flatMap(([r, g, b]) => [b, g, r, 0]);
    const xorStride = Math.floor((w * bpp + 31) / 32) * 4;
    const rows: number[] = [];
    for (let y = h - 1; y >= 0; y--) { // bottom-up
        const row = new Array(xorStride).fill(0);
        for (let x = 0; x < w; x++) {
            const px = pixel(x, y);
            if (bpp === 32) { row[x * 4] = px[2]; row[x * 4 + 1] = px[1]; row[x * 4 + 2] = px[0]; row[x * 4 + 3] = px[3]; }
            else if (bpp === 24) { row[x * 3] = px[2]; row[x * 3 + 1] = px[1]; row[x * 3 + 2] = px[0]; }
            else {
                const idx = px[0]; // palette index
                const bit = x * bpp;
                row[bit >> 3] |= bpp === 8 ? idx : bpp === 4 ? idx << (4 - (bit & 7)) : idx << (7 - (bit & 7));
            }
        }
        rows.push(...row);
    }
    const andStride = Math.floor((w + 31) / 32) * 4;
    const mask: number[] = [];
    for (let y = h - 1; y >= 0; y--) {
        const row = new Array(andStride).fill(0);
        for (let x = 0; x < w; x++) if (opts.mask?.(x, y)) row[x >> 3] |= 1 << (7 - (x & 7));
        mask.push(...row);
    }
    return [...head, ...pal, ...rows, ...mask];
}

function ico(entries: { w: number; h: number; bpp: number; data: number[] }[]): Uint8Array {
    const dir: number[] = [...le16(0), ...le16(1), ...le16(entries.length)];
    let offset = 6 + entries.length * 16;
    const blobs: number[] = [];
    for (const e of entries) {
        dir.push(e.w >= 256 ? 0 : e.w, e.h >= 256 ? 0 : e.h, 0, 0, ...le16(1), ...le16(e.bpp), ...le32(e.data.length), ...le32(offset));
        blobs.push(...e.data);
        offset += e.data.length;
    }
    return new Uint8Array([...dir, ...blobs]);
}

const at = (d: { width: number; data: Uint8ClampedArray }, x: number, y: number) => Array.from(d.data.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 4));

// ── real favicons ───────────────────────────────────────────────────────────

describe('real favicon.ico files (saved live)', () => {
    it('amazon.com: three 32-bit bitmaps; the 48 px one is chosen for a 64 px card and decodes with its alpha', () => {
        const b = bytes('amazon.ico');
        expect(isIco(b)).toBe(true);
        const dir = parseIcoDirectory(b);
        expect(dir.map((e) => [e.width, e.bitCount, e.png])).toEqual([[48, 32, false], [32, 32, false], [16, 32, false]]);
        const out = decodeIco(b, 64);
        expect(out?.kind).toBe('rgba');
        if (out?.kind !== 'rgba') return;
        expect([out.width, out.height, out.data.length]).toEqual([48, 48, 48 * 48 * 4]);
        const alphas = new Set<number>();
        for (let i = 3; i < out.data.length; i += 4) alphas.add(out.data[i]);
        expect(alphas.size).toBeGreaterThan(2); // real anti-aliased alpha, not all-opaque / all-clear
        expect(out.data.some((v, i) => i % 4 !== 3 && v > 0)).toBe(true);
    });

    it('wikipedia.org: 4-bit palette bitmaps with an AND mask (transparent corners, opaque centre)', () => {
        const b = bytes('wikipedia.ico');
        const dir = parseIcoDirectory(b);
        expect(dir.length).toBe(3);
        expect(dir.every((e) => !e.png && e.bitCount === 4)).toBe(true);
        const out = decodeIco(b, 64);
        expect(out?.kind).toBe('rgba');
        if (out?.kind !== 'rgba') return;
        expect(out.width).toBe(48);
        expect(at(out, 0, 0)[3]).toBe(0);                 // a corner is masked out
        expect(at(out, 24, 24)[3]).toBe(255);             // the globe is opaque
    });

    it('nytimes.com\'s ".ico" is really a PNG: not an .ico at all (the PNG decoder takes it)', () => {
        const b = bytes('nytimes.ico');
        expect(isIco(b)).toBe(false);
        expect(decodeIco(b)).toBeNull();
    });
});

// ── hand-built files ────────────────────────────────────────────────────────

describe('decodeIco', () => {
    const red = [255, 0, 0, 255];
    it('a PNG entry is handed over byte for byte (the browser\'s PNG decoder draws it)', () => {
        const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8];
        const out = decodeIco(ico([{ w: 256, h: 256, bpp: 32, data: png }]));
        expect(out?.kind).toBe('png');
        expect(out?.kind === 'png' && Array.from(out.bytes)).toEqual(png);
        expect(out?.kind === 'png' && out.width).toBe(256);
    });

    it('32-bit: per-pixel alpha, rows bottom-up → top-down', () => {
        const out = decodeIco(ico([{ w: 2, h: 2, bpp: 32, data: dib(2, 2, 32, (x, y) => (y === 0 ? [255, 0, 0, 255] : [0, 0, 255, x ? 128 : 0])) }]));
        expect(out?.kind).toBe('rgba');
        if (out?.kind !== 'rgba') return;
        expect(at(out, 0, 0)).toEqual(red);
        expect(at(out, 1, 1)).toEqual([0, 0, 255, 128]);
        expect(at(out, 0, 1)).toEqual([0, 0, 255, 0]);
    });

    it('32-bit with an all-zero alpha channel (old writers): the AND mask decides', () => {
        const out = decodeIco(ico([{ w: 2, h: 1, bpp: 32, data: dib(2, 1, 32, () => [10, 20, 30, 0], { mask: (x) => x === 1 }) }]));
        if (out?.kind !== 'rgba') throw new Error('expected rgba');
        expect(at(out, 0, 0)).toEqual([10, 20, 30, 255]);
        expect(at(out, 1, 0)[3]).toBe(0);
    });

    it('24-bit + mask, 8-bit, 4-bit and 1-bit palettes', () => {
        const o24 = decodeIco(ico([{ w: 3, h: 1, bpp: 24, data: dib(3, 1, 24, (x) => [x * 100, 7, 9, 0], { mask: (x) => x === 2 }) }]));
        if (o24?.kind !== 'rgba') throw new Error('24');
        expect([at(o24, 0, 0), at(o24, 1, 0), at(o24, 2, 0)[3]]).toEqual([[0, 7, 9, 255], [100, 7, 9, 255], 0]);
        const pal = [[0, 0, 0], [255, 255, 255], [0, 128, 0]];
        for (const bpp of [8, 4] as const) {
            const o = decodeIco(ico([{ w: 3, h: 2, bpp, data: dib(3, 2, bpp, (x) => [x], { palette: pal }) }]));
            if (o?.kind !== 'rgba') throw new Error(String(bpp));
            expect([at(o, 0, 1), at(o, 1, 0), at(o, 2, 1)]).toEqual([[0, 0, 0, 255], [255, 255, 255, 255], [0, 128, 0, 255]]);
        }
        const o1 = decodeIco(ico([{ w: 9, h: 1, bpp: 1, data: dib(9, 1, 1, (x) => [x % 2], { palette: pal.slice(0, 2) }) }]));
        if (o1?.kind !== 'rgba') throw new Error('1');
        expect([at(o1, 0, 0), at(o1, 1, 0), at(o1, 8, 0)]).toEqual([[0, 0, 0, 255], [255, 255, 255, 255], [0, 0, 0, 255]]);
    });

    it('picks the smallest picture at least `want` px, else the largest; the deeper one on a tie', () => {
        const e = (w: number, bitCount: number, png = false): IcoEntry => ({ width: w, height: w, bitCount, png, offset: 0, size: 0 });
        expect(pickIcoEntry([e(16, 32), e(32, 32), e(48, 32), e(256, 32, true)], 64)?.width).toBe(256);
        expect(pickIcoEntry([e(16, 32), e(32, 32), e(48, 32), e(128, 32)], 64)?.width).toBe(128);
        expect(pickIcoEntry([e(16, 32), e(32, 32)], 64)?.width).toBe(32);
        expect(pickIcoEntry([e(32, 4), e(32, 32)], 64)?.bitCount).toBe(32);
        expect(pickIcoEntry([], 64)).toBeUndefined();
    });

    it('a broken preferred picture falls back to the next one that decodes', () => {
        const good = dib(2, 2, 32, () => [1, 2, 3, 255]);
        const bad = [...dib(4, 4, 32, () => [9, 9, 9, 255])];
        bad[16] = 1; // compression = BI_RLE8: not decoded
        const out = decodeIco(ico([{ w: 4, h: 4, bpp: 32, data: bad }, { w: 2, h: 2, bpp: 32, data: good }]), 4);
        expect(out?.kind === 'rgba' && out.width).toBe(2);
    });
});

describe('malformed files are refused (positive controls: the same files decode when well-formed)', () => {
    const okData = dib(2, 2, 32, () => [1, 2, 3, 255]);
    it('well-formed control decodes', () => {
        expect(decodeIco(ico([{ w: 2, h: 2, bpp: 32, data: okData }]))?.kind).toBe('rgba');
    });
    it('not an .ico / empty / too many entries', () => {
        expect(isIco(new Uint8Array(0))).toBe(false);
        expect(isIco(new Uint8Array([0, 0, 2, 0, 1, 0, ...new Array(16).fill(0)]))).toBe(false); // type 2 = cursor
        expect(isIco(new Uint8Array([0, 0, 1, 0, 0, 0, ...new Array(16).fill(0)]))).toBe(false); // 0 pictures
        expect(isIco(new Uint8Array([0, 0, 1, 0, 65, 0, ...new Array(16).fill(0)]))).toBe(false);
        expect(decodeIco(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    });
    it('an entry pointing past the end of the file is dropped', () => {
        const f = ico([{ w: 2, h: 2, bpp: 32, data: okData }]);
        const cut = f.slice(0, f.length - 10);
        expect(parseIcoDirectory(cut)).toEqual([]);
        expect(decodeIco(cut)).toBeNull();
    });
    it('absurd sizes, unknown depths and compressed bitmaps are not decoded', () => {
        const big = [...okData]; big.splice(4, 4, ...le32(5000)); // width 5000
        expect(decodeIco(ico([{ w: 2, h: 2, bpp: 32, data: big }]))).toBeNull();
        const depth = [...okData]; depth.splice(14, 2, ...le16(16)); // 16 bpp
        expect(decodeIco(ico([{ w: 2, h: 2, bpp: 16, data: depth }]))).toBeNull();
        const comp = [...okData]; comp.splice(16, 4, ...le32(3)); // BI_BITFIELDS
        expect(decodeIco(ico([{ w: 2, h: 2, bpp: 32, data: comp }]))).toBeNull();
        const shortPixels = okData.slice(0, 40 + 4); // header + one pixel
        expect(decodeIcoBitmap(new Uint8Array([...new Array(22).fill(0), ...shortPixels]), { width: 2, height: 2, bitCount: 32, png: false, offset: 22, size: shortPixels.length })).toBeNull();
    });
});
