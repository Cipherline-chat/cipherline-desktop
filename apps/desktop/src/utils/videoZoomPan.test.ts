import { describe, it, expect } from 'vitest';
import {
    IDENTITY,
    MAX_SCALE,
    MIN_SCALE,
    clampScale,
    clampState,
    fullRect,
    isZoomed,
    panBy,
    wheelZoomFactor,
    zoomAt,
    type Rect,
    type Size,
    type ZoomState,
} from './videoZoomPan';

/** A 1600x900 pane whose content fills it exactly (16:9 camera in a 16:9 box). */
const VIEWPORT: Size = { width: 1600, height: 900 };
const FULL: Rect = fullRect(VIEWPORT);

/** The same pane showing a 4:3 screenshare with object-contain: 1200x900
 *  centred, so 200px of letterbox bar down each side. */
const PILLARBOXED: Rect = { x: 200, y: 0, width: 1200, height: 900 };

/** A 21:9 ultrawide share in the same pane: 1600x686 centred, 107px bars top
 *  and bottom. */
const LETTERBOXED: Rect = { x: 0, y: 107, width: 1600, height: 686 };

/** Where a viewport-space point currently sits in content-local space. */
const toLocal = (s: ZoomState, p: { x: number; y: number }) => ({
    x: (p.x - s.tx) / s.scale,
    y: (p.y - s.ty) / s.scale,
});

/** Where a content-local point currently paints on screen. */
const toScreen = (s: ZoomState, p: { x: number; y: number }) => ({
    x: s.tx + s.scale * p.x,
    y: s.ty + s.scale * p.y,
});

/** The visible viewport, expressed in content-local px. */
const visibleLocalBox = (s: ZoomState, v: Size) => ({
    left: (0 - s.tx) / s.scale,
    top: (0 - s.ty) / s.scale,
    right: (v.width - s.tx) / s.scale,
    bottom: (v.height - s.ty) / s.scale,
});

describe('clampScale', () => {
    it('holds 1x as the floor — never zooms out past the natural fit', () => {
        expect(clampScale(0.2)).toBe(MIN_SCALE);
        expect(clampScale(-3)).toBe(MIN_SCALE);
        expect(clampScale(1)).toBe(1);
    });

    it('caps at MAX_SCALE', () => {
        expect(clampScale(99)).toBe(MAX_SCALE);
        expect(clampScale(MAX_SCALE)).toBe(MAX_SCALE);
    });

    it('survives NaN/Infinity rather than poisoning the transform', () => {
        expect(clampScale(NaN)).toBe(MIN_SCALE);
        expect(clampScale(Infinity)).toBe(MAX_SCALE);
    });
});

describe('scale 1 is exactly the untouched tile', () => {
    it('resolves to a zero translation for content that fills the box', () => {
        expect(clampState({ scale: 1, tx: 0, ty: 0 }, VIEWPORT, FULL)).toEqual({ scale: 1, tx: 0, ty: 0 });
    });

    // The important one: at 1x the browser's own object-fit centring already
    // places the frame. Our transform must reproduce it, i.e. be the identity,
    // for a pillarboxed and a letterboxed frame alike — otherwise focusing a
    // non-16:9 share would visibly nudge the picture before anyone touched it.
    it.each([
        ['pillarboxed 4:3', PILLARBOXED],
        ['letterboxed 21:9', LETTERBOXED],
    ])('resolves to a zero translation for %s content', (_label, content) => {
        const s = clampState({ scale: 1, tx: 0, ty: 0 }, VIEWPORT, content);
        expect(s.scale).toBe(1);
        expect(s.tx).toBeCloseTo(0, 9);
        expect(s.ty).toBeCloseTo(0, 9);
    });

    it('refuses to pan at 1x however hard it is pushed', () => {
        const s = panBy(IDENTITY, -900, 400, VIEWPORT, FULL);
        expect(s).toEqual({ scale: 1, tx: 0, ty: 0 });
    });

    it('zooming back down to 1x resets the pan', () => {
        let s = zoomAt(IDENTITY, { x: 100, y: 100 }, 4, VIEWPORT, FULL);
        s = panBy(s, -400, -300, VIEWPORT, FULL);
        expect(isZoomed(s)).toBe(true);
        expect(s.tx).not.toBeCloseTo(0, 3);

        // Wind all the way back out; the clamp must return the identity.
        s = zoomAt(s, { x: 1300, y: 800 }, 0.001, VIEWPORT, FULL);
        expect(s.scale).toBe(1);
        expect(s.tx).toBeCloseTo(0, 9);
        expect(s.ty).toBeCloseTo(0, 9);
        expect(isZoomed(s)).toBe(false);
    });
});

