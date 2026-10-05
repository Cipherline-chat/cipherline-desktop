import { describe, it, expect } from 'vitest';
import { computeCanvasBackingSize } from './canvasSizing';

describe('computeCanvasBackingSize', () => {
    it('scales the CSS box by the device pixel ratio', () => {
        expect(computeCanvasBackingSize(800, 400, 2)).toEqual({ width: 1600, height: 800, dpr: 2 });
    });

    it('at dpr 1 the backing store matches the CSS box 1:1', () => {
        expect(computeCanvasBackingSize(300, 150, 1)).toEqual({ width: 300, height: 150, dpr: 1 });
    });

    it('rounds a fractional CSS size rather than truncating it (sub-pixel layout at DPR > 1)', () => {
        // 833.3 * 2 = 1666.6 -> should round to 1667, not floor to 1666.
        const { width } = computeCanvasBackingSize(833.3, 500, 2);
        expect(width).toBe(1667);
    });

    it('falls back to dpr 1 for a non-finite devicePixelRatio', () => {
        expect(computeCanvasBackingSize(100, 100, NaN)).toEqual({ width: 100, height: 100, dpr: 1 });
        expect(computeCanvasBackingSize(100, 100, Infinity)).toEqual({ width: 100, height: 100, dpr: 1 });
    });

    it('falls back to dpr 1 for a zero or negative devicePixelRatio', () => {
        expect(computeCanvasBackingSize(100, 100, 0)).toEqual({ width: 100, height: 100, dpr: 1 });
        expect(computeCanvasBackingSize(100, 100, -2)).toEqual({ width: 100, height: 100, dpr: 1 });
    });

    it('THE 300x150 BUG — a canvas box that never got laid out (0-size) still yields a usable backing store, not a divide-by-zero 0x0', () => {
        // This is the shape of the actual regression: before the CSS fix,
        // the canvas's *own box* was stuck at the intrinsic 300x150 default
        // (see settings-descent.css's `.sd-motes` comment) rather than 0 —
        // but a 0-size container is the more dangerous adjacent case (a
        // canvas measured before its parent has been laid out at all), so
        // it's covered here as the sizing function's own floor.
        expect(computeCanvasBackingSize(0, 0, 2)).toEqual({ width: 1, height: 1, dpr: 2 });
    });

    it('treats a negative CSS dimension the same as zero rather than producing a negative backing store', () => {
        expect(computeCanvasBackingSize(-50, 200, 2)).toEqual({ width: 1, height: 400, dpr: 2 });
    });

    it('is a pure function: same inputs always produce equal (deep-equal) output', () => {
        const a = computeCanvasBackingSize(1920, 1080, 1.5);
        const b = computeCanvasBackingSize(1920, 1080, 1.5);
        expect(a).toEqual(b);
    });
});
