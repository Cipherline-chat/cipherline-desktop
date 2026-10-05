import { describe, it, expect } from 'vitest';

/**
 * Crop geometry — the pure half of imageCrop.ts.
 *
 * `renderCroppedBlob`/`loadImageElement` need a real canvas and are left to
 * manual verification (vitest runs in `environment: 'node'`), but the maths
 * they depend on is exercised here. The invariant that actually matters for
 * users is the clamp: if it is ever wrong the image can be dragged off the
 * frame and the export silently encodes blank edges.
 */
import {
    coverScale, clampCrop, zoomAbout, IDENTITY_CROP, MAX_ZOOM,
    AVATAR_OUTPUT, BANNER_OUTPUT,
} from './imageCrop';

const FRAME = { w: 300, h: 300 };
const BANNER_FRAME = { w: 420, h: 168 };

describe('coverScale', () => {
    it('scales the tight axis to fill for a landscape source', () => {
        // 1000x500 into 300x300: height is the tight axis → 300/500.
        expect(coverScale(1000, 500, 300, 300)).toBeCloseTo(0.6);
    });

    it('scales the tight axis to fill for a portrait source', () => {
        expect(coverScale(500, 1000, 300, 300)).toBeCloseTo(0.6);
    });

    it('covers rather than fits — the result never leaves a gutter', () => {
        const s = coverScale(1000, 500, 420, 168);
        expect(1000 * s).toBeGreaterThanOrEqual(420 - 1e-9);
        expect(500 * s).toBeGreaterThanOrEqual(168 - 1e-9);
    });

    it('falls back to 1 for a degenerate image rather than dividing by zero', () => {
        expect(coverScale(0, 0, 300, 300)).toBe(1);
    });
});

describe('clampCrop', () => {
    it('pins a fully zoomed-out image to centre on both axes when it exactly covers', () => {
        // Square source into a square frame at scale 1: no slack anywhere.
        // toBeCloseTo, not toBe: clamping a negative pan to a zero-width range
        // yields -0, which is arithmetically identical to 0 everywhere it is
        // used (and renders the same in a CSS translate).
        const t = clampCrop({ scale: 1, x: 120, y: -80 }, 800, 800, FRAME.w, FRAME.h);
        expect(t.x).toBeCloseTo(0);
        expect(t.y).toBeCloseTo(0);
    });

    it('allows panning only along the loose axis of a wide image', () => {
        // 1000x500 into 300x300 at scale 1 → displayed 600x300. Slack is
        // (600-300)/2 = 150 horizontally, 0 vertically.
        const t = clampCrop({ scale: 1, x: 999, y: 999 }, 1000, 500, FRAME.w, FRAME.h);
        expect(t.x).toBeCloseTo(150);
        expect(t.y).toBe(0);
    });

    it('clamps symmetrically in the negative direction', () => {
        const t = clampCrop({ scale: 1, x: -999, y: 0 }, 1000, 500, FRAME.w, FRAME.h);
        expect(t.x).toBeCloseTo(-150);
    });

    it('leaves an in-range pan untouched', () => {
        const t = clampCrop({ scale: 1, x: 40, y: 0 }, 1000, 500, FRAME.w, FRAME.h);
        expect(t.x).toBeCloseTo(40);
    });

    it('grows the pan range as the user zooms in', () => {
        const atOne = clampCrop({ scale: 1, x: 1e6, y: 1e6 }, 800, 800, FRAME.w, FRAME.h);
        const atTwo = clampCrop({ scale: 2, x: 1e6, y: 1e6 }, 800, 800, FRAME.w, FRAME.h);
        expect(atOne.y).toBe(0);
        // At 2x a square source has (600-300)/2 = 150 of slack on each axis.
        expect(atTwo.y).toBeCloseTo(150);
    });

    it('holds the zoom floor at 1 so the image can never uncover the frame', () => {
        expect(clampCrop({ scale: 0.2, x: 0, y: 0 }, 800, 800, FRAME.w, FRAME.h).scale).toBe(1);
        expect(clampCrop({ scale: -5, x: 0, y: 0 }, 800, 800, FRAME.w, FRAME.h).scale).toBe(1);
    });

    it('holds the zoom ceiling at MAX_ZOOM', () => {
        expect(clampCrop({ scale: 99, x: 0, y: 0 }, 800, 800, FRAME.w, FRAME.h).scale).toBe(MAX_ZOOM);
    });

    it('keeps a banner frame covered for an awkwardly tall source', () => {
        // 400x3000 into 420x168 — the pathological case the old centre-crop
        // handled by luck. Vertical slack should be large, horizontal zero.
        const t = clampCrop({ scale: 1, x: 500, y: 5000 }, 400, 3000, BANNER_FRAME.w, BANNER_FRAME.h);
        expect(t.x).toBe(0);
        expect(t.y).toBeGreaterThan(0);
    });
});

describe('zoomAbout', () => {
    it('keeps the frame centre fixed when zooming about the centre', () => {
        const t = zoomAbout(IDENTITY_CROP, 2, 0, 0, 800, 800, FRAME.w, FRAME.h);
        expect(t.scale).toBe(2);
        expect(t.x).toBe(0);
        expect(t.y).toBe(0);
    });

    it('pushes content away from an off-centre anchor as it zooms in', () => {
        // Anchoring right of centre on a wide image must pan left so the
        // detail under the cursor stays put.
        const t = zoomAbout(IDENTITY_CROP, 2, 100, 0, 1000, 500, FRAME.w, FRAME.h);
        expect(t.x).toBeLessThan(0);
    });

    it('never returns an unclamped transform', () => {
        // Anchor far outside the frame at max zoom: still inside the pan range.
        const t = zoomAbout(IDENTITY_CROP, MAX_ZOOM, 9999, 9999, 800, 800, FRAME.w, FRAME.h);
        const slack = (800 * coverScale(800, 800, 300, 300) * MAX_ZOOM - 300) / 2;
        expect(Math.abs(t.x)).toBeLessThanOrEqual(slack + 1e-6);
        expect(Math.abs(t.y)).toBeLessThanOrEqual(slack + 1e-6);
    });

    it('round-trips back to centred when zooming out to 1', () => {
        const zoomed = zoomAbout(IDENTITY_CROP, 3, 60, 40, 800, 800, FRAME.w, FRAME.h);
        const back = zoomAbout(zoomed, 1, 60, 40, 800, 800, FRAME.w, FRAME.h);
        expect(back.scale).toBe(1);
        // Scale 1 has zero slack for a square source, so the clamp re-centres.
        expect(back.x).toBeCloseTo(0);
        expect(back.y).toBeCloseTo(0);
    });
});

describe('output presets', () => {
    it('keeps avatars square so the circular display crop is symmetric', () => {
        expect(AVATAR_OUTPUT.width).toBe(AVATAR_OUTPUT.height);
    });

    it('keeps the banner at the 2.5:1 the display surfaces expect', () => {
        expect(BANNER_OUTPUT.width / BANNER_OUTPUT.height).toBeCloseTo(2.5);
    });

    it('matches the cropper frame aspect to the output aspect', () => {
        // The cropper derives frame height from the output ratio; if these
        // disagreed the preview would lie about the saved result.
        const frameH = Math.round(BANNER_FRAME.w / (BANNER_OUTPUT.width / BANNER_OUTPUT.height));
        expect(frameH).toBe(BANNER_FRAME.h);
    });
});
