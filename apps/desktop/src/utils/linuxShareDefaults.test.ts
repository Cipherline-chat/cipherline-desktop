import { describe, it, expect } from 'vitest';
import {
    chromiumPathFpsCap, mergeFpsCeiling, capFrameRate, expectSoftwareEncode, planSoftwareStart,
    CHROMIUM_PORTAL_FPS_CAP, SOFTWARE_START_BUDGET,
} from './linuxShareDefaults';
import { resolveOption } from './shareEncoderOverload';

const noHw = { h264: false, vp9: false, vp8: false, h264High: false };
const ultrawide = { width: 3440, height: 1440 };

describe('Chromium-path fps cap', () => {
    it('Linux with no native path: 60', () => {
        expect(chromiumPathFpsCap({ platform: 'linux', nativeLikely: false })).toBe(CHROMIUM_PORTAL_FPS_CAP);
    });
    it('NEGATIVE (positive control for the cap): the native path keeps its higher rates', () => {
        expect(chromiumPathFpsCap({ platform: 'linux', nativeLikely: true })).toBeNull();
    });
    it('unknown answer promises nothing; Windows / macOS are untouched', () => {
        expect(chromiumPathFpsCap({ platform: 'linux', nativeLikely: null })).toBeNull();
        for (const p of ['windows', 'mac', 'win32', undefined]) expect(chromiumPathFpsCap({ platform: p, nativeLikely: false })).toBeNull();
    });
    it('capFrameRate lowers 90 to 60 only under a cap', () => {
        expect(capFrameRate(90, 60)).toBe(60);
        expect(capFrameRate(60, 60)).toBe(60);
        expect(capFrameRate(30, 60)).toBe(30);
        expect(capFrameRate(90, null)).toBe(90);
        expect(capFrameRate(90, 45)).toBe(30);
    });
    it('mergeFpsCeiling takes the tighter real ceiling', () => {
        expect(mergeFpsCeiling(null, 60)).toBe(60);
        expect(mergeFpsCeiling(75, 60)).toBe(60);
        expect(mergeFpsCeiling(0, NaN)).toBeNull();
        expect(mergeFpsCeiling(undefined, undefined)).toBeNull();
    });
});

describe('software encode expectation', () => {
    const base = { platform: 'linux', nativeLikely: false as boolean | null, hw: noHw, codec: 'vp8' as const };
    it('VP8 with no hardware VP8 on Linux is software', () => expect(expectSoftwareEncode(base)).toBe(true));
    it('NEGATIVE: hardware encoder, native path, Windows/macOS, unknown native => not software', () => {
        expect(expectSoftwareEncode({ ...base, hw: { ...noHw, vp8: true } })).toBe(false);
        expect(expectSoftwareEncode({ ...base, codec: 'h264', hw: { ...noHw, h264: true } })).toBe(false);
        expect(expectSoftwareEncode({ ...base, nativeLikely: true })).toBe(false);
        expect(expectSoftwareEncode({ ...base, nativeLikely: null })).toBe(false);
        expect(expectSoftwareEncode({ ...base, platform: 'windows' })).toBe(false);
        expect(expectSoftwareEncode({ ...base, platform: 'mac' })).toBe(false);
    });
});

describe('software start plan', () => {
    it('reproduces the report: Source@90 on 3440x1440 is far over the budget (positive control)', () => {
        const p = planSoftwareStart({ setting: { resolution: 'source', frameRate: 90 }, codec: 'vp8', source: ultrawide, maxFps: 60 });
        expect(p.overBudget).toBe(true);
        expect(p.picked.rate).toBeGreaterThan(SOFTWARE_START_BUDGET * 2);
        expect(p.suggested).not.toBeNull();
    });
    it('the suggestion fits the budget, keeps 60 fps and lands on 1080p', () => {
        const p = planSoftwareStart({ setting: { resolution: 'source', frameRate: 90 }, codec: 'vp8', source: ultrawide, maxFps: 60 });
        expect(p.suggested!.rate).toBeLessThanOrEqual(SOFTWARE_START_BUDGET);
        expect(p.suggested!.frameRate).toBe(60);
        expect(p.suggested!.resolution).toBe('1080p');
        expect(p.setting).toEqual({ resolution: '1080p', frameRate: 60 });
    });
    it('never suggests a rate above what the path can deliver', () => {
        const p = planSoftwareStart({ setting: { resolution: 'source', frameRate: 60 }, codec: 'vp8', source: ultrawide, maxFps: 60 });
        expect(p.suggested!.frameRate).toBeLessThanOrEqual(60);
    });
    it('a setting that already fits is left alone (the picker default 1080p30, 1080p60 on 16:9)', () => {
        for (const s of [{ resolution: '1080p', frameRate: 30 }, { resolution: '1080p', frameRate: 60 }] as const) {
            const p = planSoftwareStart({ setting: s, codec: 'vp8', source: { width: 1920, height: 1080 }, maxFps: 60 });
            expect(p.overBudget).toBe(false);
            expect(p.suggested).toBeNull();
            expect(p.setting).toEqual(s);
        }
    });
    it('the picker default always fits, on any source size', () => {
        for (const source of [ultrawide, { width: 3840, height: 2160 }, { width: 7680, height: 2160 }]) {
            const rate = resolveOption({ resolution: '1080p', frameRate: 30 }, 'vp8', source).rate;
            expect(rate).toBeLessThanOrEqual(SOFTWARE_START_BUDGET);
        }
    });
    it('an explicit choice is never rewritten by the plan: it only reports overBudget, the caller decides', () => {
        const p = planSoftwareStart({ setting: { resolution: 'source', frameRate: 90 }, codec: 'vp8', source: ultrawide, maxFps: 90 });
        expect(p.overBudget).toBe(true);
        expect(p.picked.resolution).toBe('source');
        expect(p.picked.frameRate).toBe(90);
    });
});
