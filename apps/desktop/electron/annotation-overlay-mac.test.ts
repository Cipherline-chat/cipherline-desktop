/**
 * macOS geometry for the desktop annotation overlay, over realistic
 * multi-display / Retina layouts the test Mac mini (one 1080p display at
 * scale 1) cannot reproduce. What the code relies on, and what this suite
 * pins (see the "Coordinate model (macOS)" note in annotation-overlay-target.ts):
 *
 *   - CG window bounds (window_geometry_mac.mm getWindowInfo), Electron
 *     Display.bounds and BrowserWindow bounds are ONE space on macOS: global
 *     points, origin at the primary display's top-left, y down. Measured on
 *     the Mac mini (2026-10-08, macOS 27): getWindowInfo(frame) ===
 *     BrowserWindow.getBounds() of the shared window, and a window share's
 *     captured frame is frame x scaleFactor pixels.
 *   - So the mac path does no unit conversion at all; the only scale factor
 *     in play is the overlay canvas's backing store (devicePixelRatio).
 *
 * Every layout below goes through the real functions the overlay uses
 * (resolveCapturedDisplay, overlayCanvasLayout, macOverlayBounds,
 * windowOverlayPlacement, renderedScreenPoint) and checks the one contract
 * that matters: a stroke at normalized (nx, ny) of the CAPTURED frame lands
 * on the screen point that frame pixel came from.
 */
import { describe, it, expect } from 'vitest';
import {
    resolveCapturedDisplay, cleanWindowInfo, windowOverlayPlacement, windowOverlayBackend,
    macOverlayBounds, sameRect, parseWindowSourceHandle, type DisplayCandidate, type Rect,
} from './annotation-overlay-target';
import { overlayCanvasLayout, renderedScreenPoint, projectToScreen, backingStoreSize } from './annotation-overlay-projection';

/** A display as Electron reports it on macOS (id = CGDirectDisplayID). */
interface MacDisplay { id: number; bounds: Rect; workArea: Rect; scaleFactor: number }

// MacBook Pro 14" (notch): 1512x982 pt at 2x, menu bar 37 pt (taller than the
// notch). Primary, so it defines the origin.
const BUILTIN: MacDisplay = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 }, scaleFactor: 2 };
// 1x 1080p external arranged to the LEFT, bottom edges aligned → negative x AND y.
const LEFT_1X: MacDisplay = { id: 69733382, bounds: { x: -1920, y: -98, width: 1920, height: 1080 }, workArea: { x: -1920, y: -73, width: 1920, height: 1055 }, scaleFactor: 1 };
// 2x 5K (2560x1440 pt) arranged ABOVE the built-in, off-centre → negative y.
const ABOVE_2X: MacDisplay = { id: 724062285, bounds: { x: -524, y: -1440, width: 2560, height: 1440 }, workArea: { x: -524, y: -1415, width: 2560, height: 1415 }, scaleFactor: 2 };
// 1.5x-ish scaled 4K at "looks like 2560x1440" is still reported as 2x by
// macOS (it renders at 2x and downsamples), but a third-party 1.75 / 1.33
// HiDPI mode can surface as a non-integer factor: cover one.
const RIGHT_ODD: MacDisplay = { id: 4128835, bounds: { x: 1512, y: 0, width: 1728, height: 1117 }, workArea: { x: 1512, y: 25, width: 1728, height: 1092 }, scaleFactor: 1.75 };

const DESK: MacDisplay[] = [LEFT_1X, BUILTIN, ABOVE_2X, RIGHT_ODD];
/** macOS never has a physical rect (Windows-only signal). */
const candidates = (list: MacDisplay[]): DisplayCandidate[] => list.map(d => ({ id: d.id, bounds: d.bounds, physical: null }));
const SAMPLES: Array<[number, number]> = [[0, 0], [1, 1], [0.5, 0.5], [0.25, 0.75], [0.999, 0.001]];

describe('macOS screen shares: which display', () => {
    it('display_id (the CGDirectDisplayID Chromium fills on macOS) picks each display, whatever the list order', () => {
        for (const order of [DESK, [...DESK].reverse(), [ABOVE_2X, RIGHT_ODD, BUILTIN, LEFT_1X]]) {
            for (const d of DESK) {
                expect(resolveCapturedDisplay({ displayId: String(d.id), displays: candidates(order), monitorRect: null }))
                    .toEqual({ id: d.id, how: 'display-id' });
            }
        }
    });
    it('no display_id on a multi-display Mac: refused (null), never a guess', () => {
        expect(resolveCapturedDisplay({ displayId: '', displays: candidates(DESK), monitorRect: null })).toBeNull();
    });
    it('a single display needs no id', () => {
        expect(resolveCapturedDisplay({ displayId: '', displays: candidates([BUILTIN]), monitorRect: null })).toEqual({ id: 1, how: 'only-display' });
    });
});

