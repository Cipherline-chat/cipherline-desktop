/**
 * The overlay's coordinate contract.
 *
 * A real overlay cannot run here: `showAnnotationOverlay` returns false on
 * Linux by design (no way to exclude the window from capture), and this dev
 * box is headless besides. So the mapping is proved as maths — which is
 * where the bug lived anyway.
 */
import { describe, it, expect } from 'vitest';
import {
    MAX_BACKING_SCALE,
    backingStoreSize,
    effectiveBackingScale,
    overlayCanvasLayout,
    projectToScreen,
    renderedScreenPoint,
    type Rect,
} from './annotation-overlay-projection';

/** 1080p primary, taskbar at the bottom. */
const DISPLAY_1080: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
/** What a bottom-docked 48px taskbar leaves as the work area. */
const WORK_AREA_1080: Rect = { x: 0, y: 0, width: 1920, height: 1032 };
/** A second monitor placed to the LEFT of and ABOVE the primary. */
const DISPLAY_NEGATIVE: Rect = { x: -1920, y: -240, width: 1920, height: 1080 };

describe('the regression: projecting against the window instead of the capture', () => {
    // This is the OLD behaviour, reproduced explicitly so the numbers in the
    // fix's commit message are checked by CI rather than asserted in prose.
    const oldProjection = (ny: number, windowContent: Rect) =>
        windowContent.y + ny * windowContent.height;

    it('put a stroke 24px high at mid-screen and 48px high at the bottom', () => {
        expect(oldProjection(0.0, WORK_AREA_1080)).toBe(0);      // correct: 0
        expect(oldProjection(0.5, WORK_AREA_1080)).toBe(516);    // should be 540
        expect(oldProjection(1.0, WORK_AREA_1080)).toBe(1032);   // should be 1080

        // The error is zero at the top and grows toward the bottom — the
        // shape the owner described as "a little offset ... a little high".
        expect(projectToScreen(0.5, 0.5, DISPLAY_1080).y - oldProjection(0.5, WORK_AREA_1080)).toBe(24);
        expect(projectToScreen(0.5, 1.0, DISPLAY_1080).y - oldProjection(1.0, WORK_AREA_1080)).toBe(48);
    });

    it('left x alone, which is why the report said "vertically"', () => {
        // A bottom-docked taskbar costs height only, so the horizontal
        // mapping was already correct. Nothing to fix there — but if the
        // taskbar were docked left/right the same bug would show up in x.
        expect(WORK_AREA_1080.width).toBe(DISPLAY_1080.width);
    });
});

describe('overlayCanvasLayout', () => {
    it('sizes the canvas by the capture, not by the window', () => {
        const layout = overlayCanvasLayout(DISPLAY_1080, WORK_AREA_1080);
        expect(layout.cssWidth).toBe(1920);
        expect(layout.cssHeight).toBe(1080);   // NOT 1032
    });

    it('is a no-op offset when the window got exactly what it asked for', () => {
        const layout = overlayCanvasLayout(DISPLAY_1080, DISPLAY_1080);
        expect(layout).toEqual({ cssLeft: 0, cssTop: 0, cssWidth: 1920, cssHeight: 1080 });
    });

    it('shifts the canvas back when the compositor moved the window', () => {
        // Window pushed down by the taskbar's height instead of shrunk.
        const shifted: Rect = { x: 0, y: 48, width: 1920, height: 1032 };
        const layout = overlayCanvasLayout(DISPLAY_1080, shifted);
        expect(layout.cssTop).toBe(-48);
    });

    it('handles a display at a negative origin', () => {
        const layout = overlayCanvasLayout(DISPLAY_NEGATIVE, DISPLAY_NEGATIVE);
        expect(layout).toEqual({ cssLeft: 0, cssTop: 0, cssWidth: 1920, cssHeight: 1080 });
    });
});

