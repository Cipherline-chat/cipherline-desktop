import { describe, it, expect } from 'vitest';
import {
    resolveToneParams, shaderToneVector, rolloff, tonemapScRgb, tonemapToCodes,
    legacyClipToCodes, sdrCodeToScRgb, srgbEncode, srgbDecode, pqEncode, pqDecode,
    nitsToScRgb, sdrWhiteNitsFromDisplayConfig, DEFAULT_KNEE, DEFAULT_PEAK_NITS,
    DEFAULT_SDR_WHITE_NITS,
} from './hdrTonemap';

const gray = (v: number): [number, number, number] => [v, v, v];
const toneFor = (sdrWhiteNits: number, maxLuminance = 1000) =>
    shaderToneVector(resolveToneParams({ sdrWhiteNits, maxLuminance }));

describe('transfer functions against published values', () => {
    it('PQ (SMPTE ST 2084)', () => {
        expect(pqEncode(10000)).toBeCloseTo(1, 6);
        expect(pqEncode(1000)).toBeCloseTo(0.7518, 4);
        expect(pqEncode(203)).toBeCloseTo(0.5807, 4); // BT.2408 HDR reference white
        expect(pqEncode(100)).toBeCloseTo(0.5081, 4);
        expect(pqEncode(0)).toBeLessThan(1e-6);
        for (const n of [0.1, 1, 80, 203, 600, 4000]) expect(pqDecode(pqEncode(n))).toBeCloseTo(n, 6);
    });
    it('sRGB piecewise', () => {
        expect(srgbEncode(0.18)).toBeCloseTo(0.4614, 4);
        expect(srgbEncode(0.0031308)).toBeCloseTo(0.04045, 5);
        expect(srgbEncode(1)).toBeCloseTo(1, 12);
        for (let c = 0; c <= 255; c++) expect(Math.round(srgbEncode(srgbDecode(c / 255)) * 255)).toBe(c);
    });
    it('scRGB: 1.0 is 80 nits', () => {
        expect(nitsToScRgb(80)).toBe(1);
        expect(nitsToScRgb(1000)).toBe(12.5); // the MS doc's own example
    });
    it('DISPLAYCONFIG_SDR_WHITE_LEVEL: 1000 = 80 nits', () => {
        expect(sdrWhiteNitsFromDisplayConfig(1000)).toBe(80);
        expect(sdrWhiteNitsFromDisplayConfig(2500)).toBe(200);
        expect(sdrWhiteNitsFromDisplayConfig(6000)).toBe(480);
        expect(sdrWhiteNitsFromDisplayConfig(0)).toBeNull();
        expect(sdrWhiteNitsFromDisplayConfig(NaN)).toBeNull();
    });
});

describe('resolveToneParams', () => {
    it('defaults when the display reports nothing usable', () => {
        expect(resolveToneParams({})).toEqual({ sdrWhiteNits: DEFAULT_SDR_WHITE_NITS, peakNits: DEFAULT_PEAK_NITS, knee: DEFAULT_KNEE });
        expect(resolveToneParams({ sdrWhiteNits: -1, maxLuminance: 0, knee: 3 })).toEqual({ sdrWhiteNits: 80, peakNits: 1000, knee: DEFAULT_KNEE });
    });
    it('never takes the peak closer than 2x white (dim panels / bogus EDID)', () => {
        expect(resolveToneParams({ sdrWhiteNits: 300, maxLuminance: 400 }).peakNits).toBe(600);
    });
    it('caps nonsense', () => {
        expect(resolveToneParams({ sdrWhiteNits: 50_000, maxLuminance: 1e9 })).toEqual({ sdrWhiteNits: 1000, peakNits: 10000, knee: DEFAULT_KNEE });
    });
});

describe('the shoulder', () => {
    const tone = toneFor(200);
    it('is the identity up to the knee and C1 at it', () => {
        for (const x of [0, 0.1, 0.5, DEFAULT_KNEE]) expect(rolloff(x, tone[1], tone[3])).toBe(x);
        const e = 1e-6;
        const slope = (rolloff(DEFAULT_KNEE + e, tone[1], tone[3]) - rolloff(DEFAULT_KNEE, tone[1], tone[3])) / e;
        expect(slope).toBeCloseTo(1, 3);
    });
    it('maps the display peak exactly onto output white and clips only above it', () => {
        expect(rolloff(tone[2], tone[1], tone[3])).toBeCloseTo(1, 12);
        expect(rolloff(tone[2] * 3, tone[1], tone[3])).toBe(1);
    });
    it('is strictly increasing between the knee and the peak', () => {
        let prev = -1;
        for (let x = 0; x <= tone[2]; x += 0.01) {
            const y = rolloff(x, tone[1], tone[3]);
            expect(y).toBeGreaterThan(prev);
            prev = y;
        }
    });
});

describe('HDR desktop -> SDR share (the "everything blown out" report)', () => {
    for (const W of [120, 200, 300, 480]) {
        const tone = toneFor(W);
        it(`W=${W}: SDR content up to the knee comes back with the exact code the app drew`, () => {
            const kneeCode = Math.floor(srgbEncode(DEFAULT_KNEE) * 255);
            for (let c = 0; c <= kneeCode; c++) expect(tonemapToCodes(gray(sdrCodeToScRgb(c, W)), tone)).toEqual(gray(c));
        });
        it(`W=${W}: SDR white lands at normal white (>= 240), not at 255 and not grey`, () => {
            const [white] = tonemapToCodes(gray(sdrCodeToScRgb(255, W)), tone);
            expect(white).toBeGreaterThanOrEqual(240);
            expect(white).toBeLessThan(255);
        });
    }

    it('W=200: today every mid-tone above code ~170 is clipped to 255; ours keeps it', () => {
        const W = 200;
        const tone = toneFor(W);
        const blownToday = [180, 200, 230].map(c => legacyClipToCodes(gray(sdrCodeToScRgb(c, W)))[0]);
        expect(blownToday).toEqual([255, 255, 255]);
        expect([180, 200, 230].map(c => tonemapToCodes(gray(sdrCodeToScRgb(c, W)), tone)[0])).toEqual([180, 200, 230]);
    });

    it('W=200, 1000-nit panel: highlights roll off with distinct, ordered codes instead of one flat 255', () => {
        const tone = toneFor(200, 1000);
        const nits = [200, 300, 450, 650, 1000];
        const ours = nits.map(n => tonemapToCodes(gray(nitsToScRgb(n)), tone)[0]);
        const today = nits.map(n => legacyClipToCodes(gray(nitsToScRgb(n)))[0]);
        expect(today).toEqual([255, 255, 255, 255, 255]);
        for (let i = 1; i < ours.length; i++) expect(ours[i]).toBeGreaterThan(ours[i - 1]);
        expect(ours[ours.length - 1]).toBe(255);
    });

    it('keeps hue: a bright saturated colour is scaled, not pushed to white channel-by-channel', () => {
        const tone = toneFor(200);
        // An HDR orange at ~600 nits on its brightest channel.
        const [r, g, b] = tonemapScRgb([7.5, 3, 0.5], tone);
        expect(g / r).toBeCloseTo(3 / 7.5, 6);
        expect(b / r).toBeCloseTo(0.5 / 7.5, 6);
        expect(r).toBeLessThanOrEqual(1);
    });

    it('wide-gamut negatives are clipped to 0, never wrap', () => {
        const tone = toneFor(200);
        expect(tonemapScRgb([-0.2, 1, 2], tone).every(v => v >= 0 && v <= 1)).toBe(true);
        expect(tonemapScRgb([0, 0, 0], tone)).toEqual([0, 0, 0]);
    });
});