describe('macOS screen shares: strokes land on the captured pixel', () => {
    it('window exactly on the display: every display, every scale (negative origins included)', () => {
        for (const d of DESK) {
            const layout = overlayCanvasLayout(d.bounds, d.bounds);
            expect(layout).toEqual({ cssLeft: 0, cssTop: 0, cssWidth: d.bounds.width, cssHeight: d.bounds.height });
            for (const [nx, ny] of SAMPLES) {
                const got = renderedScreenPoint(nx, ny, layout, d.bounds, d.scaleFactor);
                const want = projectToScreen(nx, ny, d.bounds);
                expect(got.x).toBeCloseTo(want.x, 6);
                expect(got.y).toBeCloseTo(want.y, 6);
            }
        }
    });

    it('macOS pushed the overlay below the menu bar / notch: the canvas shifts back up instead of rescaling', () => {
        // The captured frame of a screen share includes the menu bar. If the
        // window server constrains our window to the work area, the client box
        // starts 37 pt (notch) / 25 pt (plain menu bar) lower and is shorter.
        for (const d of DESK) {
            const content: Rect = { ...d.workArea };
            const layout = overlayCanvasLayout(d.bounds, content);
            expect(layout.cssTop).toBe(d.bounds.y - d.workArea.y);
            expect(layout.cssHeight).toBe(d.bounds.height);
            for (const [nx, ny] of SAMPLES) {
                const got = renderedScreenPoint(nx, ny, layout, content, d.scaleFactor);
                const want = projectToScreen(nx, ny, d.bounds);
                expect(got.x).toBeCloseTo(want.x, 6);
                expect(got.y).toBeCloseTo(want.y, 6);
            }
        }
    });

    it('POSITIVE CONTROL: laying out against the work area (the old innerHeight rule) is off by the menu bar at the top edge', () => {
        // Scaled into the 945 pt box, a point drifts by 37 pt at the top, half
        // that mid-screen and zero at the bottom — this suite would catch it.
        const d = BUILTIN;
        const wrong = overlayCanvasLayout(d.workArea, d.workArea);
        const err = (ny: number) => renderedScreenPoint(0.5, ny, wrong, d.workArea, d.scaleFactor).y - projectToScreen(0.5, ny, d.bounds).y;
        expect(err(0)).toBeCloseTo(37, 6);
        expect(err(0.5)).toBeCloseTo(18.5, 6);
        expect(err(1)).toBeCloseTo(0, 6);
    });

    it('the backing store follows the display scale (Retina 2x crisp, 1x external not oversized)', () => {
        expect(backingStoreSize(BUILTIN.bounds.width, BUILTIN.bounds.height, 2)).toEqual({ width: 3024, height: 1964 });
        expect(backingStoreSize(LEFT_1X.bounds.width, LEFT_1X.bounds.height, 1)).toEqual({ width: 1920, height: 1080 });
        expect(backingStoreSize(RIGHT_ODD.bounds.width, RIGHT_ODD.bounds.height, 1.75)).toEqual({ width: 3024, height: 1955 });
    });
});

/**
 * A window share's captured frame is the window's CG frame at the scale of
 * the display it is on: frame.width * scale pixels wide. A stroke at
 * normalized nx therefore belongs at pixel nx * frame.width * scale, which
 * came from screen point frame.x + nx * frame.width.
 */
function capturedPixelToScreen(nx: number, ny: number, frame: Rect, scale: number): { x: number; y: number } {
    const px = nx * frame.width * scale, py = ny * frame.height * scale;
    return { x: frame.x + px / scale, y: frame.y + py / scale };
}

