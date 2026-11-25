/**
 * Site icons through the sender's re-encode (thumb.ts reencodeThumb): an .ico
 * is opened (ico.ts) and its pixels — never its bytes — become a fresh WebP;
 * a PNG favicon goes to the PNG decoder; SVG / HTML never reach a decoder.
 * The browser's decoder and canvas are stand-ins here (node has neither): the
 * test checks WHAT is handed to createImageBitmap and that a WebP comes out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Blob as NodeBlob } from 'node:buffer';
import { reencodeThumb, SITE_ICON_MAX_EDGE } from './thumb';

const LIVE = path.join(__dirname, '..', '..', '..', 'electron', 'unfurl', '__fixtures__', 'live');
const bin = (n: string) => new Uint8Array(fs.readFileSync(path.join(LIVE, n)));

class FakeImageData {
    readonly data: Uint8ClampedArray; readonly width: number; readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) { this.data = data; this.width = width; this.height = height; }
}
const decoded: unknown[] = [];
const drawn: { w: number; h: number }[] = [];
const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
    decoded.length = 0;
    drawn.length = 0;
    for (const k of ['createImageBitmap', 'ImageData', 'OffscreenCanvas', 'Blob']) saved[k] = g[k];
    g.ImageData = FakeImageData;
    g.Blob = NodeBlob;
    g.createImageBitmap = vi.fn(async (src: unknown) => {
        decoded.push(src);
        if (src instanceof FakeImageData) return { width: src.width, height: src.height, close() {} };
        const type = (src as Blob).type;
        if (type !== 'image/png') throw new Error('not decodable here');
        return { width: 180, height: 180, close() {} };
    });
    g.OffscreenCanvas = class {
        width: number; height: number;
        constructor(width: number, height: number) { this.width = width; this.height = height; }
        getContext() { return { drawImage: () => { drawn.push({ w: this.width, h: this.height }); } }; }
        async convertToBlob() { return new NodeBlob([new Uint8Array(300)], { type: 'image/webp' }); }
    };
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) g[k] = v; });

describe('favicons through reencodeThumb', () => {
    it('amazon.com /favicon.ico (32-bit bitmaps): its 48 px picture is decoded to pixels here, then a fresh 48 px WebP', async () => {
        const out = await reencodeThumb(bin('amazon.ico'), SITE_ICON_MAX_EDGE);
        expect(decoded).toHaveLength(1);
        expect(decoded[0]).toBeInstanceOf(FakeImageData);           // pixels, not the file
        expect((decoded[0] as FakeImageData).width).toBe(48);
        expect(out).toMatchObject({ mime: 'image/webp', width: 48, height: 48 });
    });

    it('wikipedia.org .ico (4-bit palette): decoded to pixels, a WebP comes out', async () => {
        const out = await reencodeThumb(bin('wikipedia.ico'), SITE_ICON_MAX_EDGE);
        expect(decoded[0]).toBeInstanceOf(FakeImageData);
        expect(out?.mime).toBe('image/webp');
    });

    it('a PNG favicon (nytimes.com\'s ".ico") goes to the PNG decoder and is scaled to the icon edge', async () => {
        const out = await reencodeThumb(bin('nytimes.ico'), SITE_ICON_MAX_EDGE);
        expect((decoded[0] as Blob).type).toBe('image/png');
        expect(out).toMatchObject({ width: SITE_ICON_MAX_EDGE, height: SITE_ICON_MAX_EDGE });
        expect(drawn[0]).toEqual({ w: 64, h: 64 });
    });

    it('positive control: SVG, HTML and a corrupt .ico never reach a decoder', async () => {
        const corrupt = bin('amazon.ico').slice(0, 30); // directory only, pictures cut off
        for (const b of [new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), new Uint8Array(Buffer.from('<!doctype html>')), corrupt]) {
            expect(await reencodeThumb(b, SITE_ICON_MAX_EDGE)).toBeNull();
        }
        expect(decoded).toHaveLength(0);
    });
});
