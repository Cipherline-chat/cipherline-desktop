import { describe, expect, it, vi } from 'vitest';

const played: Array<{ src: string; vol: number }> = [];
const previewed: Array<{ src: string; vol: number }> = [];
vi.mock('../notificationSounds', () => ({
    playGeneratedSound: (src: string, vol: number) => { played.push({ src, vol }); },
    previewSound: (src: string, vol: number) => { previewed.push({ src, vol }); },
}));

const { BUILTIN_PEAK, LISTENER_MAX_LUFS, listenerGain } = await import('./playbackGain');
const { integratedLoudness, truePeak } = await import('./process');
const { ENTRANCE_VOLUME, customEntranceVolume, playCustomEntranceSound, previewCustomEntranceSound } = await import('../entrancePlayback');

const sine = (amp: number, seconds = 1, fs = 48_000) =>
    Float32Array.from({ length: Math.round(seconds * fs) }, (_, i) => amp * Math.sin(2 * Math.PI * 440 * i / fs));

describe('listener-side gain cap', () => {
    it('a hot sound is scaled down to the built-in peak and loudness ceiling', () => {
        const hot = sine(1);
        const g = listenerGain([hot], 48_000);
        expect(g).toBeLessThan(1);
        const scaled = hot.map(v => v * g);
        expect(truePeak(scaled)).toBeLessThanOrEqual(BUILTIN_PEAK + 1e-6);
        expect(integratedLoudness(scaled)).toBeLessThanOrEqual(LISTENER_MAX_LUFS + 0.01);
    });

    it('never boosts a quiet sound', () => {
        expect(listenerGain([sine(0.01)], 48_000)).toBe(1);
    });

    it('takes the hottest channel of a stereo file into account', () => {
        expect(listenerGain([sine(0.01), sine(1)], 48_000)).toBeLessThan(0.81);
    });

    it('silence or nothing -> 0 (do not play)', () => {
        expect(listenerGain([new Float32Array(4800)], 48_000)).toBe(0);
        expect(listenerGain([], 48_000)).toBe(0);
    });
});

describe('custom playback volume is never above the built-in level', () => {
    it('clamps the gain to 0..1 of ENTRANCE_VOLUME', () => {
        expect(customEntranceVolume(1)).toBe(ENTRANCE_VOLUME);
        expect(customEntranceVolume(5)).toBe(ENTRANCE_VOLUME);
        expect(customEntranceVolume(0.5)).toBeCloseTo(ENTRANCE_VOLUME / 2);
        expect(customEntranceVolume(-1)).toBe(0);
        expect(customEntranceVolume(Number.NaN)).toBe(0);
    });

    it('plays through the app sound path (prefs, device) and previews at the master level', () => {
        played.length = 0; previewed.length = 0;
        playCustomEntranceSound('blob:a', 9);
        expect(played).toEqual([{ src: 'blob:a', vol: ENTRANCE_VOLUME }]);
        playCustomEntranceSound('blob:b', 0);
        expect(played.length).toBe(1);
        previewCustomEntranceSound('blob:c', 1, { master_volume: 0.5 } as never);
        expect(previewed[0].vol).toBeCloseTo(ENTRANCE_VOLUME * 0.5);
    });
});
