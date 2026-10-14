import { describe, it, expect } from 'vitest';
import {
    ULTRAWIDE_ASPECT, aspectOf, isUltrawide, inferSliceCount, defaultLayoutFor, layoutChoices, layoutsEqual,
    sliceRect, sliceLabel, parseLayout, centerIndex, WHOLE_LAYOUT,
} from './shareLayout';

const a = (w: number, h: number) => aspectOf(w, h);

describe('ultra-wide detection (aspect > 2.4)', () => {
    it('the threshold is 2.4', () => {
        expect(ULTRAWIDE_ASPECT).toBe(2.4);
    });

    it.each([
        ['1080p 16:9', 1920, 1080, false],
        ['1440p 16:9', 2560, 1440, false],
        ['16:10', 1920, 1200, false],
        ['21:9 (2560x1080)', 2560, 1080, false],
        ['21:9 (3440x1440)', 3440, 1440, false],
        ['exactly 2.4', 2400, 1000, false],
        ['just over 2.4', 2401, 1000, true],
        ['32:9 (5120x1440)', 5120, 1440, true],
        ['3x1440p Surround (7680x1440)', 7680, 1440, true],
        ['2x4K (7680x2160)', 7680, 2160, true],
        ['3x1080p (5760x1080)', 5760, 1080, true],
    ])('%s -> %s', (_n, w, h, expected) => {
        expect(isUltrawide(a(w, h))).toBe(expected);
    });

    it('unknown aspect is not ultra-wide', () => {
        expect(isUltrawide(null)).toBe(false);
        expect(isUltrawide(undefined)).toBe(false);
        expect(isUltrawide(NaN)).toBe(false);
        expect(aspectOf(0, 100)).toBeNull();
        expect(aspectOf(undefined, 100)).toBeNull();
    });
});

describe('slice count inference (16:9 or 21:9 per screen)', () => {
    it.each([
        ['3x 1440p', 7680, 1440, 3],
        ['3x 1080p', 5760, 1080, 3],
        ['2x 1440p / one 32:9', 5120, 1440, 2],
        ['2x 4K', 7680, 2160, 2],
        ['3x 4K', 11520, 2160, 3],
        ['2x 21:9 (6880x1440)', 6880, 1440, 2],
        ['3x 21:9 (10320x1440)', 10320, 1440, 3],
        ['4x 16:9 (10240x1440)', 10240, 1440, 4],
    ])('%s -> %i', (_n, w, h, count) => {
        expect(inferSliceCount(a(w, h))).toBe(count);
    });

    it('a display that is not ultra-wide is a single screen', () => {
        expect(inferSliceCount(a(2560, 1440))).toBe(1);
        expect(inferSliceCount(null)).toBe(1);
    });

    it('never infers fewer than 2 or more than 5 for an ultra-wide', () => {
        for (const aspect of [2.5, 3, 4, 5, 6, 8, 12, 30]) {
            const n = inferSliceCount(aspect);
            expect(n).toBeGreaterThanOrEqual(2);
            expect(n).toBeLessThanOrEqual(5);
        }
    });
});

describe('default layout', () => {
    it('3-wide (aspect >= 4.5) defaults to the CENTER screen', () => {
        expect(defaultLayoutFor(a(7680, 1440))).toEqual({ kind: 'slice', count: 3, index: 1 });
        expect(defaultLayoutFor(a(5760, 1080))).toEqual({ kind: 'slice', count: 3, index: 1 });
        expect(defaultLayoutFor(a(10320, 1440))).toEqual({ kind: 'slice', count: 3, index: 1 });
    });

    it('2-wide defaults to the whole display, scaled', () => {
        expect(defaultLayoutFor(a(5120, 1440))).toEqual(WHOLE_LAYOUT);
        expect(defaultLayoutFor(a(7680, 2160))).toEqual(WHOLE_LAYOUT);
        // two 21:9 screens are 4.67:1 - over 4.5 but still two screens
        expect(defaultLayoutFor(a(6880, 1440))).toEqual(WHOLE_LAYOUT);
    });

    it('anything not ultra-wide is the whole display', () => {
        expect(defaultLayoutFor(a(1920, 1080))).toEqual(WHOLE_LAYOUT);
        expect(defaultLayoutFor(a(3440, 1440))).toEqual(WHOLE_LAYOUT);
        expect(defaultLayoutFor(null)).toEqual(WHOLE_LAYOUT);
    });

    it('centerIndex', () => {
        expect(centerIndex(2)).toBe(0);
        expect(centerIndex(3)).toBe(1);
        expect(centerIndex(4)).toBe(1);
        expect(centerIndex(5)).toBe(2);
    });
});