describe('zoomAt anchors on the cursor', () => {
    it('keeps the content point under the cursor, under the cursor', () => {
        const anchor = { x: 800, y: 450 }; // dead centre — no clamp interference
        const before = toLocal(IDENTITY, anchor);
        const after = zoomAt(IDENTITY, anchor, 2.5, VIEWPORT, FULL);
        expect(toScreen(after, before).x).toBeCloseTo(anchor.x, 6);
        expect(toScreen(after, before).y).toBeCloseTo(anchor.y, 6);
    });

    it('anchors off-centre too, not about the element centre', () => {
        // A centre-anchored implementation passes the test above and fails
        // this one, which is the whole point of asserting it.
        const anchor = { x: 1180, y: 300 };
        let s = zoomAt(IDENTITY, { x: 800, y: 450 }, 3, VIEWPORT, FULL);
        const before = toLocal(s, anchor);
        s = zoomAt(s, anchor, 1.4, VIEWPORT, FULL);
        expect(toScreen(s, before).x).toBeCloseTo(anchor.x, 6);
        expect(toScreen(s, before).y).toBeCloseTo(anchor.y, 6);
    });

    it('holds the anchor across a long chain of small wheel steps', () => {
        const anchor = { x: 640, y: 520 };
        let s = IDENTITY;
        const before = toLocal(s, anchor);
        for (let i = 0; i < 30; i++) s = zoomAt(s, anchor, 1.06, VIEWPORT, FULL);
        expect(s.scale).toBeCloseTo(MAX_SCALE, 6); // 1.06^30 ~= 5.74, so it caps
        const now = toScreen(s, before);
        expect(now.x).toBeCloseTo(anchor.x, 4);
        expect(now.y).toBeCloseTo(anchor.y, 4);
    });

    it('does not drift when zooming in then back out about the same point', () => {
        const anchor = { x: 300, y: 700 };
        let s = zoomAt(IDENTITY, anchor, 3.2, VIEWPORT, FULL);
        s = zoomAt(s, anchor, 1 / 3.2, VIEWPORT, FULL);
        expect(s.scale).toBeCloseTo(1, 9);
        expect(s.tx).toBeCloseTo(0, 6);
        expect(s.ty).toBeCloseTo(0, 6);
    });
});

