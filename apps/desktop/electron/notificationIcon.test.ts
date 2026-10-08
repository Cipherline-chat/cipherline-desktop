import { describe, it, expect } from 'vitest';
import * as zlib from 'zlib';
import { validateNotifIconDataUrl, MAX_ICON_DATA_URL_CHARS, MAX_ICON_DIMENSION } from './notificationIcon';

/** A real, decodable RGBA PNG of the given size (transparent pixels). */
function makePng(width: number, height: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
    const raw = Buffer.alloc((width * 4 + 1) * height); // filter byte 0 per row
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
const dataUrl = (b: Buffer, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`;

describe('validateNotifIconDataUrl', () => {
    it('positive control: accepts the 96x96 PNG the renderer produces', () => {
        const png = makePng(96, 96);
        const ok = validateNotifIconDataUrl(dataUrl(png));
        expect(ok).not.toBeNull();
        expect(ok!.width).toBe(96);
        expect(ok!.height).toBe(96);
        expect(ok!.png.equals(png)).toBe(true);
    });

    it('accepts the dimension boundary (1x1 and MAX x MAX)', () => {
        expect(validateNotifIconDataUrl(dataUrl(makePng(1, 1)))).not.toBeNull();
        expect(validateNotifIconDataUrl(dataUrl(makePng(MAX_ICON_DIMENSION, MAX_ICON_DIMENSION)))).not.toBeNull();
    });

    it('rejects one pixel past the dimension cap on either axis', () => {
        expect(validateNotifIconDataUrl(dataUrl(makePng(MAX_ICON_DIMENSION + 1, 10)))).toBeNull();
        expect(validateNotifIconDataUrl(dataUrl(makePng(10, MAX_ICON_DIMENSION + 1)))).toBeNull();
    });

    it('rejects a tiny file declaring a huge canvas (decompression-bomb shape)', () => {
        const png = makePng(4, 4);
        png.writeUInt32BE(50_000, 16);
        png.writeUInt32BE(50_000, 20);
        expect(validateNotifIconDataUrl(dataUrl(png))).toBeNull();
    });

    it('rejects zero dimensions', () => {
        const png = makePng(4, 4);
        png.writeUInt32BE(0, 16);
        expect(validateNotifIconDataUrl(dataUrl(png))).toBeNull();
    });

    it('rejects non-strings', () => {
        for (const v of [undefined, null, 42, {}, [], Buffer.from('x'), true]) {
            expect(validateNotifIconDataUrl(v)).toBeNull();
        }
    });

    it('rejects other image types, even with real PNG bytes behind them', () => {
        const png = makePng(8, 8);
        expect(validateNotifIconDataUrl(dataUrl(png, 'image/jpeg'))).toBeNull();
        expect(validateNotifIconDataUrl(dataUrl(png, 'image/svg+xml'))).toBeNull();
        expect(validateNotifIconDataUrl(dataUrl(png, 'image/gif'))).toBeNull();
    });

    it('rejects paths, file:// and http(s) URLs', () => {
        for (const v of ['C:\\Windows\\system32\\x.png', '/etc/passwd', 'file:///etc/passwd', 'https://evil.example/x.png']) {
            expect(validateNotifIconDataUrl(v)).toBeNull();
        }
    });

    it('rejects a PNG mime with non-PNG bytes', () => {
        const notPng = Buffer.from('GIF89a' + 'x'.repeat(40));
        expect(validateNotifIconDataUrl(dataUrl(notPng))).toBeNull();
    });

    it('rejects a PNG signature without an IHDR first chunk', () => {
        const png = makePng(8, 8);
        png.write('IDAT', 12, 'ascii');
        expect(validateNotifIconDataUrl(dataUrl(png))).toBeNull();
    });

    it('rejects malformed base64 and an empty body', () => {
        expect(validateNotifIconDataUrl('data:image/png;base64,')).toBeNull();
        expect(validateNotifIconDataUrl('data:image/png;base64,@@@@')).toBeNull();
        expect(validateNotifIconDataUrl('data:image/png;base64,abc')).toBeNull(); // not a multiple of 4
        expect(validateNotifIconDataUrl('data:image/png;base64,' + makePng(8, 8).toString('base64') + '\n')).toBeNull();
    });

    it('rejects oversize input before decoding it', () => {
        const head = 'data:image/png;base64,' + makePng(8, 8).toString('base64');
        const padded = head + 'A'.repeat(MAX_ICON_DATA_URL_CHARS - head.length + 4);
        expect(padded.length).toBeGreaterThan(MAX_ICON_DATA_URL_CHARS);
        expect(validateNotifIconDataUrl(padded)).toBeNull();
    });
});
