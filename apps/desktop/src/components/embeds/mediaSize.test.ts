/**
 * Size follows the media (docs/plans/embeds.md §11): the box math every video /
 * picture embed uses. Oracle = the round-4 concept values the owner picked
 * (concepts/embeds-2026-11-23/round4: 9:16 = 252 × 448, 16:9 = 400 × 225,
 * compact thumbnail 84 × 150 / 184 × 104) and the rules: the box
 * always has the media's own aspect, never exceeds its caps, and changes
 * smoothly between shapes.
 */
import { describe, expect, it } from 'vitest';
import { ASPECT_MAX, ASPECT_MIN, MEDIA_CAPS, TIKTOK_MIN_WIDTH, aspectOf, clampAspect, mediaBox, pickAspect } from './mediaSize';

const ratio = (b: { width: number; height: number }) => b.width / b.height;

describe('mediaBox: the round-4 sizes', () => {
    it('expanded: 9:16 is 252 × 448, 16:9 is 400 × 225, a square 336 × 336', () => {
        expect(mediaBox(9 / 16, MEDIA_CAPS.expanded)).toEqual({ width: 252, height: 448 });
        expect(mediaBox(16 / 9, MEDIA_CAPS.expanded)).toEqual({ width: 400, height: 225 });
        expect(mediaBox(1, MEDIA_CAPS.expanded)).toEqual({ width: 336, height: 336 });
    });
    it('compact thumbnail: 84 × 150, 184 × 103.5, 138 square', () => {
        expect(mediaBox(9 / 16, MEDIA_CAPS.compactThumb)).toEqual({ width: 84.38, height: 150 });
        expect(mediaBox(16 / 9, MEDIA_CAPS.compactThumb)).toEqual({ width: 184, height: 103.5 });
        expect(mediaBox(1, MEDIA_CAPS.compactThumb)).toEqual({ width: 138, height: 138 });
    });
    it('compact picture: plain fit in 320 × 240', () => {
        expect(mediaBox(16 / 9, MEDIA_CAPS.compactPicture)).toEqual({ width: 320, height: 180 });
        expect(mediaBox(9 / 16, MEDIA_CAPS.compactPicture)).toEqual({ width: 135, height: 240 });
        expect(mediaBox(1, MEDIA_CAPS.compactPicture)).toEqual({ width: 240, height: 240 });
    });
});

describe('mediaBox: invariants over every shape', () => {
    const shapes: number[] = [];
    for (let a = 0.3; a <= 3; a += 0.01) shapes.push(a);
    for (const [name, caps] of Object.entries(MEDIA_CAPS)) {
        it(`${name}: own aspect (clamped), inside the caps, never wider than maxW nor taller than maxH`, () => {
            for (const a of shapes) {
                const b = mediaBox(a, caps);
                expect(Math.abs(ratio(b) - clampAspect(a))).toBeLessThan(0.01);
                expect(b.width).toBeLessThanOrEqual(caps.maxW + 0.01);
                expect(b.height).toBeLessThanOrEqual(caps.maxH + 0.01);
                if (Number.isFinite(caps.area)) expect(b.width * b.height).toBeLessThanOrEqual(caps.area * 1.001);
            }
        });
        it(`${name}: no jump between neighbouring shapes (smooth through square)`, () => {
            for (let i = 1; i < shapes.length; i++) {
                const p = mediaBox(shapes[i - 1], caps), q = mediaBox(shapes[i], caps);
                expect(Math.abs(p.width - q.width)).toBeLessThan(caps.maxW * 0.04);
                expect(Math.abs(p.height - q.height)).toBeLessThan(caps.maxH * 0.04);
            }
        });
    }
    it('POSITIVE CONTROL: the round-4 step rule (portrait / square / landscape) jumps at square, and the check catches it', () => {
        const step = (a: number) => (a < 0.98 ? { width: 448 * a, height: 448 } : a <= 1.02 ? { width: 320, height: 320 } : { width: 400, height: 400 / a });
        const jump = Math.abs(step(0.97).width - step(1.0).width);
        expect(jump).toBeGreaterThan(400 * 0.04);
    });
    it('a missing / bad aspect is 16:9; extremes are clamped to the sane band', () => {
        expect(mediaBox(NaN, MEDIA_CAPS.expanded)).toEqual({ width: 400, height: 225 });
        expect(mediaBox(0, MEDIA_CAPS.expanded)).toEqual({ width: 400, height: 225 });
        expect(ratio(mediaBox(10, MEDIA_CAPS.expanded))).toBeCloseTo(ASPECT_MAX, 2);
        expect(ratio(mediaBox(0.01, MEDIA_CAPS.expanded))).toBeCloseTo(ASPECT_MIN, 2);
    });
});

describe('TikTok minimum width', () => {
    it('a 9:16 TikTok is exactly the minimum; a narrower shape is raised to it keeping its aspect', () => {
        expect(mediaBox(9 / 16, MEDIA_CAPS.expanded, TIKTOK_MIN_WIDTH).width).toBe(252);
        const thin = mediaBox(0.5, MEDIA_CAPS.expanded, TIKTOK_MIN_WIDTH);
        expect(thin.width).toBe(252);
        expect(thin.height).toBe(504);
        // POSITIVE CONTROL: without the minimum the same shape is narrower than TikTok can draw.
        expect(mediaBox(0.5, MEDIA_CAPS.expanded).width).toBeLessThan(TIKTOK_MIN_WIDTH);
    });
});

describe('pickAspect: where the shape comes from', () => {
    it('the provider\'s fixed shape wins (YouTube Shorts 9:16 even with a 4:3 thumbnail)', () => {
        expect(pickAspect({ provider: 9 / 16, thumb: { width: 480, height: 360 } })).toEqual({ aspect: 9 / 16, source: 'provider', known: true });
    });
    it('then the media size, then the thumbnail size', () => {
        expect(pickAspect({ media: { width: 1080, height: 1920 }, thumb: { width: 1280, height: 720 } }).source).toBe('media');
        expect(pickAspect({ media: { width: 1080, height: 1920 } }).aspect).toBeCloseTo(9 / 16);
        expect(pickAspect({ media: {}, thumb: { width: 720, height: 720 } })).toEqual({ aspect: 1, source: 'thumb', known: true });
    });
    it('a DESIGNED thumbnail says nothing about the media', () => {
        expect(pickAspect({ thumb: { width: 1280, height: 720, designed: true }, providerDefault: 9 / 16 })).toEqual({ aspect: 9 / 16, source: 'provider', known: true });
        expect(pickAspect({ thumb: { width: 1280, height: 720, designed: true } })).toEqual({ aspect: 16 / 9, source: 'default', known: false });
    });
    it('an old message with nothing: the provider\'s usual shape, else 16:9 (not known: the decoded thumbnail may tell)', () => {
        expect(pickAspect({ providerDefault: 9 / 16 }).aspect).toBeCloseTo(9 / 16);
        expect(pickAspect({})).toEqual({ aspect: 16 / 9, source: 'default', known: false });
    });
    it('bad sizes are ignored, not trusted', () => {
        expect(aspectOf(0, 100)).toBeNull();
        expect(aspectOf(100, -1)).toBeNull();
        expect(aspectOf(NaN, 1)).toBeNull();
        expect(pickAspect({ media: { width: 0, height: 720 }, thumb: { width: 640, height: 640 } }).source).toBe('thumb');
        // A sliver is clamped, never drawn as a sliver.
        expect(pickAspect({ media: { width: 16000, height: 10 } }).aspect).toBe(ASPECT_MAX);
    });
});
