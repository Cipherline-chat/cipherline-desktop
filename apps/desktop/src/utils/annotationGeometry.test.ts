import { describe, it, expect } from 'vitest';
import {
    contentRect, toNormalized, toElement, toCanvas,
    isInsideContent, clampUnit, isValidWirePoint,
} from './annotationGeometry';

// Phase 0 coordinate-mapping prototype (docs/video-annotation-design.md).
// The property that matters: the SAME normalized point must hit the SAME
// content pixel at every tile size, every fit mode, every DPR, in fullscreen.

const HD = { width: 1920, height: 1080 };   // a 16:9 camera / share
const TALL = { width: 1080, height: 1920 }; // a phone camera

describe('contentRect — contain (letterboxed)', () => {
    it('letterboxes top/bottom when the box is taller than the frame', () => {
        const r = contentRect({ width: 800, height: 800 }, HD, 'contain')!;
        expect(r.width).toBe(800);
        expect(r.height).toBeCloseTo(450);
        expect(r.x).toBe(0);
        expect(r.y).toBeCloseTo(175);
    });
    it('letterboxes left/right when the box is wider than the frame', () => {
        const r = contentRect({ width: 1600, height: 450 }, HD, 'contain')!;
        expect(r.height).toBe(450);
        expect(r.width).toBeCloseTo(800);
        expect(r.x).toBeCloseTo(400);
        expect(r.y).toBe(0);
    });
    it('fills the box exactly when aspect ratios match', () => {
        const r = contentRect({ width: 960, height: 540 }, HD, 'contain')!;
        expect(r).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    });
    it('handles a portrait frame in a landscape box', () => {
        const r = contentRect({ width: 1600, height: 900 }, TALL, 'contain')!;
        expect(r.height).toBe(900);
        expect(r.width).toBeCloseTo(506.25);
        expect(r.x).toBeCloseTo((1600 - 506.25) / 2);
    });
});

describe('contentRect — cover (cropped)', () => {
    it('overflows the box on the axis that would otherwise letterbox', () => {
        const r = contentRect({ width: 800, height: 800 }, HD, 'cover')!;
        expect(r.height).toBe(800);
        expect(r.width).toBeCloseTo(1422.22, 1);
        expect(r.x).toBeLessThan(0); // cropped left/right
        expect(r.y).toBe(0);
    });
});

describe('contentRect — degenerate inputs', () => {
    it('is null before video metadata (0×0 intrinsic) — never draw on nothing', () => {
        expect(contentRect({ width: 800, height: 450 }, { width: 0, height: 0 }, 'contain')).toBeNull();
    });
    it('is null for a collapsed element box', () => {
        expect(contentRect({ width: 0, height: 450 }, HD, 'contain')).toBeNull();
    });
});

describe('the invariant: same normalized point → same content pixel everywhere', () => {
    const sizes = [
        { width: 320, height: 240 },    // small tile, letterboxed T/B
        { width: 1600, height: 450 },   // wide strip, letterboxed L/R
        { width: 1920, height: 1080 },  // fullscreen, exact fit
        { width: 2560, height: 1440 },  // fullscreen on a bigger monitor
    ];
    const samples = [{ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.75 }, { x: 0, y: 0 }, { x: 1, y: 1 }];

    it('(0.5, 0.5) is the exact centre of the painted frame at every size', () => {
        for (const box of sizes) {
            const r = contentRect(box, HD, 'contain')!;
            const el = toElement({ x: 0.5, y: 0.5 }, r);
            expect(el.x).toBeCloseTo(r.x + r.width / 2);
            expect(el.y).toBeCloseTo(r.y + r.height / 2);
            // …which for a centred fit is also the centre of the element itself.
            expect(el.x).toBeCloseTo(box.width / 2);
            expect(el.y).toBeCloseTo(box.height / 2);
        }
    });

    it('maps to the same INTRINSIC pixel at every size (the cross-client property)', () => {
        for (const p of samples) {
            const pixels = sizes.map(box => {
                const r = contentRect(box, HD, 'contain')!;
                const el = toElement(p, r);
                // back to intrinsic pixels: how far into the painted frame, scaled up
                return {
                    px: ((el.x - r.x) / r.width) * HD.width,
                    py: ((el.y - r.y) / r.height) * HD.height,
                };
            });
            for (const q of pixels) {
                expect(q.px).toBeCloseTo(pixels[0].px, 6);
                expect(q.py).toBeCloseTo(pixels[0].py, 6);
            }
        }
    });

    it('round-trips element ↔ normalized without drift', () => {
        for (const box of sizes) {
            const r = contentRect(box, HD, 'contain')!;
            for (const p of samples) {
                const back = toNormalized(toElement(p, r), r);
                expect(back.x).toBeCloseTo(p.x, 9);
                expect(back.y).toBeCloseTo(p.y, 9);
            }
        }
    });

    it('resizing mid-stroke changes nothing about the stored point', () => {
        const p = { x: 0.3, y: 0.6 };
        const before = contentRect({ width: 640, height: 360 }, HD, 'contain')!;
        const after = contentRect({ width: 1280, height: 720 }, HD, 'contain')!;
        const a = toElement(p, before), b = toElement(p, after);
        expect(b.x / a.x).toBeCloseTo(2);
        expect(b.y / a.y).toBeCloseTo(2);
    });
});

describe('DPR', () => {
    it('scales element px to device px for a canvas sized box × dpr', () => {
        const r = contentRect({ width: 800, height: 450 }, HD, 'contain')!;
        const at1 = toCanvas({ x: 0.5, y: 0.5 }, r, 1);
        const at2 = toCanvas({ x: 0.5, y: 0.5 }, r, 2);
        expect(at2.x).toBeCloseTo(at1.x * 2);
        expect(at2.y).toBeCloseTo(at1.y * 2);
    });
});

describe('letterbox bars and the unit square', () => {
    const r = contentRect({ width: 800, height: 800 }, HD, 'contain')!; // bars top/bottom, y∈[175,625]
    it('a point in the bar normalizes outside [0,1] and is reported as outside', () => {
        const n = toNormalized({ x: 400, y: 50 }, r);
        expect(n.y).toBeLessThan(0);
        expect(isInsideContent(n)).toBe(false);
    });
    it('a point on the frame normalizes inside', () => {
        expect(isInsideContent(toNormalized({ x: 400, y: 400 }, r))).toBe(true);
    });
    it('clampUnit pins a drifting hand to the frame edge', () => {
        expect(clampUnit({ x: 1.4, y: -0.2 })).toEqual({ x: 1, y: 0 });
        expect(clampUnit({ x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 });
    });
});

describe('isValidWirePoint — what a receiver accepts from the network', () => {
    it.each([
        [{ x: 0, y: 0 }, true], [{ x: 1, y: 1 }, true], [{ x: 0.5, y: 0.25 }, true],
        [{ x: 1.0001, y: 0 }, false], [{ x: -0.1, y: 0 }, false],
        [{ x: NaN, y: 0 }, false], [{ x: Infinity, y: 0 }, false],
        [{ x: '0.5', y: 0 }, false], [null, false], [undefined, false], [{ x: 0 }, false], ['0,0', false],
    ])('%j → %s', (input, ok) => {
        expect(isValidWirePoint(input)).toBe(ok);
    });
});
