import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    hasTransparentPixel, mayHaveAlpha, pickThumbEncoding, thumbPreservesAlpha,
    THUMB_JPEG_QUALITY, THUMB_ALPHA_QUALITY,
} from './imageThumbEncoding';

const px = (...rgba: number[][]) => Uint8ClampedArray.from(rgba.flat());

describe('hasTransparentPixel', () => {
    it('is false for a fully opaque image (control: photos keep their small JPEG)', () => {
        expect(hasTransparentPixel(px([10, 20, 30, 255], [255, 255, 255, 255], [0, 0, 0, 255]))).toBe(false);
    });

    it('is true when any pixel is transparent — a logo with a clear background', () => {
        expect(hasTransparentPixel(px([0, 0, 0, 0], [200, 30, 30, 255]))).toBe(true);
    });

    it('is true for a single semi-transparent pixel (soft shadow / anti-aliased edge)', () => {
        expect(hasTransparentPixel(px([1, 2, 3, 255], [1, 2, 3, 255], [1, 2, 3, 254]))).toBe(true);
    });

    it('reads the ALPHA byte, not a colour channel that happens to be 0', () => {
        // Opaque black has three zero bytes; only index 3 is alpha.
        expect(hasTransparentPixel(px([0, 0, 0, 255]))).toBe(false);
    });

    it('handles an empty buffer', () => {
        expect(hasTransparentPixel(new Uint8ClampedArray(0))).toBe(false);
    });

    it('finds transparency late in a large buffer', () => {
        const big = new Uint8ClampedArray(500 * 500 * 4).fill(255);
        big[big.length - 1] = 0;
        expect(hasTransparentPixel(big)).toBe(true);
    });
});

describe('pickThumbEncoding', () => {
    it('opaque → JPEG at the existing quality', () => {
        expect(pickThumbEncoding(false)).toEqual({ type: 'image/jpeg', quality: THUMB_JPEG_QUALITY });
        expect(THUMB_JPEG_QUALITY).toBe(0.75);
    });

    it('transparent → an alpha-capable format, never JPEG', () => {
        const e = pickThumbEncoding(true);
        expect(e.type).toBe('image/webp');
        expect(e.quality).toBe(THUMB_ALPHA_QUALITY);
        expect(thumbPreservesAlpha(e.type)).toBe(true);
    });
});

describe('thumbPreservesAlpha', () => {
    it('accepts WebP and the PNG a browser falls back to; rejects JPEG', () => {
        expect(thumbPreservesAlpha('image/webp')).toBe(true);
        expect(thumbPreservesAlpha('image/png')).toBe(true);
        expect(thumbPreservesAlpha('image/jpeg')).toBe(false);
        expect(thumbPreservesAlpha('')).toBe(false);
    });
});

describe('mayHaveAlpha', () => {
    it('scans PNG / WebP / AVIF, never a JPEG', () => {
        expect(mayHaveAlpha('image/png')).toBe(true);
        expect(mayHaveAlpha('image/webp')).toBe(true);
        expect(mayHaveAlpha('image/avif')).toBe(true);
        expect(mayHaveAlpha('IMAGE/PNG')).toBe(true);
        expect(mayHaveAlpha('image/jpeg')).toBe(false);
    });
});

/** FileViewer has no render harness here; pin the wiring at source level. */
describe('FileViewer thumbnail wiring', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'FileViewer.tsx'), 'utf8');
    const thumb = src.slice(src.indexOf('const hit = acquireMediaThumb(objectUrl);'), src.indexOf('// Reserve the inline image'));

    it('no longer hard-codes a JPEG encode for every image', () => {
        expect(thumb).not.toContain("'image/jpeg'");
        expect(thumb).toContain('canvas.toBlob(');
        expect(thumb).toContain('enc.type, enc.quality');
    });

    it('scans for alpha before choosing, fails toward alpha-safe, and refuses a JPEG result for a transparent source', () => {
        expect(thumb).toContain('hasTransparentPixel(ctx.getImageData(0, 0, w, h).data)');
        expect(thumb).toContain('catch { hasAlpha = true; }');
        expect(thumb).toContain('if (hasAlpha && !thumbPreservesAlpha(blob.type)) return;');
    });

    it('the inline <img> and GIF player carry no background of their own (only the loading skeleton does)', () => {
        const img = src.slice(src.indexOf('<img src={inlineSrc}'), src.indexOf('onLoad={e => e.currentTarget.dispatchEvent'));
        expect(img).not.toMatch(/background/);
        const gif = src.slice(src.indexOf('<GifPlayer'), src.indexOf('onLoad={notifyLoaded}'));
        expect(gif).not.toMatch(/background/);
    });
});
