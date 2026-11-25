/**
 * Windows .ico files (a site's /favicon.ico) → one picture's pixels, on the
 * SENDER, before the usual re-encode to a fresh WebP (thumb.ts). Pure and
 * bounds-checked: every offset and size is checked against the buffer, and
 * anything unexpected is "no icon" (the card then draws its letter tile).
 *
 * An .ico is a directory of pictures, each either a whole PNG file or a
 * headerless Windows bitmap (BITMAPINFOHEADER + pixels + a 1-bit AND mask,
 * with the height doubled to cover both). The picture closest to what the
 * card draws (`want` px, at least) is chosen; PNG entries are handed to the
 * browser's PNG decoder as they are, bitmaps are decoded here (1 / 4 / 8 /
 * 24 / 32 bits per pixel, uncompressed) into RGBA.
 */

export interface IcoEntry {
    width: number;
    height: number;
    bitCount: number;
    offset: number;
    size: number;
    png: boolean;
}

export type DecodedIco =
    | { kind: 'png'; bytes: Uint8Array; width: number; height: number }
    | { kind: 'rgba'; width: number; height: number; data: Uint8ClampedArray };

const MAX_ENTRIES = 64;
const MAX_SIDE = 256;

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const i32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

const isPngAt = (b: Uint8Array, o: number) => o + 8 <= b.length && b[o] === 0x89 && b[o + 1] === 0x50 && b[o + 2] === 0x4e && b[o + 3] === 0x47
    && b[o + 4] === 0x0d && b[o + 5] === 0x0a && b[o + 6] === 0x1a && b[o + 7] === 0x0a;

/** Is this an .ico (reserved 0, type 1 = icon, 1..64 pictures)? */
export function isIco(b: Uint8Array): boolean {
    if (b.length < 6 + 16) return false;
    const n = u16(b, 4);
    return u16(b, 0) === 0 && u16(b, 2) === 1 && n >= 1 && n <= MAX_ENTRIES;
}

/** The directory: each picture's size, depth and where its bytes are. Entries pointing outside the file are dropped. */
export function parseIcoDirectory(b: Uint8Array): IcoEntry[] {
    if (!isIco(b)) return [];
    const n = u16(b, 4);
    const out: IcoEntry[] = [];
    for (let i = 0; i < n; i++) {
        const d = 6 + i * 16;
        if (d + 16 > b.length) break;
        const size = u32(b, d + 8);
        const offset = u32(b, d + 12);
        if (size < 8 || offset < 6 + n * 16 || offset + size > b.length) continue;
        out.push({
            width: b[d] || 256,
            height: b[d + 1] || 256,
            bitCount: u16(b, d + 6),
            offset,
            size,
            png: isPngAt(b, offset),
        });
    }
    return out;
}

/** The picture to use: the smallest one at least `want` px, else the largest; the deepest colour on a tie. */
export function pickIcoEntry(entries: readonly IcoEntry[], want: number): IcoEntry | undefined {
    const edge = (e: IcoEntry) => Math.max(e.width, e.height);
    const depth = (e: IcoEntry) => (e.png ? 32 : e.bitCount || 0);
    const big = entries.filter((e) => edge(e) >= want).sort((a, b) => edge(a) - edge(b) || depth(b) - depth(a));
    if (big.length) return big[0];
    return [...entries].sort((a, b) => edge(b) - edge(a) || depth(b) - depth(a))[0];
}

