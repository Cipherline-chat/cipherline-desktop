import { describe, it, expect } from 'vitest';
import {
    planEncode, clampCaptureBox, encoderLimitsFor, evenFloor,
    UHD_WIDTH, UHD_HEIGHT, UHD_PIXELS, RESOLUTION_STEP_PIXELS, MAX_RESOLUTION_STEP,
    type EncoderCodec,
} from './shareEncoderLimits';
import { resolveSSResolution, captureBoxFor, type ScreenShareCodec } from './screenShare';

const CODECS: EncoderCodec[] = ['h264', 'h265', 'vp8', 'vp9', 'av1'];

const DISPLAYS: Array<[string, number, number]> = [
    ['1080p', 1920, 1080],
    ['1440p', 2560, 1440],
    ['4K', 3840, 2160],
    ['5120x1440 (32:9)', 5120, 1440],
    ['7680x1440 (3x1440p Surround)', 7680, 1440],
    ['7680x2160 (2x4K)', 7680, 2160],
];

describe('encoder limits', () => {
    it('are 4K UHD for every codec, and every codec has an entry', () => {
        for (const c of CODECS) {
            expect(encoderLimitsFor(c)).toEqual({ maxWidth: UHD_WIDTH, maxHeight: UHD_HEIGHT, maxPixels: UHD_PIXELS });
        }
        expect(UHD_PIXELS).toBe(8_294_400);
    });
});

describe('planEncode - the resolution clamp', () => {
    it.each(CODECS)('%s: no display of any size ever yields an encode above the limits', (codec) => {
        const lim = encoderLimitsFor(codec);
        for (const [, w, h] of DISPLAYS) {
            const p = planEncode(codec, w, h);
            expect(p.width).toBeLessThanOrEqual(lim.maxWidth);
            expect(p.height).toBeLessThanOrEqual(lim.maxHeight);
            expect(p.width * p.height).toBeLessThanOrEqual(lim.maxPixels);
            expect(p.width % 2).toBe(0);
            expect(p.height % 2).toBe(0);
            // aspect preserved to within rounding to even
            expect(Math.abs(p.width / p.height - w / h)).toBeLessThan(0.05 * (w / h));
        }
    });

    it.each(CODECS)('%s: displays within the limits are sent as captured (scale 1, nothing clamped)', (codec) => {
        for (const [, w, h] of DISPLAYS.slice(0, 3)) {
            const p = planEncode(codec, w, h);
            expect(p.scale).toBe(1);
            expect(p.overLimit).toBe(false);
            expect([p.width, p.height]).toEqual([w, h]);
        }
    });

    it('the owner\'s Surround display: 7680x1440 -> 3840x720 (scale 2)', () => {
        const p = planEncode('h264', 7680, 1440);
        expect(p).toEqual({ scale: 2, width: 3840, height: 720, overLimit: true });
    });

    it('5120x1440 -> 3840x1080 (width is the binding limit), 7680x2160 -> 3840x1080', () => {
        expect(planEncode('h264', 5120, 1440)).toMatchObject({ width: 3840, height: 1080, overLimit: true });
        expect(planEncode('vp9', 7680, 2160)).toMatchObject({ scale: 2, width: 3840, height: 1080, overLimit: true });
    });

    it('an 8K 16:9 source is held to 4K by the area limit as well as width/height', () => {
        const p = planEncode('h265', 7680, 4320);
        expect(p).toMatchObject({ scale: 2, width: 3840, height: 2160 });
    });

    it('a tall, narrow display is bound by height', () => {
        // 1440x5120 portrait: height 5120 > 2160 -> scale 2.371 -> 607x2160 (even)
        const p = planEncode('vp8', 1440, 5120);
        expect(p.height).toBeLessThanOrEqual(2160);
        expect(p.overLimit).toBe(true);
        expect(p.width).toBeLessThan(p.height);
    });

    it('unknown or non-positive sizes plan scale 1 (the capture box still holds)', () => {
        for (const [w, h] of [[undefined, undefined], [0, 1440], [-5, 100], [NaN, 100], [1920, undefined]] as const) {
            expect(planEncode('h264', w as number | undefined, h as number | undefined)).toEqual({ scale: 1, width: 0, height: 0, overLimit: false });
        }
    });

    it('rounds the scale UP so rounding can never leave the result over a limit', () => {
        const p = planEncode('h264', 3841, 2161);
        expect(p.width).toBeLessThanOrEqual(UHD_WIDTH);
        expect(p.height).toBeLessThanOrEqual(UHD_HEIGHT);
        expect(p.overLimit).toBe(true);
    });
});