describe('pan clamping never reveals gutter', () => {
    it('keeps the viewport inside the content when panned hard at 3x', () => {
        let s = zoomAt(IDENTITY, { x: 800, y: 450 }, 3, VIEWPORT, FULL);
        s = panBy(s, 5000, 5000, VIEWPORT, FULL); // shove it far past the corner
        const box = visibleLocalBox(s, VIEWPORT);
        expect(box.left).toBeGreaterThanOrEqual(FULL.x - 1e-6);
        expect(box.top).toBeGreaterThanOrEqual(FULL.y - 1e-6);
        expect(box.right).toBeLessThanOrEqual(FULL.x + FULL.width + 1e-6);
        expect(box.bottom).toBeLessThanOrEqual(FULL.y + FULL.height + 1e-6);
    });

    it('clamps to the CONTENT, not the box, for a pillarboxed share', () => {
        // At 3x the 1200px-wide content is 3600px, so it is pannable; the
        // visible strip must stay inside [200, 1400] in local px and never
        // wander into the 200px side bars.
        let s = zoomAt(IDENTITY, { x: 800, y: 450 }, 3, VIEWPORT, PILLARBOXED);
        for (const [dx, dy] of [[9999, 0], [-9999, 0], [0, 9999], [0, -9999]]) {
            const panned = panBy(s, dx, dy, VIEWPORT, PILLARBOXED);
            const box = visibleLocalBox(panned, VIEWPORT);
            expect(box.left).toBeGreaterThanOrEqual(PILLARBOXED.x - 1e-6);
            expect(box.right).toBeLessThanOrEqual(PILLARBOXED.x + PILLARBOXED.width + 1e-6);
            expect(box.top).toBeGreaterThanOrEqual(PILLARBOXED.y - 1e-6);
            expect(box.bottom).toBeLessThanOrEqual(PILLARBOXED.y + PILLARBOXED.height + 1e-6);
        }
        void s;
    });

    it('pins the short axis centred while it is still narrower than the pane', () => {
        // A 21:9 share at 1.2x: content height 686*1.2 = 823 < 900, so the
        // vertical axis is not yet pannable and must stay centred (bars equal
        // top and bottom) even though the horizontal axis is pannable.
        const s = panBy(
            zoomAt(IDENTITY, { x: 800, y: 450 }, 1.2, VIEWPORT, LETTERBOXED),
            0, 500, VIEWPORT, LETTERBOXED,
        );
        const top = toScreen(s, { x: 0, y: LETTERBOXED.y }).y;
        const bottom = VIEWPORT.height - toScreen(s, { x: 0, y: LETTERBOXED.y + LETTERBOXED.height }).y;
        expect(top).toBeCloseTo(bottom, 6);
        expect(top).toBeGreaterThan(0);
    });

    it('zooming into a letterbox bar still lands on picture, not on bar', () => {
        // Anchor in the very top bar of a 21:9 share and zoom hard. A naive
        // implementation happily parks the viewport in the empty bar.
        let s = IDENTITY;
        for (let i = 0; i < 30; i++) s = zoomAt(s, { x: 800, y: 20 }, 1.2, VIEWPORT, LETTERBOXED);
        const box = visibleLocalBox(s, VIEWPORT);
        expect(box.top).toBeGreaterThanOrEqual(LETTERBOXED.y - 1e-6);
        expect(box.bottom).toBeLessThanOrEqual(LETTERBOXED.y + LETTERBOXED.height + 1e-6);
    });

    it('holds the no-gutter invariant over a randomised gesture walk', () => {
        // Deterministic LCG — no Math.random, so a failure is reproducible.
        let seed = 0x2f6e2b1;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (const content of [FULL, PILLARBOXED, LETTERBOXED]) {
            let s = IDENTITY;
            for (let i = 0; i < 400; i++) {
                if (rnd() < 0.5) {
                    s = zoomAt(
                        s,
                        { x: rnd() * VIEWPORT.width, y: rnd() * VIEWPORT.height },
                        wheelZoomFactor({ deltaY: (rnd() - 0.5) * 600, ctrlKey: rnd() < 0.3 }),
                        VIEWPORT, content,
                    );
                } else {
                    s = panBy(s, (rnd() - 0.5) * 1200, (rnd() - 0.5) * 1200, VIEWPORT, content);
                }
                expect(s.scale).toBeGreaterThanOrEqual(MIN_SCALE);
                expect(s.scale).toBeLessThanOrEqual(MAX_SCALE);
                const box = visibleLocalBox(s, VIEWPORT);
                // Either the axis is filled with content edge-to-edge, or the
                // content is centred because it is too small to fill it.
                const wideEnough = s.scale * content.width >= VIEWPORT.width - 1e-6;
                if (wideEnough) {
                    expect(box.left).toBeGreaterThanOrEqual(content.x - 1e-6);
                    expect(box.right).toBeLessThanOrEqual(content.x + content.width + 1e-6);
                } else {
                    const l = toScreen(s, { x: content.x, y: 0 }).x;
                    const r = VIEWPORT.width - toScreen(s, { x: content.x + content.width, y: 0 }).x;
                    expect(l).toBeCloseTo(r, 6);
                }
                const tallEnough = s.scale * content.height >= VIEWPORT.height - 1e-6;
                if (tallEnough) {
                    expect(box.top).toBeGreaterThanOrEqual(content.y - 1e-6);
                    expect(box.bottom).toBeLessThanOrEqual(content.y + content.height + 1e-6);
                } else {
                    const t = toScreen(s, { x: 0, y: content.y }).y;
                    const b = VIEWPORT.height - toScreen(s, { x: 0, y: content.y + content.height }).y;
                    expect(t).toBeCloseTo(b, 6);
                }
            }
        }
    });
});

