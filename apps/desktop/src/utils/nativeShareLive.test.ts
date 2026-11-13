import { describe, it, expect } from 'vitest';
import { applyNativeToSenderHud, nativeEncoderLabel, setNativeShareLive, getNativeShareLive, isNativeShareLive } from './nativeShareLive';
import type { SenderHudStats } from './streamStatsHud';

const stand: SenderHudStats = { hardware: false, encoder: 'libx264', encodedFps: 30, encodedWidth: 128, encodedHeight: 72, captureWidth: 128, captureHeight: 72, codec: 'video/H264', sendMbps: 22 };

describe('native share HUD overlay', () => {
    it('with no live native share the sender stats pass through untouched', () => {
        expect(applyNativeToSenderHud(stand, null)).toBe(stand);
    });
    it('replaces the stand-in track\'s numbers with the helper\'s: encoder name, hardware, fps, resolution', () => {
        const out = applyNativeToSenderHud(stand, { encoder: 'nvenc', width: 3440, height: 1440, fps: 90, kbps: 28000, encMsP95: 4.1 });
        expect(out).toMatchObject({ encoder: 'NVENC (native)', hardware: true, encodedFps: 90, encodedWidth: 3440, encodedHeight: 1440, captureWidth: 3440, sendMbps: 28, encodeMs: 4.1 });
    });
    it('NEGATIVE control: the stand-in values would otherwise be shown (128x72, software)', () => {
        expect(stand.encodedWidth).toBe(128);
        expect(stand.hardware).toBe(false);
    });
    it('a throwing provider reads as "no native share"', () => {
        setNativeShareLive(() => { throw new Error('gone'); });
        expect(getNativeShareLive()).toBeNull();
        setNativeShareLive(null);
        expect(getNativeShareLive()).toBeNull();
        expect(nativeEncoderLabel('')).toBe('native');
    });
});

describe('isNativeShareLive (the sharer\'s own tile on a native share)', () => {
    it('a live native share draws the helper\'s thumbnail instead of the stand-in track (no long explanation text)', () => {
        expect(isNativeShareLive({ encoder: 'nvenc', width: 3440, height: 1440, fps: 90, kbps: 5000, encMsP95: 6 })).toBe(true);
    });
    it('NEGATIVE CONTROL: with no native share live the normal track is drawn', () => {
        expect(isNativeShareLive(null)).toBe(false);
    });
});
