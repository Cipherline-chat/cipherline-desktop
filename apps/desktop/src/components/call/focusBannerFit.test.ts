/**
 * The docked focused-stream banner's auto-fit.
 *
 * Originally camera-only, by an explicit `source !== Track.Source.Camera`
 * early return in FocusedStreamBanner — the reasoning being that "a desktop
 * capture benefits from more room, not an exact-fit box". Focusing a screen
 * share therefore kept the default 40%-of-window height and letterboxed.
 *
 * These lock the property that made lifting that restriction safe: the fit
 * has never assumed 16:9. It is `availableWidth × (videoHeight /
 * videoWidth)`, so every shape a shared screen can actually be — 16:10,
 * 4:3, 21:9 ultrawide, a single portrait window — fits by the same
 * arithmetic a camera does, and the only bars left are the ones the clamps
 * deliberately impose.
 */
import { describe, it, expect } from 'vitest';
import {
    MIN_BANNER_HEIGHT,
    MAX_BANNER_RATIO,
    clampBannerHeight,
    fitBannerHeight,
    fitBannerRatio,
} from './focusBannerFit';

const WIN = 1000;

describe('fitBannerHeight — exact fit, from the track, for any shape', () => {
    it('fits a 16:9 camera with no bar', () => {
        expect(fitBannerHeight({ availableWidth: 800, videoWidth: 1280, videoHeight: 720, windowHeight: WIN }))
            .toBe(450); // 800 × 9/16
    });

    it('fits a 16:10 screen share with no bar', () => {
        expect(fitBannerHeight({ availableWidth: 800, videoWidth: 1920, videoHeight: 1200, windowHeight: WIN }))
            .toBe(500); // 800 × 10/16 — a 16:9 assumption would have said 450
    });

    it('fits a 4:3 screen share with no bar', () => {
        expect(fitBannerHeight({ availableWidth: 600, videoWidth: 1024, videoHeight: 768, windowHeight: WIN }))
            .toBe(450);
    });

    it('honours the intrinsic size, not just its ratio (a downscaled share fits the same)', () => {
        const full = fitBannerHeight({ availableWidth: 800, videoWidth: 2560, videoHeight: 1600, windowHeight: WIN });
        const half = fitBannerHeight({ availableWidth: 800, videoWidth: 1280, videoHeight: 800, windowHeight: WIN });
        expect(full).toBe(half);
    });

    it('rounds to a whole pixel', () => {
        const h = fitBannerHeight({ availableWidth: 777, videoWidth: 1920, videoHeight: 1080, windowHeight: WIN });
        expect(h).toBe(Math.round(777 * 1080 / 1920));
        expect(Number.isInteger(h)).toBe(true);
    });
});

describe('fitBannerHeight — the two clamps, and only they, may leave a bar', () => {
    it('a 21:9 ultrawide share stops at the floor rather than collapsing', () => {
        // 300 × 9/21 ≈ 129 — under the floor.
        expect(fitBannerHeight({ availableWidth: 300, videoWidth: 3440, videoHeight: 1440, windowHeight: WIN }))
            .toBe(MIN_BANNER_HEIGHT);
    });

    it('a portrait-window share stops at the ceiling rather than eating the chat', () => {
        // 800 × 1440/900 = 1280 — way over 75% of a 1000px window.
        expect(fitBannerHeight({ availableWidth: 800, videoWidth: 900, videoHeight: 1440, windowHeight: WIN }))
            .toBe(WIN * MAX_BANNER_RATIO);
    });

    it('a wide-but-not-extreme share is still an exact fit, untouched by either clamp', () => {
        const h = fitBannerHeight({ availableWidth: 900, videoWidth: 3440, videoHeight: 1440, windowHeight: WIN })!;
        expect(h).toBe(Math.round(900 * 1440 / 3440));
        expect(h).toBeGreaterThan(MIN_BANNER_HEIGHT);
        expect(h).toBeLessThan(WIN * MAX_BANNER_RATIO);
    });
});

describe('fitBannerHeight — refuses to fit to numbers that are not real yet', () => {
    it('returns null for a <video> with no metadata (0×0)', () => {
        expect(fitBannerHeight({ availableWidth: 800, videoWidth: 0, videoHeight: 0, windowHeight: WIN })).toBeNull();
    });

    it('returns null for a host that has not been laid out', () => {
        expect(fitBannerHeight({ availableWidth: 0, videoWidth: 1280, videoHeight: 720, windowHeight: WIN })).toBeNull();
    });

    it('returns null for a degenerate 1px track rather than fitting to it', () => {
        expect(fitBannerHeight({ availableWidth: 800, videoWidth: 1, videoHeight: 1, windowHeight: WIN })).toBeNull();
    });

    it('returns null before the window height is known', () => {
        expect(fitBannerHeight({ availableWidth: 800, videoWidth: 1280, videoHeight: 720, windowHeight: 0 })).toBeNull();
    });
});

describe('fitBannerRatio', () => {
    it('is the fitted height over the window height, so it survives an OS resize', () => {
        const input = { availableWidth: 800, videoWidth: 1920, videoHeight: 1200, windowHeight: WIN };
        expect(fitBannerRatio(input)).toBe(fitBannerHeight(input)! / WIN);
    });

    it('propagates null rather than producing NaN', () => {
        expect(fitBannerRatio({ availableWidth: 800, videoWidth: 0, videoHeight: 0, windowHeight: WIN })).toBeNull();
    });
});

describe('clampBannerHeight — one clamp for the auto fit and the drag alike', () => {
    it('holds the floor', () => {
        expect(clampBannerHeight(10, WIN)).toBe(MIN_BANNER_HEIGHT);
    });

    it('holds the ceiling', () => {
        expect(clampBannerHeight(99999, WIN)).toBe(WIN * MAX_BANNER_RATIO);
    });

    it('passes an in-range height through, rounded', () => {
        expect(clampBannerHeight(432.6, WIN)).toBe(433);
    });
});