describe('the contract: rendered position == intended position', () => {
    const cases: Array<{ name: string; capture: Rect; windowContent: Rect }> = [
        { name: 'primary, window exact', capture: DISPLAY_1080, windowContent: DISPLAY_1080 },
        { name: 'primary, window clamped to the work area (the bug)', capture: DISPLAY_1080, windowContent: WORK_AREA_1080 },
        { name: 'primary, window shifted down by the taskbar', capture: DISPLAY_1080, windowContent: { x: 0, y: 48, width: 1920, height: 1032 } },
        { name: 'negative-origin display, window exact', capture: DISPLAY_NEGATIVE, windowContent: DISPLAY_NEGATIVE },
        { name: 'negative-origin display, window clamped', capture: DISPLAY_NEGATIVE, windowContent: { x: -1920, y: -240, width: 1920, height: 1032 } },
    ];
    const dprs = [1.0, 1.5, 2.0, 3.0];
    const points: Array<[number, number]> = [[0, 0], [0.5, 0], [0.5, 0.5], [0.5, 1], [1, 1], [0.25, 0.75]];

    for (const c of cases) {
        for (const dpr of dprs) {
            it(`${c.name} @ scaleFactor ${dpr}`, () => {
                const layout = overlayCanvasLayout(c.capture, c.windowContent);
                for (const [nx, ny] of points) {
                    const want = projectToScreen(nx, ny, c.capture);
                    const got = renderedScreenPoint(nx, ny, layout, c.windowContent, dpr);
                    expect(got.x).toBeCloseTo(want.x, 9);
                    expect(got.y).toBeCloseTo(want.y, 9);
                }
            });
        }
    }

    it('lands (0.5, 0.0) and (0.5, 1.0) on the true top and bottom of a taskbar-clamped display', () => {
        const layout = overlayCanvasLayout(DISPLAY_1080, WORK_AREA_1080);
        expect(renderedScreenPoint(0.5, 0.0, layout, WORK_AREA_1080, 1)).toEqual({ x: 960, y: 0 });
        expect(renderedScreenPoint(0.5, 1.0, layout, WORK_AREA_1080, 1)).toEqual({ x: 960, y: 1080 });
    });
});

describe('backing store', () => {
    it('clamps DPR so a 4K display does not allocate an enormous surface', () => {
        expect(effectiveBackingScale(3)).toBe(MAX_BACKING_SCALE);
        expect(effectiveBackingScale(1.5)).toBe(1.5);
        expect(effectiveBackingScale(1)).toBe(1);
    });

    it('falls back to 1 for a nonsense devicePixelRatio', () => {
        expect(effectiveBackingScale(0)).toBe(1);
        expect(effectiveBackingScale(NaN)).toBe(1);
        expect(effectiveBackingScale(-2)).toBe(1);
        // Infinity is nonsense too, so it takes the same 1x floor rather than
        // the 2x ceiling. This is a DELIBERATE divergence from the preload's
        // `Math.min(MAX, dpr || 1)`, which would answer 2 — no real display
        // reports an infinite DPR, and the floor is the safer answer for a
        // value we already know is garbage.
        expect(effectiveBackingScale(Number.POSITIVE_INFINITY)).toBe(1);
    });

    it('is sized from the capture rect', () => {
        expect(backingStoreSize(1920, 1080, 1.5)).toEqual({ width: 2880, height: 1620 });
        expect(backingStoreSize(1920, 1080, 3)).toEqual({ width: 3840, height: 2160 });
    });

    it('never produces a zero-sized surface', () => {
        expect(backingStoreSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
    });

    it('keeps the mapping exact even when rounding changes the backing size', () => {
        // An odd CSS width at 1.5x rounds; the canvas still maps its backing
        // store onto the full CSS box, so the identity must survive.
        const capture: Rect = { x: 0, y: 0, width: 1367, height: 769 };
        const layout = overlayCanvasLayout(capture, capture);
        const got = renderedScreenPoint(1, 1, layout, capture, 1.5);
        expect(got.x).toBeCloseTo(1367, 9);
        expect(got.y).toBeCloseTo(769, 9);
    });
});