describe('layout choices offered in the picker', () => {
    it('none unless ultra-wide', () => {
        expect(layoutChoices(a(2560, 1440))).toEqual([]);
        expect(layoutChoices(null)).toEqual([]);
    });

    it('3-wide: Whole display (scaled), Left, Center, Right', () => {
        const c = layoutChoices(a(7680, 1440));
        expect(c.map(x => x.label)).toEqual(['Whole display (scaled)', 'Left screen', 'Center screen', 'Right screen']);
        expect(c[0].layout).toEqual(WHOLE_LAYOUT);
        expect(c[2].layout).toEqual({ kind: 'slice', count: 3, index: 1 });
    });

    it('2-wide: Whole, Left, Right; 4-wide: numbered', () => {
        expect(layoutChoices(a(5120, 1440)).map(x => x.label)).toEqual(['Whole display (scaled)', 'Left screen', 'Right screen']);
        expect(layoutChoices(a(10240, 1440)).map(x => x.label)).toEqual(['Whole display (scaled)', 'Screen 1', 'Screen 2', 'Screen 3', 'Screen 4']);
        expect(sliceLabel(3, 7)).toBe('Screen 8');
    });

    it('layoutsEqual', () => {
        expect(layoutsEqual(WHOLE_LAYOUT, { kind: 'whole' })).toBe(true);
        expect(layoutsEqual({ kind: 'slice', count: 3, index: 1 }, { kind: 'slice', count: 3, index: 1 })).toBe(true);
        expect(layoutsEqual({ kind: 'slice', count: 3, index: 1 }, { kind: 'slice', count: 3, index: 2 })).toBe(false);
        expect(layoutsEqual({ kind: 'slice', count: 3, index: 1 }, WHOLE_LAYOUT)).toBe(false);
        expect(layoutsEqual(undefined, undefined)).toBe(true);
        expect(layoutsEqual(undefined, WHOLE_LAYOUT)).toBe(false);
    });
});

describe('slice rectangle math', () => {
    it('7680x1440 / 3: three 2560x1440 tiles at x = 0, 2560, 5120', () => {
        expect(sliceRect(7680, 1440, 3, 0)).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
        expect(sliceRect(7680, 1440, 3, 1)).toEqual({ x: 2560, y: 0, width: 2560, height: 1440 });
        expect(sliceRect(7680, 1440, 3, 2)).toEqual({ x: 5120, y: 0, width: 2560, height: 1440 });
    });

    it('5120x1440 / 2: two 2560x1440 halves', () => {
        expect(sliceRect(5120, 1440, 2, 0)).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
        expect(sliceRect(5120, 1440, 2, 1)).toEqual({ x: 2560, y: 0, width: 2560, height: 1440 });
    });

    it('tiles the frame with no gap or overlap, on even coordinates, for awkward widths too', () => {
        for (const [w, h, n] of [[7680, 1440, 3], [5760, 1080, 3], [7682, 1440, 3], [10240, 1440, 4], [5121, 1441, 2], [3441, 1440, 3]] as const) {
            let cursor = 0;
            for (let i = 0; i < n; i++) {
                const r = sliceRect(w, h, n, i);
                expect(r.x).toBe(cursor);
                expect(r.x % 2).toBe(0);
                expect(r.width % 2).toBe(0);
                expect(r.height % 2).toBe(0);
                expect(r.y).toBe(0);
                expect(r.height).toBeLessThanOrEqual(h);
                cursor = r.x + r.width;
            }
            expect(cursor).toBe(w - (w % 2));
        }
    });

    it('clamps out-of-range index/count instead of throwing', () => {
        expect(sliceRect(7680, 1440, 3, 9)).toEqual(sliceRect(7680, 1440, 3, 2));
        expect(sliceRect(7680, 1440, 3, -4)).toEqual(sliceRect(7680, 1440, 3, 0));
        expect(sliceRect(7680, 1440, 1, 0)).toEqual({ x: 0, y: 0, width: 7680, height: 1440 });
        expect(sliceRect(7680, 1440, 99, 0).width).toBeGreaterThan(0);
    });
});

describe('parseLayout (untrusted worker / stored values)', () => {
    it('accepts well-formed layouts', () => {
        expect(parseLayout({ kind: 'whole' })).toEqual(WHOLE_LAYOUT);
        expect(parseLayout({ kind: 'slice', count: 3, index: 2 })).toEqual({ kind: 'slice', count: 3, index: 2 });
    });
    it.each([
        [null], [undefined], ['slice'], [{}], [{ kind: 'slice' }], [{ kind: 'slice', count: 3 }],
        [{ kind: 'slice', count: 3, index: 3 }], [{ kind: 'slice', count: 1, index: 0 }],
        [{ kind: 'slice', count: 9, index: 0 }], [{ kind: 'slice', count: 3, index: -1 }],
        [{ kind: 'slice', count: 3.5, index: 1 }], [{ kind: 'slice', count: '3', index: 1 }], [{ kind: 'crop' }],
    ])('rejects %j', (v) => {
        expect(parseLayout(v)).toBeNull();
    });
});
