import { describe, it, expect } from 'vitest';
import { clamp, normalizeHex, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, hexToHsv, hsvToHex } from './colourMath';

describe('clamp', () => {
    it('bounds a value and treats non-finite as the minimum', () => {
        expect(clamp(5, 0, 10)).toBe(5);
        expect(clamp(-1, 0, 10)).toBe(0);
        expect(clamp(11, 0, 10)).toBe(10);
        expect(clamp(0, 0, 10)).toBe(0);
        expect(clamp(10, 0, 10)).toBe(10);
        expect(clamp(NaN, 3, 10)).toBe(3);
        expect(clamp(Infinity, 3, 10)).toBe(3);
    });
});

describe('normalizeHex', () => {
    it('accepts 6 and 3 digits with or without # and any case', () => {
        expect(normalizeHex('#25E0C8')).toBe('#25e0c8');
        expect(normalizeHex('25e0c8')).toBe('#25e0c8');
        expect(normalizeHex('#abc')).toBe('#aabbcc');
        expect(normalizeHex('ABC')).toBe('#aabbcc');
        expect(normalizeHex('  #FfF  ')).toBe('#ffffff');
        expect(normalizeHex('#000')).toBe('#000000');
    });
    it('rejects garbage rather than coercing it', () => {
        for (const bad of ['', '#', '#12', '#1234', '#12345', '#1234567', '#ggg', 'rgb(1,2,3)', '##abc', '#abc;', 'red', '#12 34 56']) {
            expect(normalizeHex(bad), bad).toBeNull();
        }
        expect(normalizeHex(undefined)).toBeNull();
        expect(normalizeHex(null)).toBeNull();
        expect(normalizeHex(123456)).toBeNull();
    });
});

describe('hex <-> rgb', () => {
    it('converts known values', () => {
        expect(hexToRgb('#25e0c8')).toEqual({ r: 37, g: 224, b: 200 });
        expect(hexToRgb('#000')).toEqual({ r: 0, g: 0, b: 0 });
        expect(hexToRgb('nope')).toBeNull();
        expect(rgbToHex({ r: 255, g: 0, b: 128 })).toBe('#ff0080');
    });
    it('clamps and rounds out-of-range channels', () => {
        expect(rgbToHex({ r: 300, g: -5, b: 127.6 })).toBe('#ff0080');
    });
    it('round-trips every grey and a sweep of colours', () => {
        for (let i = 0; i < 256; i++) {
            const hex = rgbToHex({ r: i, g: i, b: i });
            expect(hexToRgb(hex)).toEqual({ r: i, g: i, b: i });
        }
        for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
            expect(hexToRgb(rgbToHex({ r, g, b }))).toEqual({ r, g, b });
        }
    });
});

describe('rgb <-> hsv', () => {
    it('matches the primaries and secondaries', () => {
        expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
        expect(rgbToHsv({ r: 0, g: 255, b: 0 }).h).toBe(120);
        expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBe(240);
        expect(rgbToHsv({ r: 255, g: 255, b: 0 }).h).toBe(60);
        expect(rgbToHsv({ r: 0, g: 255, b: 255 }).h).toBe(180);
        expect(rgbToHsv({ r: 255, g: 0, b: 255 }).h).toBe(300);
    });
    it('black and white have no saturation, black has no value', () => {
        expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
        expect(rgbToHsv({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 1 });
        expect(rgbToHsv({ r: 128, g: 128, b: 128 }).s).toBe(0);
    });
    it('hue stays in [0, 360) for negative-sector reds', () => {
        const { h } = rgbToHsv({ r: 255, g: 0, b: 10 });
        expect(h).toBeGreaterThan(350);
        expect(h).toBeLessThan(360);
    });
    it('hsvToRgb handles each sector boundary and the 0/360 seam', () => {
        expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
        expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
        expect(hsvToRgb({ h: 60, s: 1, v: 1 })).toEqual({ r: 255, g: 255, b: 0 });
        expect(hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 0 });
        expect(hsvToRgb({ h: 180, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 255 });
        expect(hsvToRgb({ h: 240, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
        expect(hsvToRgb({ h: 300, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 255 });
        expect(hsvToRgb({ h: 200, s: 0, v: 0.5 })).toEqual({ r: 128, g: 128, b: 128 });
        expect(hsvToRgb({ h: 200, s: 1, v: 0 })).toEqual({ r: 0, g: 0, b: 0 });
    });
    it('clamps out-of-range input', () => {
        expect(hsvToRgb({ h: -20, s: 2, v: 2 })).toEqual({ r: 255, g: 0, b: 0 });
        expect(hsvToRgb({ h: 999, s: -1, v: 0.5 })).toEqual({ r: 128, g: 128, b: 128 });
    });
});

describe('hex <-> hsv round trip', () => {
    it('is exact across a sample of the colour cube', () => {
        for (let r = 0; r < 256; r += 5) for (let g = 0; g < 256; g += 5) for (let b = 0; b < 256; b += 5) {
            const hex = rgbToHex({ r, g, b });
            const hsv = hexToHsv(hex)!;
            expect(hsvToHex(hsv), hex).toBe(hex);
        }
    });
    it('is exact for the brand palette', () => {
        for (const hex of ['#25e0c8', '#3bead6', '#5e8ee0', '#ffc94d', '#ff6b5e', '#ff8fb1', '#4ade80', '#a78bfa', '#f4f7ff', '#243056', '#000000', '#ffffff']) {
            expect(hsvToHex(hexToHsv(hex)!)).toBe(hex);
        }
    });
    it('returns null for an invalid hex', () => {
        expect(hexToHsv('zzz')).toBeNull();
    });
});