describe('planEncode - black-screen fallback steps', () => {
    it('step 0 adds nothing; step 1 is a 1080p-equivalent area; step 2 a 720p-equivalent area', () => {
        expect(RESOLUTION_STEP_PIXELS[0]).toBe(Infinity);
        expect(RESOLUTION_STEP_PIXELS[1]).toBe(1920 * 1080);
        expect(RESOLUTION_STEP_PIXELS[2]).toBe(1280 * 720);
        expect(MAX_RESOLUTION_STEP).toBe(2);
        const s0 = planEncode('h264', 2560, 1440, 0);
        const s1 = planEncode('h264', 2560, 1440, 1);
        const s2 = planEncode('h264', 2560, 1440, 2);
        expect([s0.width, s0.height]).toEqual([2560, 1440]);
        expect(s1.width * s1.height).toBeLessThanOrEqual(1920 * 1080);
        expect([s1.width, s1.height]).toEqual([1920, 1080]);
        expect(s2.width * s2.height).toBeLessThanOrEqual(1280 * 720);
        expect(s0.overLimit).toBe(false); // a step is not the capture exceeding the codec
    });

    it('an ultra-wide at step 1 still shrinks (3840x720 is 2.76 Mpx > 2.07 Mpx)', () => {
        const p = planEncode('h264', 7680, 1440, 1);
        expect(p.width * p.height).toBeLessThanOrEqual(1920 * 1080);
        expect(p.scale).toBeGreaterThan(2);
    });

    it('steps past the last clamp to the last (never out of range)', () => {
        expect(planEncode('h264', 2560, 1440, 99)).toEqual(planEncode('h264', 2560, 1440, MAX_RESOLUTION_STEP));
        expect(planEncode('h264', 2560, 1440, -3)).toEqual(planEncode('h264', 2560, 1440, 0));
    });
});

describe('clampCaptureBox / captureBoxFor - the box handed to the capturer', () => {
    it('the 8K "source" box becomes 3840x2160 for every codec', () => {
        for (const c of CODECS) expect(clampCaptureBox(c, { width: 7680, height: 4320 })).toEqual({ width: 3840, height: 2160 });
    });

    it('named boxes at or under 4K are unchanged', () => {
        expect(clampCaptureBox('h264', { width: 2560, height: 1440 })).toEqual({ width: 2560, height: 1440 });
        expect(clampCaptureBox('vp9', { width: 854, height: 480 })).toEqual({ width: 854, height: 480 });
    });

    it('captureBoxFor(resolution, codec) never exceeds 4K for any picker option', () => {
        for (const res of ['source', '1440p', '1080p', '720p', '480p'] as const) {
            for (const c of ['h264', 'h265', 'vp8', 'vp9'] as ScreenShareCodec[]) {
                const box = captureBoxFor(res, c);
                expect(box.width).toBeLessThanOrEqual(3840);
                expect(box.height).toBeLessThanOrEqual(2160);
            }
        }
        // ...while the picker's own box for "source" is still the 8K one (what Chromium is asked to fit within).
        expect(resolveSSResolution('source')).toEqual({ width: 7680, height: 4320 });
        expect(captureBoxFor('source', 'h264')).toEqual({ width: 3840, height: 2160 });
    });

    it('a Surround display in the clamped source box is fitted to 3840x720 by Chromium\'s aspect-preserving fit', () => {
        const box = captureBoxFor('source', 'h264');
        const fit = Math.min(1, box.width / 7680, box.height / 1440);
        expect([Math.floor(7680 * fit), Math.floor(1440 * fit)]).toEqual([3840, 720]);
    });
});

describe('evenFloor', () => {
    it('rounds down to even, minimum 2', () => {
        expect(evenFloor(721)).toBe(720);
        expect(evenFloor(720)).toBe(720);
        expect(evenFloor(1)).toBe(2);
        expect(evenFloor(0)).toBe(2);
        expect(evenFloor(3839.9)).toBe(3838);
    });
});