describe('wheelZoomFactor', () => {
    it('zooms in on wheel-up and out on wheel-down', () => {
        expect(wheelZoomFactor({ deltaY: -100 })).toBeGreaterThan(1);
        expect(wheelZoomFactor({ deltaY: 100 })).toBeLessThan(1);
    });

    it('is symmetric — a notch up then a notch down is a no-op', () => {
        const inF = wheelZoomFactor({ deltaY: -100 });
        const outF = wheelZoomFactor({ deltaY: 100 });
        expect(inF * outF).toBeCloseTo(1, 12);
    });

    it('gives a mouse notch a usable but not twitchy step', () => {
        const f = wheelZoomFactor({ deltaY: -100 });
        expect(f).toBeGreaterThan(1.1);
        expect(f).toBeLessThan(1.25);
        // 1x -> 5x should take a reasonable number of notches, not 2 and not 60.
        const notches = Math.log(MAX_SCALE) / Math.log(f);
        expect(notches).toBeGreaterThan(6);
        expect(notches).toBeLessThan(20);
    });

    it('treats a ctrlKey wheel (macOS trackpad pinch) as a finer-grained zoom', () => {
        // Same tiny delta: as a pinch it must move the scale meaningfully; as
        // a plain wheel that delta is a rounding error.
        const pinch = wheelZoomFactor({ deltaY: -6, ctrlKey: true });
        const plain = wheelZoomFactor({ deltaY: -6 });
        expect(pinch).toBeGreaterThan(plain);
        expect(pinch).toBeGreaterThan(1.05);
        expect(plain).toBeLessThan(1.01);
    });

    it('normalises deltaMode so line- and page-scrolling wheels agree', () => {
        // 3 lines (deltaMode 1) ~= 48px ~= half a 100px notch.
        const lines = wheelZoomFactor({ deltaY: -3, deltaMode: 1 });
        const px48 = wheelZoomFactor({ deltaY: -48, deltaMode: 0 });
        expect(lines).toBeCloseTo(px48, 12);
        const page = wheelZoomFactor({ deltaY: -1, deltaMode: 2 });
        expect(page).toBeGreaterThan(lines);
    });

    it('caps a single event so a flung wheel cannot teleport the view', () => {
        expect(wheelZoomFactor({ deltaY: -100000 })).toBe(2);
        expect(wheelZoomFactor({ deltaY: 100000 })).toBe(0.5);
    });

    it('is a no-op for a zero or non-finite delta', () => {
        expect(wheelZoomFactor({ deltaY: 0 })).toBe(1);
        expect(wheelZoomFactor({ deltaY: NaN })).toBe(1);
    });
});

describe('degenerate inputs', () => {
    it('does not produce NaN for a zero-sized pane', () => {
        const zero = { width: 0, height: 0 };
        const s = clampState({ scale: 2, tx: 10, ty: 10 }, zero, fullRect(zero));
        expect(Number.isFinite(s.tx)).toBe(true);
        expect(Number.isFinite(s.ty)).toBe(true);
    });

    it('does not produce NaN when the frame has no intrinsic size yet', () => {
        const s = zoomAt(IDENTITY, { x: 10, y: 10 }, 2, VIEWPORT, { x: 0, y: 0, width: 0, height: 0 });
        expect(Number.isFinite(s.tx)).toBe(true);
        expect(Number.isFinite(s.ty)).toBe(true);
    });
});
