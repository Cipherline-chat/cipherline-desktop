import { describe, it, expect } from 'vitest';
import { contentRect } from '../../utils/annotationGeometry';
import {
    videoRectInsets,
    containRectInsets,
    videoRectPending,
    tileCornerInsets,
    chromeMaxWidthCss,
    cornerStyle,
    tileChromeSlots,
    CHROME_GUTTER_PX,
    type ChromeInsets,
    type TileCorner,
} from './videoRectChrome';

/**
 * The whole point of this module is that corner chrome lands ON THE PICTURE,
 * never in an object-contain letterbox bar. Every assertion below is written
 * as a statement about the picture's edges rather than about the arithmetic,
 * so a change that moves the badge into the bar fails here rather than in a
 * screenshot.
 */

const GUTTER = 8;

/** Re-derive the picture's rect independently of the module under test, so a
 *  bug in `contentRect` cannot make these expectations agree with themselves. */
function pictureRect(box: { width: number; height: number }, iw: number, ih: number) {
    const scale = Math.min(box.width / iw, box.height / ih);
    const width = iw * scale;
    const height = ih * scale;
    return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

describe('containRectInsets — contain-fit letterboxing', () => {
    it('WIDE video in a TALL container: bars top and bottom, none at the sides', () => {
        // 16:9 picture in a 400x400 box -> 400x225, centred: 87.5px bar above
        // and below, zero at the sides.
        const box = { width: 400, height: 400 };
        const i = containRectInsets(box, { width: 1920, height: 1080 }, GUTTER);
        const r = pictureRect(box, 1920, 1080);

        expect(i.top).toBeCloseTo(r.y + GUTTER);
        expect(i.bottom).toBeCloseTo(box.height - r.y - r.height + GUTTER);
        // The picture spans the full width, so horizontal insets are the bare
        // gutter — the badge is not pushed in from a bar that isn't there.
        expect(i.left).toBeCloseTo(GUTTER);
        expect(i.right).toBeCloseTo(GUTTER);

        // Positive control: the naive "pin to the container" answer really is
        // different here, i.e. this test would fail against the old behaviour.
        expect(i.top).toBeGreaterThan(GUTTER);
        expect(i.top).toBeCloseTo(87.5 + GUTTER);
    });

    it('TALL video in a WIDE container: bars left and right, none top or bottom', () => {
        // 9:16 picture in a 1000x400 box -> 225x400, centred: 387.5px bar
        // either side.
        const box = { width: 1000, height: 400 };
        const i = containRectInsets(box, { width: 1080, height: 1920 }, GUTTER);
        const r = pictureRect(box, 1080, 1920);

        expect(i.left).toBeCloseTo(r.x + GUTTER);
        expect(i.right).toBeCloseTo(box.width - r.x - r.width + GUTTER);
        expect(i.top).toBeCloseTo(GUTTER);
        expect(i.bottom).toBeCloseTo(GUTTER);

        expect(i.left).toBeCloseTo(387.5 + GUTTER);
        expect(i.left).toBeGreaterThan(GUTTER); // positive control
    });

    it('EXACT aspect match: no bars, so every inset is the bare gutter', () => {
        const box = { width: 1280, height: 720 };
        const i = containRectInsets(box, { width: 1920, height: 1080 }, GUTTER);
        expect(i).toEqual({ top: GUTTER, right: GUTTER, bottom: GUTTER, left: GUTTER });
    });

    it('ZERO / unknown intrinsic size falls back to the tile corners', () => {
        const box = { width: 640, height: 360 };
        // A <video> with no metadata reports 0x0.
        expect(containRectInsets(box, { width: 0, height: 0 }, GUTTER))
            .toEqual({ top: GUTTER, right: GUTTER, bottom: GUTTER, left: GUTTER });
        // ...and one axis alone being zero is just as unusable.
        expect(containRectInsets(box, { width: 1920, height: 0 }, GUTTER))
            .toEqual({ top: GUTTER, right: GUTTER, bottom: GUTTER, left: GUTTER });
        // No intrinsic size at all (camera off) — same answer.
        expect(containRectInsets(box, null, GUTTER))
            .toEqual({ top: GUTTER, right: GUTTER, bottom: GUTTER, left: GUTTER });
    });

    it('a box that has not been laid out yet falls back to the tile corners', () => {
        expect(containRectInsets({ width: 0, height: 0 }, { width: 1920, height: 1080 }, GUTTER))
            .toEqual({ top: GUTTER, right: GUTTER, bottom: GUTTER, left: GUTTER });
        expect(containRectInsets(null, { width: 1920, height: 1080 }, GUTTER))
            .toEqual({ top: GUTTER, right: GUTTER, bottom: GUTTER, left: GUTTER });
    });

    it('the insets always describe a rect INSIDE the picture, for any shape', () => {
        const box = { width: 900, height: 500 };
        const shapes: Array<[number, number]> = [
            [1920, 1080], [1080, 1920], [640, 480], [3440, 1440], [1, 4000], [4000, 1],
        ];
        for (const [iw, ih] of shapes) {
            const i = containRectInsets(box, { width: iw, height: ih }, GUTTER);
            const r = contentRect(box, { width: iw, height: ih }, 'contain')!;
            // Top-left corner of the chrome's allowed area, in tile coords.
            expect(i.left).toBeGreaterThanOrEqual(r.x);
            expect(i.top).toBeGreaterThanOrEqual(r.y);
            // Bottom-right corner, converted back into tile coords.
            expect(box.width - i.right).toBeLessThanOrEqual(r.x + r.width);
            expect(box.height - i.bottom).toBeLessThanOrEqual(r.y + r.height);
        }
    });
});

describe('videoRectInsets — clamping and fallbacks', () => {
    it('never pushes chrome outside the tile when the picture OVERFLOWS it (cover)', () => {
        // object-cover: the picture is bigger than the box, so raw insets go
        // negative. Chrome must stay inside the box the user can actually see.
        const box = { width: 400, height: 400 };
        const cover = contentRect(box, { width: 1920, height: 1080 }, 'cover')!;
        expect(cover.x).toBeLessThan(0); // precondition: this really does overflow
        const i = videoRectInsets(box, cover, GUTTER);
        expect(i.left).toBe(0);
        expect(i.right).toBe(0);
        expect(i.top).toBeCloseTo(GUTTER);
        expect(i.bottom).toBeCloseTo(GUTTER);
    });

    it('a negative gutter is treated as zero rather than inverted', () => {
        const box = { width: 400, height: 400 };
        expect(videoRectInsets(box, null, -20)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    });

    it('a null rect or null box falls back to the bare gutter', () => {
        expect(videoRectInsets({ width: 400, height: 400 }, null, GUTTER))
            .toEqual({ top: GUTTER, right: GUTTER, bottom: GUTTER, left: GUTTER });
        expect(videoRectInsets(null, { x: 10, y: 10, width: 100, height: 100 }, GUTTER))
            .toEqual({ top: GUTTER, right: GUTTER, bottom: GUTTER, left: GUTTER });
    });
});

describe('videoRectPending — the no-flicker window', () => {
    const rect = { x: 0, y: 10, width: 100, height: 80 };

    it('is true ONLY while a contain-fit tile with a live picture lacks its rect', () => {
        expect(videoRectPending(true, true, null)).toBe(true);
    });

    it('is false once the rect is known', () => {
        expect(videoRectPending(true, true, rect)).toBe(false);
    });

    it('is false for a camera-off tile — its name must never be withheld', () => {
        expect(videoRectPending(true, false, null)).toBe(false);
    });

    it('is false where the picture provably fills the box (no contain fit)', () => {
        expect(videoRectPending(false, true, null)).toBe(false);
        expect(videoRectPending(false, false, null)).toBe(false);
    });
});

/**
 * ── Every tile type, not just the one with a picture ────────────────────────
 *
 * A fullscreen or focused call puts three different components on screen —
 * VideoTile (camera / screen share / camera-off), ParticipantCard
 * (avatar-only) and ScreenShareGate (click-to-watch) — and the owner asked for
 * the name in the top-right corner of ALL of them. Only VideoTile has a
 * picture to ride, so the other two resolve to the tile's own corners. These
 * lock that the "no picture" answer is the SAME answer, produced by the same
 * code, rather than a second hand-tuned constant per component.
 */
describe('tileCornerInsets — the tiles that never have a picture', () => {
    it("is the tile's own corners at the shared gutter", () => {
        expect(tileCornerInsets()).toEqual({
            top: CHROME_GUTTER_PX, right: CHROME_GUTTER_PX,
            bottom: CHROME_GUTTER_PX, left: CHROME_GUTTER_PX,
        });
    });

    it('is EXACTLY what a picture-bearing tile falls back to when its source goes away', () => {
        // The camera-off path in VideoTile: the <video> and its intrinsic size
        // survive a mute, so the tile passes `null` for the rect at RENDER
        // time rather than re-running its fit effect. An avatar-only card and
        // a gated share have no rect to begin with. All three must land in the
        // same place, or a muted camera's name would sit at a different inset
        // from the card next to it in the same grid.
        const box = { width: 640, height: 360 };
        expect(videoRectInsets(box, null, CHROME_GUTTER_PX)).toEqual(tileCornerInsets());
        expect(videoRectInsets(null, null, CHROME_GUTTER_PX)).toEqual(tileCornerInsets());
    });

    it('honours an explicit gutter, and clamps a negative one like every other path', () => {
        expect(tileCornerInsets(20)).toEqual({ top: 20, right: 20, bottom: 20, left: 20 });
        expect(tileCornerInsets(-4)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    });

    it("the shared gutter really is what VideoTile's old hard-coded corner was", () => {
        // `top-2` / `right-2` is 0.5rem = 8px. Pinned so moving the constant is
        // a deliberate design change rather than a silent drift away from every
        // corner in the app that has not been migrated onto it.
        expect(CHROME_GUTTER_PX).toBe(8);
    });
});

/**
 * ── The width cap ───────────────────────────────────────────────────────────
 *
 * One relative formula has to be correct for a letterboxed picture AND for a
 * tile with none, because `TileNamePill` applies it unconditionally to every
 * tile type. These resolve the CSS against a concrete tile width and assert
 * the px result against an independently-derived expectation per tile state,
 * rather than against the formula's own algebra.
 */
describe('chromeMaxWidthCss — one cap for every tile state', () => {
    /** What `max(0px, 100% - Npx)` resolves to against a tile `boxWidth` wide.
     *  Mirrors the CSS `max()` rather than assuming it never bites, so the
     *  degenerate-shape case below is measuring the real used value. */
    const resolve = (css: string, boxWidth: number) => {
        const m = /^max\(0px, 100% - ([\d.]+)px\)$/.exec(css);
        expect(m).not.toBeNull();
        return Math.max(0, boxWidth - Number(m![1]));
    };

    it("TALL video in a WIDE tile: the cap is the PICTURE's width, not the tile's", () => {
        // The case that motivates a cap at all — a 9:16 picture in a 1000x400
        // tile is only 225px wide, far narrower than a long display name.
        const box = { width: 1000, height: 400 };
        const r = pictureRect(box, 1080, 1920);
        const i = containRectInsets(box, { width: 1080, height: 1920 }, GUTTER);

        expect(resolve(chromeMaxWidthCss(i), box.width)).toBeCloseTo(r.width - 2 * GUTTER);
        // Positive control: the naive "cap at the tile" answer is ~4x larger,
        // so this assertion cannot pass against un-capped behaviour.
        expect(resolve(chromeMaxWidthCss(i), box.width)).toBeLessThan(box.width - 2 * GUTTER);
    });

    it('WIDE video in a TALL tile: full-width picture, so the cap IS the tile less both gutters', () => {
        const box = { width: 400, height: 400 };
        const i = containRectInsets(box, { width: 1920, height: 1080 }, GUTTER);
        expect(resolve(chromeMaxWidthCss(i), box.width)).toBeCloseTo(box.width - 2 * GUTTER);
    });

    it('EXACT aspect match: no bars, cap is the tile less both gutters', () => {
        const box = { width: 1280, height: 720 };
        const i = containRectInsets(box, { width: 1920, height: 1080 }, GUTTER);
        expect(resolve(chromeMaxWidthCss(i), box.width)).toBeCloseTo(box.width - 2 * GUTTER);
    });

    it('UNKNOWN intrinsic size (pre-metadata): cap is the tile, never unbounded', () => {
        const box = { width: 640, height: 360 };
        const i = containRectInsets(box, { width: 0, height: 0 }, GUTTER);
        expect(resolve(chromeMaxWidthCss(i), box.width)).toBeCloseTo(box.width - 2 * GUTTER);
    });

    it('CAMERA-OFF / AVATAR-ONLY / GATED SHARE: cap is the tile less both gutters', () => {
        // All three resolve to tileCornerInsets(), so one assertion covers the
        // whole no-picture family — which is the point of them sharing it.
        const cap = chromeMaxWidthCss(tileCornerInsets());
        expect(resolve(cap, 300)).toBeCloseTo(300 - 2 * CHROME_GUTTER_PX);
        expect(resolve(cap, 96)).toBeCloseTo(96 - 2 * CHROME_GUTTER_PX);
        // Regression guard: this case previously had NO cap at all, so a long
        // display name ran off a narrow tile. A cap equal to the tile's own
        // width would be that same bug wearing a formula.
        expect(resolve(cap, 96)).toBeLessThan(96);
    });

    it('a picture that OVERFLOWS its tile (cover) is still capped at the tile', () => {
        // videoRectInsets clamps cover's negative insets to 0, so the cap
        // resolves to the full tile width — chrome inside the box the user can
        // actually see, never wider than it.
        const box = { width: 400, height: 400 };
        const cover = contentRect(box, { width: 1920, height: 1080 }, 'cover')!;
        const i = videoRectInsets(box, cover, GUTTER);
        expect(resolve(chromeMaxWidthCss(i), box.width)).toBeCloseTo(box.width);
    });

    it('never produces a negative cap, for any shape', () => {
        // A picture narrower than both gutters together (a 1x4000 track
        // letterboxes to 0.125px wide in this tile) drives the subtrahend past
        // 100%. Without the `max(0px, ...)` clamp that is not a zero cap — it
        // is an INVALID max-width, which CSS drops, leaving the pill uncapped
        // on exactly the shape that needs the cap most.
        const box = { width: 900, height: 500 };
        const shapes: Array<[number, number]> = [
            [1920, 1080], [1080, 1920], [640, 480], [3440, 1440], [1, 4000], [4000, 1],
        ];
        for (const [iw, ih] of shapes) {
            const i = containRectInsets(box, { width: iw, height: ih }, GUTTER);
            const css = chromeMaxWidthCss(i);
            expect(css.startsWith('max(0px,')).toBe(true);
            expect(resolve(css, box.width)).toBeGreaterThanOrEqual(0);
        }
        // Positive control that the clamp is load-bearing and not decoration:
        // this shape really does make the raw calc go negative.
        const degenerate = containRectInsets(box, { width: 1, height: 4000 }, GUTTER);
        expect(box.width - (degenerate.left + degenerate.right)).toBeLessThan(0);
    });
});

/**
 * ── WHICH corner, per view mode ─────────────────────────────────────────────
 *
 * Two arrangements, both owner quotes, and they are not a transform of each
 * other:
 *
 *   corner         NOT fullscreen        fullscreen
 *   top-left       resolution / fps      annotation cluster
 *   top-right      annotation cluster    name pill
 *   bottom-left    —                     resolution / fps
 *   bottom-right   name pill             —
 *
 * These assert the table as a table — every slot, both modes — rather than
 * spot-checking one corner, because the failure mode being guarded is two
 * overlays landing in the SAME corner, which no single-slot assertion sees.
 */
describe('tileChromeSlots — the two corner layouts', () => {
    it('NOT fullscreen: resolution top-left, annotation top-right, name bottom-right', () => {
        expect(tileChromeSlots(false)).toEqual({
            stats: 'top-left',
            tools: 'top-right',
            name: 'bottom-right',
        });
    });

    it('FULLSCREEN: annotation top-left, name top-right, resolution bottom-left', () => {
        // The arrangement that shipped and was approved — unchanged, and
        // pinned here so the non-fullscreen work could not disturb it.
        expect(tileChromeSlots(true)).toEqual({
            tools: 'top-left',
            name: 'top-right',
            stats: 'bottom-left',
        });
    });

    it('an ABSENT flag means not-fullscreen — the caller reads an optional context', () => {
        // VideoTile passes `callCtx?.isFullscreen`, which is `undefined` with
        // no CallContext at all (the sidebar strip). Defaulting the other way
        // would put every sidebar thumbnail on the fullscreen layout.
        expect(tileChromeSlots(undefined)).toEqual(tileChromeSlots(false));
    });

    it('no two overlays ever share a corner, in EITHER mode — the collision that\n'
        + '       moving any one of them can cause', () => {
        for (const fullscreen of [false, true]) {
            const s = tileChromeSlots(fullscreen);
            expect(new Set([s.tools, s.name, s.stats]).size).toBe(3);
        }
    });

    it('the two modes genuinely DIFFER in every slot — so a mode flag that never\n'
        + '       reaches this function cannot pass unnoticed', () => {
        const off = tileChromeSlots(false);
        const on = tileChromeSlots(true);
        expect(off.name).not.toBe(on.name);
        expect(off.tools).not.toBe(on.tools);
        expect(off.stats).not.toBe(on.stats);
    });

    it('every slot is one of the four real corners', () => {
        const corners = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
        for (const fullscreen of [false, true]) {
            const s = tileChromeSlots(fullscreen);
            for (const c of [s.tools, s.name, s.stats]) expect(corners.has(c)).toBe(true);
        }
    });
});

/**
 * ── WHERE that corner is ────────────────────────────────────────────────────
 *
 * `cornerStyle` is the only place a corner is turned into CSS offsets, so
 * these are the assertions that keep chrome off the letterbox bars now that
 * bottom-left and bottom-right are live corners rather than one hand-written
 * special case.
 *
 * Every expectation below is stated against the PICTURE's edges, re-derived
 * independently of the module under test (`pictureRect` at the top of this
 * file), never against the arithmetic.
 */
describe('cornerStyle — every corner rides the picture, in both modes', () => {
    /** Convert a corner position back into the chrome's own point in tile
     *  coordinates, so the assertions can talk about the picture instead of
     *  about which CSS property happens to be set. */
    const pointIn = (
        box: { width: number; height: number },
        pos: { top?: number; right?: number; bottom?: number; left?: number },
    ) => ({
        x: pos.left !== undefined ? pos.left : box.width - pos.right!,
        y: pos.top !== undefined ? pos.top : box.height - pos.bottom!,
    });

    const ALL: TileCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

    it('sets exactly two offsets, and they are the two that name the corner', () => {
        const i: ChromeInsets = { top: 1, right: 2, bottom: 3, left: 4 };
        expect(cornerStyle('top-left', i)).toEqual({ top: 1, left: 4 });
        expect(cornerStyle('top-right', i)).toEqual({ top: 1, right: 2 });
        expect(cornerStyle('bottom-left', i)).toEqual({ bottom: 3, left: 4 });
        expect(cornerStyle('bottom-right', i)).toEqual({ bottom: 3, right: 2 });
    });

    it('never sets the opposing offset — an element given both `left` and `right`\n'
        + '       is STRETCHED between them, which left-aligns the name inside a box\n'
        + '       the width of the picture instead of shrink-wrapping it', () => {
        const i: ChromeInsets = { top: 1, right: 2, bottom: 3, left: 4 };
        for (const c of ALL) {
            const pos = cornerStyle(c, i);
            expect(Object.keys(pos).sort()).toHaveLength(2);
            expect('top' in pos && 'bottom' in pos).toBe(false);
            expect('left' in pos && 'right' in pos).toBe(false);
        }
    });

    it('WIDE video in a TALL tile (bars top and bottom): every corner is on the\n'
        + '       picture, in both modes', () => {
        const box = { width: 400, height: 400 };
        const intr = { width: 1920, height: 1080 };
        const r = pictureRect(box, intr.width, intr.height);
        const i = containRectInsets(box, intr, GUTTER);

        for (const c of ALL) {
            const p = pointIn(box, cornerStyle(c, i));
            expect(p.y).toBeGreaterThanOrEqual(r.y);
            expect(p.y).toBeLessThanOrEqual(r.y + r.height);
            expect(p.x).toBeGreaterThanOrEqual(r.x);
            expect(p.x).toBeLessThanOrEqual(r.x + r.width);
        }
        // Positive control: the naive "pin to the tile" answer really is
        // different on this shape, so the assertion above is not vacuous.
        // Bottom-right is the one the non-fullscreen name pill now uses.
        expect(pointIn(box, cornerStyle('bottom-right', i)).y).toBeLessThan(box.height - GUTTER);
        expect(pointIn(box, cornerStyle('top-left', i)).y).toBeGreaterThan(GUTTER);
    });

    it('TALL video in a WIDE tile (bars left and right): every corner is on the\n'
        + '       picture, in both modes', () => {
        const box = { width: 1000, height: 400 };
        const intr = { width: 1080, height: 1920 };
        const r = pictureRect(box, intr.width, intr.height);
        const i = containRectInsets(box, intr, GUTTER);

        for (const c of ALL) {
            const p = pointIn(box, cornerStyle(c, i));
            expect(p.x).toBeGreaterThanOrEqual(r.x);
            expect(p.x).toBeLessThanOrEqual(r.x + r.width);
            expect(p.y).toBeGreaterThanOrEqual(r.y);
            expect(p.y).toBeLessThanOrEqual(r.y + r.height);
        }
        // Positive control on the horizontal axis this time: the bars are
        // 387.5px wide, so a tile-pinned corner would be nowhere near.
        expect(pointIn(box, cornerStyle('top-left', i)).x).toBeGreaterThan(GUTTER);
        expect(pointIn(box, cornerStyle('bottom-right', i)).x).toBeLessThan(box.width - GUTTER);
    });

    it('POSITIVE CONTROL BY MUTATION — ignoring the rect\'s Y collapses exactly the\n'
        + '       vertical corners, and ignoring its X exactly the horizontal ones', () => {
        // The two mutations a careless rewrite of `videoRectInsets` would make.
        // Naming the exact set each one breaks is what makes this a control
        // rather than a smoke test: a mutation that broke NOTHING, or that
        // broke everything, would both fail here.
        const box = { width: 400, height: 400 };          // wide video -> bars top/bottom
        const intr = { width: 1920, height: 1080 };
        const good = containRectInsets(box, intr, GUTTER);

        // Mutation A: chrome pinned to the tile's own edges (rect ignored).
        const ignoresRect = tileCornerInsets(GUTTER);
        const brokenByA = ALL.filter(c =>
            JSON.stringify(cornerStyle(c, good)) !== JSON.stringify(cornerStyle(c, ignoresRect)));
        // Bars are top and bottom here, so BOTH vertical offsets are wrong and
        // neither horizontal one is — every corner reads one of the two.
        expect(brokenByA.sort()).toEqual(
            ['bottom-left', 'bottom-right', 'top-left', 'top-right']);

        // Mutation B: the y-axis honoured but the x-axis pinned to the tile.
        const ignoresX: ChromeInsets = { ...good, left: GUTTER, right: GUTTER };
        const brokenByB = ALL.filter(c =>
            JSON.stringify(cornerStyle(c, good)) !== JSON.stringify(cornerStyle(c, ignoresX)));
        // This shape has NO horizontal bars, so mutating x changes nothing —
        // which is itself the point: a control has to distinguish the axes.
        expect(brokenByB).toEqual([]);

        // ...so run mutation B again on the shape that DOES have side bars.
        const wideBox = { width: 1000, height: 400 };
        const tall = { width: 1080, height: 1920 };
        const goodTall = containRectInsets(wideBox, tall, GUTTER);
        const ignoresXTall: ChromeInsets = { ...goodTall, left: GUTTER, right: GUTTER };
        const brokenByBTall = ALL.filter(c =>
            JSON.stringify(cornerStyle(c, goodTall)) !== JSON.stringify(cornerStyle(c, ignoresXTall)));
        expect(brokenByBTall.sort()).toEqual(
            ['bottom-left', 'bottom-right', 'top-left', 'top-right']);
        // ...and the y-axis mutation now changes nothing on THAT shape.
        const ignoresYTall: ChromeInsets = { ...goodTall, top: GUTTER, bottom: GUTTER };
        expect(ALL.filter(c =>
            JSON.stringify(cornerStyle(c, goodTall)) !== JSON.stringify(cornerStyle(c, ignoresYTall))))
            .toEqual([]);
    });

    it('CAMERA-OFF: all four corners are the tile\'s own, at the shared gutter', () => {
        // A muted camera passes `null` for the rect at render time even though
        // the <video> and its intrinsic size survive — see VideoTile's
        // `hasActiveSource` gate. The name pill has to land somewhere sane.
        const box = { width: 640, height: 360 };
        const i = videoRectInsets(box, null, CHROME_GUTTER_PX);
        expect(cornerStyle('bottom-right', i)).toEqual({ bottom: CHROME_GUTTER_PX, right: CHROME_GUTTER_PX });
        expect(cornerStyle('top-left', i)).toEqual({ top: CHROME_GUTTER_PX, left: CHROME_GUTTER_PX });
        expect(cornerStyle('top-right', i)).toEqual({ top: CHROME_GUTTER_PX, right: CHROME_GUTTER_PX });
        expect(cornerStyle('bottom-left', i)).toEqual({ bottom: CHROME_GUTTER_PX, left: CHROME_GUTTER_PX });
    });

    it('AVATAR-ONLY and GATED SHARE: identical to camera-off, from the same code', () => {
        // ParticipantCard and ScreenShareGate both call `tileCornerInsets()`.
        // If these ever diverge from the camera-off answer above, a muted
        // camera's name sits at a different inset from the avatar card beside
        // it in the same grid — which is what this module exists to prevent.
        const i = tileCornerInsets();
        for (const c of ALL) {
            expect(cornerStyle(c, i)).toEqual(
                cornerStyle(c, videoRectInsets({ width: 640, height: 360 }, null, CHROME_GUTTER_PX)));
        }
    });

    it('a picture that OVERFLOWS its tile (cover) keeps every corner INSIDE the tile', () => {
        // Cover yields negative raw insets; `videoRectInsets` clamps them to 0,
        // so chrome stays in the box the user can actually see. Bottom-right
        // and bottom-left were previously unreachable corners, so this is the
        // first time the clamp is exercised on them.
        const box = { width: 400, height: 400 };
        const cover = contentRect(box, { width: 1920, height: 1080 }, 'cover')!;
        const i = videoRectInsets(box, cover, GUTTER);
        for (const c of ALL) {
            const p = pointIn(box, cornerStyle(c, i));
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(box.width);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(box.height);
        }
    });

    it('the slot table composed with the geometry: for EVERY shape and BOTH modes,\n'
        + '       all three overlays land on the picture and in three distinct corners', () => {
        // The end-to-end property the two owner requests actually amount to.
        const box = { width: 900, height: 500 };
        const shapes: Array<[number, number]> = [
            [1920, 1080], [1080, 1920], [640, 480], [3440, 1440], [900, 500],
        ];
        for (const fullscreen of [false, true]) {
            const slots = tileChromeSlots(fullscreen);
            for (const [iw, ih] of shapes) {
                const i = containRectInsets(box, { width: iw, height: ih }, GUTTER);
                const r = contentRect(box, { width: iw, height: ih }, 'contain')!;
                const seen = new Set<string>();
                for (const corner of [slots.tools, slots.name, slots.stats]) {
                    const p = pointIn(box, cornerStyle(corner, i));
                    expect(p.x).toBeGreaterThanOrEqual(r.x - 1e-9);
                    expect(p.x).toBeLessThanOrEqual(r.x + r.width + 1e-9);
                    expect(p.y).toBeGreaterThanOrEqual(r.y - 1e-9);
                    expect(p.y).toBeLessThanOrEqual(r.y + r.height + 1e-9);
                    seen.add(`${p.x},${p.y}`);
                }
                expect(seen.size).toBe(3);
            }
        }
    });
});
