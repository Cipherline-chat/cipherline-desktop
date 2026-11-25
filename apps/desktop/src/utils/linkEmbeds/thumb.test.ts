import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sniffImageMime, fitSize, bytesToBase64, base64ToBytes, reencodeThumb, THUMB_MAX_EDGE } from './thumb';

describe('sniffImageMime: the bytes decide, never a declared type', () => {
    it.each([
        ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0], 'image/png'],
        ['jpeg', [0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
        ['webp', [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50], 'image/webp'],
        ['gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'image/gif'],
        ['avif', [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 'image/avif'],
        ['svg', [...Buffer.from('<svg xmlns=')], null],
        ['html', [...Buffer.from('<!doctype html>')], null],
        ['riff-not-webp', [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20], null],
        ['empty', [], null],
    ])('%s', (_n, bytes, want) => {
        expect(sniffImageMime(new Uint8Array(bytes as number[]))).toBe(want);
    });
});

describe('fitSize', () => {
    it('fits the longest edge, never upscales', () => {
        expect(fitSize(1920, 1080)).toEqual({ width: THUMB_MAX_EDGE, height: Math.round(1080 * THUMB_MAX_EDGE / 1920) });
        expect(fitSize(300, 200)).toEqual({ width: 300, height: 200 });
        expect(fitSize(400, 4000).height).toBe(THUMB_MAX_EDGE);
        expect(fitSize(1920, 1080, 0.5).width).toBe(THUMB_MAX_EDGE / 2);
    });
});

describe('base64', () => {
    it('round-trips bytes', () => {
        const b = new Uint8Array(70_000).map((_, i) => (i * 7) & 0xff);
        expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    });
});

describe('reencodeThumb refuses what is not a raster image before decoding', () => {
    it('svg / html / junk → null (no decode attempted)', async () => {
        for (const s of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<html>', '']) {
            expect(await reencodeThumb(new Uint8Array(Buffer.from(s)))).toBeNull();
        }
    });
    it('the pixels-only rule is the code\'s: decode → canvas → a NEW WebP (source check)', () => {
        const src = readFileSync(join(__dirname, 'thumb.ts'), 'utf8');
        expect(src).toMatch(/createImageBitmap\(/);
        // reencodeThumb hands the decoded bitmap to encodeWebpThumb, which draws it onto a fresh canvas.
        expect(src).toMatch(/encodeWebpThumb\(bitmap,/);
        expect(src).toMatch(/ctx\.drawImage\(src, 0, 0, width, height\)/);
        expect(src).toMatch(/type: 'image\/webp'/);
    });
});
