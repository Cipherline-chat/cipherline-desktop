import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromiumLoopbackAudioMode } from './share-platform';

/**
 * Linux, 2026-11-02, measured on Electron 43.2.0 (X11 under Xvfb, PulseAudio running):
 * answering getDisplayMedia with audio 'loopbackWithMute' did not settle in 25 s (or failed), 'loopback'
 * settles in ~0.2 s. These pin that Linux is never asked for the first, and that the
 * Windows / macOS answers are exactly what main.ts used to compute inline.
 */
describe('chromiumLoopbackAudioMode', () => {
    const ask = (platform: string, o: { withAudio?: boolean; isWindow?: boolean; nativeAudioAvailable?: boolean } = {}) =>
        chromiumLoopbackAudioMode({ platform, withAudio: true, isWindow: false, nativeAudioAvailable: false, ...o });

    it('Windows: a screen with audio gets loopbackWithMute (unchanged)', () => {
        expect(ask('win32')).toBe('loopbackWithMute');
    });
    it('Windows: a single window has no per-window loopback; the native addon owns audio when present (unchanged)', () => {
        expect(ask('win32', { isWindow: true })).toBeUndefined();
        expect(ask('win32', { nativeAudioAvailable: true })).toBeUndefined();
    });
    it('Windows: no audio asked, none given (unchanged)', () => {
        expect(ask('win32', { withAudio: false })).toBeUndefined();
    });
    it('macOS: Electron documents loopback as Windows-only, so none is ever requested (unchanged)', () => {
        expect(ask('darwin')).toBeUndefined();
        expect(ask('darwin', { isWindow: true })).toBeUndefined();
    });
    it('Linux: never loopbackWithMute, whatever is asked', () => {
        for (const isWindow of [false, true]) {
            for (const nativeAudioAvailable of [false, true]) {
                expect(ask('linux', { isWindow, nativeAudioAvailable })).toBeUndefined();
            }
        }
    });
    it('main.ts routes the answer through this function and no longer names the mode inline', () => {
        const main = readFileSync(resolve(__dirname, 'main.ts'), 'utf8');
        expect(main).toContain('chromiumLoopbackAudioMode({');
        expect(main).not.toMatch(/\?\s*\(isWindow \? undefined : 'loopbackWithMute'\)/);
    });
    it('control: the matcher would catch the old inline form', () => {
        expect("effectiveWithAudio && platform !== 'darwin' ? (isWindow ? undefined : 'loopbackWithMute') : undefined")
            .toMatch(/\?\s*\(isWindow \? undefined : 'loopbackWithMute'\)/);
    });
});