/** One headerless bitmap entry → RGBA, or null. */
export function decodeIcoBitmap(b: Uint8Array, e: IcoEntry): { width: number; height: number; data: Uint8ClampedArray } | null {
    const o = e.offset;
    if (o + 40 > b.length) return null;
    const headerSize = u32(b, o);
    if (headerSize < 40 || headerSize > 124 || o + headerSize > e.offset + e.size) return null;
    const width = i32(b, o + 4);
    const fullHeight = i32(b, o + 8);
    const bpp = u16(b, o + 14);
    const compression = u32(b, o + 16);
    const clrUsed = u32(b, o + 32);
    // The ICO bitmap's height covers the colour rows AND the mask rows; bottom-up only.
    const height = Math.floor(fullHeight / 2);
    if (width < 1 || width > MAX_SIDE || height < 1 || height > MAX_SIDE) return null;
    if (compression !== 0) return null; // BI_RGB only
    if (![1, 4, 8, 24, 32].includes(bpp)) return null;
    let p = o + headerSize;
    let palette: Uint8Array | null = null;
    if (bpp <= 8) {
        const colors = clrUsed > 0 && clrUsed <= (1 << bpp) ? clrUsed : (1 << bpp);
        if (p + colors * 4 > e.offset + e.size) return null;
        palette = b.subarray(p, p + colors * 4);
        p += colors * 4;
    }
    const xorStride = Math.floor((width * bpp + 31) / 32) * 4;
    const andStride = Math.floor((width + 31) / 32) * 4;
    const xorStart = p;
    const andStart = xorStart + xorStride * height;
    const end = e.offset + e.size;
    if (xorStart + xorStride * height > end) return null;
    const hasMask = andStart + andStride * height <= end;

    const data = new Uint8ClampedArray(width * height * 4);
    let anyAlpha = false;
    for (let y = 0; y < height; y++) {
        const row = xorStart + (height - 1 - y) * xorStride; // bottom-up
        for (let x = 0; x < width; x++) {
            const q = (y * width + x) * 4;
            let r = 0, g = 0, bl = 0, a = 255;
            if (bpp === 32) {
                const s = row + x * 4;
                bl = b[s]; g = b[s + 1]; r = b[s + 2]; a = b[s + 3];
                if (a) anyAlpha = true;
            } else if (bpp === 24) {
                const s = row + x * 3;
                bl = b[s]; g = b[s + 1]; r = b[s + 2];
            } else {
                const bit = x * bpp;
                const byte = b[row + (bit >> 3)];
                const idx = bpp === 8 ? byte : bpp === 4 ? (byte >> (4 - (bit & 7))) & 0x0f : (byte >> (7 - (bit & 7))) & 1;
                const c = idx * 4;
                if (!palette || c + 3 >= palette.length) return null;
                bl = palette[c]; g = palette[c + 1]; r = palette[c + 2];
            }
            data[q] = r; data[q + 1] = g; data[q + 2] = bl; data[q + 3] = a;
        }
    }
    // Transparency: a 32-bit picture carries its own alpha (unless it is all zero,
    // as some old writers leave it); the rest use the AND mask (1 = transparent).
    if ((bpp !== 32 || !anyAlpha) && hasMask) {
        for (let y = 0; y < height; y++) {
            const row = andStart + (height - 1 - y) * andStride;
            for (let x = 0; x < width; x++) {
                const transparent = (b[row + (x >> 3)] >> (7 - (x & 7))) & 1;
                data[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
            }
        }
    } else if (bpp === 32 && !anyAlpha) {
        for (let i = 3; i < data.length; i += 4) data[i] = 255;
    }
    return { width, height, data };
}

/** An .ico → the best picture (PNG bytes as they are, or a bitmap decoded to RGBA), or null. */
export function decodeIco(b: Uint8Array, want = 64): DecodedIco | null {
    const entries = parseIcoDirectory(b);
    // Try the preferred picture, then the others, best first.
    const first = pickIcoEntry(entries, want);
    const order = first ? [first, ...entries.filter((e) => e !== first)] : [];
    for (const e of order) {
        if (e.png) {
            return { kind: 'png', bytes: b.subarray(e.offset, e.offset + e.size), width: e.width, height: e.height };
        }
        const bmp = decodeIcoBitmap(b, e);
        if (bmp) return { kind: 'rgba', ...bmp };
    }
    return null;
}