describe('macOS window shares: overlay bounds and stroke placement', () => {
    const frames: Array<[string, Rect, number]> = [
        ['Retina built-in, below the notch', { x: 100, y: 38, width: 1200, height: 800 }, 2],
        ['1x external on the left (negative x and y)', { x: -1700, y: -60, width: 1280, height: 900 }, 1],
        ['2x display above (negative y)', { x: -300, y: -1300, width: 1600, height: 1000 }, 2],
        ['odd-scale display on the right', { x: 1700, y: 120, width: 900, height: 700 }, 1.75],
        ['straddling built-in and the left external', { x: -400, y: 100, width: 900, height: 600 }, 2],
    ];

    for (const [name, frame, scale] of frames) {
        it(`${name}: overlay window = CG frame, strokes on the captured pixel`, () => {
            const placement = windowOverlayPlacement(cleanWindowInfo({ exists: true, visible: true, minimized: false, cloaked: false, frame }));
            expect(placement).toEqual({ action: 'show', rect: frame });
            const bounds = macOverlayBounds(frame);
            expect(bounds).toEqual(frame);          // no conversion of any kind
            // A frameless window's content box is its bounds.
            const layout = overlayCanvasLayout(bounds, bounds);
            for (const [nx, ny] of SAMPLES) {
                const got = renderedScreenPoint(nx, ny, layout, bounds, scale);
                const want = capturedPixelToScreen(nx, ny, frame, scale);
                expect(got.x).toBeCloseTo(want.x, 6);
                expect(got.y).toBeCloseTo(want.y, 6);
            }
        });
    }

    it('POSITIVE CONTROL: treating CG points as Retina pixels (dividing by 2) puts strokes in the wrong place', () => {
        const frame = frames[0][1];
        const wrong: Rect = { x: frame.x / 2, y: frame.y / 2, width: frame.width / 2, height: frame.height / 2 };
        const got = renderedScreenPoint(1, 1, overlayCanvasLayout(wrong, wrong), wrong, 2);
        const want = capturedPixelToScreen(1, 1, frame, 2);
        expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeGreaterThan(100);
    });

    it('POSITIVE CONTROL: a Cocoa bottom-left flip of a window above the primary lands it on the wrong display', () => {
        const frame = frames[2][1];
        const primaryHeight = BUILTIN.bounds.height;
        const flipped: Rect = { ...frame, y: primaryHeight - (frame.y + frame.height) };
        expect(flipped.y).toBeGreaterThan(0);          // would be on/below the built-in, not above it
        expect(sameRect(macOverlayBounds(frame), flipped)).toBe(false);
    });

    it('fractional CG frames round per edge, never shrinking a side by more than half a point', () => {
        const f: Rect = { x: -100.4, y: 20.6, width: 300.3, height: 200.2 };
        const b = macOverlayBounds(f);
        expect(b).toEqual({ x: -100, y: 21, width: 300, height: 200 });
        expect(Math.abs(b.x - f.x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs((b.x + b.width) - (f.x + f.width))).toBeLessThanOrEqual(0.5);
        expect(Math.abs((b.y + b.height) - (f.y + f.height))).toBeLessThanOrEqual(0.5);
        expect(macOverlayBounds({ x: 0, y: 0, width: 0.2, height: 0.2 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    });

    it('not on screen (minimized / other Space / app hidden) hides; gone closes', () => {
        const frame = frames[0][1];
        expect(windowOverlayPlacement(cleanWindowInfo({ exists: true, visible: false, minimized: false, cloaked: false, frame })).action).toBe('hide');
        expect(windowOverlayPlacement(cleanWindowInfo({ exists: false })).action).toBe('close');
    });

    it('source ids: window:<CGWindowID>:0 parses to the CGWindowID', () => {
        expect(parseWindowSourceHandle('window:1087:0')).toBe('1087');
        expect(parseWindowSourceHandle('window:-4:-1')).toBeNull();   // Electron's system-picker magic id
        expect(parseWindowSourceHandle('window:0:0')).toBeNull();
    });
});

describe('windowOverlayBackend (which native path drives a window share)', () => {
    const fn = () => undefined;
    it('Windows needs getWindowInfo + placeOverlayAbove', () => {
        expect(windowOverlayBackend('win32', { getWindowInfo: fn, placeOverlayAbove: fn })).toBe('win');
        expect(windowOverlayBackend('win32', { getWindowInfo: fn, orderOverlayAbove: fn })).toBeNull();
    });
    it('macOS needs getWindowInfo + orderOverlayAbove', () => {
        expect(windowOverlayBackend('darwin', { getWindowInfo: fn, orderOverlayAbove: fn })).toBe('mac');
        expect(windowOverlayBackend('darwin', { getWindowInfo: fn, placeOverlayAbove: fn })).toBeNull();
    });
    it('no addon, an old addon, or Linux: none', () => {
        expect(windowOverlayBackend('darwin', null)).toBeNull();
        expect(windowOverlayBackend('darwin', { orderOverlayAbove: fn })).toBeNull();
        expect(windowOverlayBackend('linux', { getWindowInfo: fn, placeOverlayAbove: fn, orderOverlayAbove: fn })).toBeNull();
    });
});
