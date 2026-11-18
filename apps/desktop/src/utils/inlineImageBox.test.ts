import { describe, it, expect } from 'vitest';
import { inlineImageBox } from './inlineImageBox';

/**
 * Layout model of ImageLinkEmbed's <img> (max-width: 100% of a column `col`
 * px wide, max-height: 300, inside a wrapper capped at 320 px), in CSS terms:
 *   - no box: the natural size, scaled down (ratio kept) to fit both maxima;
 *   - explicit width + height (the OLD box): max-width clamps the width only,
 *     the height stays as written;
 *   - width + height:auto + aspect-ratio (the NEW box): the clamped width,
 *     height from the ratio, then max-height (ratio kept).
 */
const fit = (w: number, h: number, maxW: number, maxH: number) => {
    const k = Math.min(1, maxW / w, maxH / h);
    return { w: w * k, h: h * k };
};
const layoutNatural = (nw: number, nh: number, col: number) => fit(nw, nh, Math.min(320, col), 300);
const layoutOldBox = (nw: number, nh: number, col: number) => {
    const k = Math.min(1, 320 / nw, 300 / nh);
    const bw = Math.round(nw * k), bh = Math.round(nh * k);
    return { w: Math.min(bw, Math.min(320, col)), h: bh };
};
const layoutNewBox = (nw: number, nh: number, col: number) => {
    const b = inlineImageBox(nw, nh)!;
    const [rw, rh] = b.aspectRatio.split(' / ').map(Number);
    return fit(b.width, (b.width * rh) / rw, Math.min(320, col), 300);
};

const SIZES: Array<[number, number]> = [[480, 270], [1920, 1080], [1080, 1920], [300, 200], [4000, 300], [64, 64], [333, 777]];
const COLUMNS = [180, 240, 312, 320, 400, 900];

describe('inlineImageBox', () => {
    it('positive control: the old explicit width+height box lays out taller than the image itself in a narrow column (the jump)', () => {
        const nat = layoutNatural(480, 270, 312);
        const old = layoutOldBox(480, 270, 312);
        expect(nat.h).toBeCloseTo(175.5, 1);
        expect(old.h).toBe(180);
        expect(old.h - nat.h).toBeGreaterThan(4);
    });

    it('lays out exactly like the unboxed image at every column width (so a later render that adds it moves nothing)', () => {
        for (const [nw, nh] of SIZES) {
            for (const col of COLUMNS) {
                const a = layoutNatural(nw, nh, col);
                const b = layoutNewBox(nw, nh, col);
                expect(Math.abs(a.w - b.w), `${nw}x${nh} in ${col}px (w)`).toBeLessThan(0.01);
                expect(Math.abs(a.h - b.h), `${nw}x${nh} in ${col}px (h)`).toBeLessThan(0.01);
            }
        }
    });

    it('never fixes the height and keeps the natural ratio; width is unrounded', () => {
        const b = inlineImageBox(1080, 1920)!;
        expect(b.height).toBe('auto');
        expect(b.aspectRatio).toBe('1080 / 1920');
        expect(b.width).toBe(168.75);
    });

    it('no box until the size is known', () => {
        expect(inlineImageBox(undefined, 100)).toBeNull();
        expect(inlineImageBox(100, 0)).toBeNull();
    });
});
