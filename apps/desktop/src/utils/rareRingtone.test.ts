import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./secureLocalStore', () => {
    const mem = new Map<string, string>();
    return { default: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } } };
});
const recordEggFound = vi.fn();
vi.mock('./eggProgress', () => ({ recordEggFound: (id: string) => recordEggFound(id) }));

import type { SoundsPrefs, SoundCategory } from './notificationSounds';

interface FakeAudio { src: string; volume: number; loop: boolean; play: ReturnType<typeof vi.fn> }
let built: FakeAudio[] = [];
let sounds: typeof import('./notificationSounds');
let rare: typeof import('./rareRingtone');

beforeEach(async () => {
    built = [];
    recordEggFound.mockClear();
    class MockAudio {
        src = ''; volume = 1; currentTime = 0; loop = false;
        setSinkId = vi.fn(() => Promise.resolve());
        play = vi.fn(() => Promise.resolve());
        pause = vi.fn();
        addEventListener = () => {};
        constructor(src?: string) { if (src) this.src = src; built.push(this as unknown as FakeAudio); }
    }
    (globalThis as unknown as { Audio: unknown }).Audio = MockAudio;
    vi.resetModules();
    sounds = await import('./notificationSounds');
    rare = await import('./rareRingtone');
});

const prefs = (over: Partial<SoundsPrefs> = {}, callFile?: string, callVolume = 1): SoundsPrefs => {
    const p: SoundsPrefs = {
        sounds_enabled: true,
        master_volume: 0.8,
        sounds: Object.fromEntries(
            (Object.keys(sounds.DEFAULT_SOUNDS) as SoundCategory[]).map(c => [c, { enabled: true, volume: 1, file: sounds.DEFAULT_SOUNDS[c] }]),
        ) as SoundsPrefs['sounds'],
        ...over,
    };
    if (callFile) p.sounds.call = { ...p.sounds.call, file: callFile };
    p.sounds.call = { ...p.sounds.call, volume: callVolume };
    return p;
};
const always = () => rare.rareRingtoneAlternate(() => 0);
const never = () => rare.rareRingtoneAlternate(() => 0.5);

describe('rareRingtoneRoll', () => {
    it('is exactly one in a thousand', () => {
        expect(rare.RARE_RINGTONE_ODDS).toBe(1000);
        expect(rare.rareRingtoneRoll(() => 0)).toBe(true);
        expect(rare.rareRingtoneRoll(() => 0.0009999)).toBe(true);
        expect(rare.rareRingtoneRoll(() => 0.001)).toBe(false);
        expect(rare.rareRingtoneRoll(() => 0.5)).toBe(false);
        expect(rare.rareRingtoneRoll(() => 0.999999)).toBe(false);
    });
    it('hits about 0.1% over many real rolls', () => {
        let hits = 0;
        const n = 200_000;
        for (let i = 0; i < n; i++) if (rare.rareRingtoneRoll()) hits++;
        expect(hits).toBeGreaterThan(n * 0.0004);
        expect(hits).toBeLessThan(n * 0.002);
    });
});

describe('playLoopingSound with the rare alternate', () => {
    it('plays the alternate on a winning roll, at the normal ring volume, and counts the egg', () => {
        sounds.playLoopingSound('call', prefs({}, undefined, 0.5), { alternate: always() });
        expect(built).toHaveLength(1);
        expect(built[0].src).toBe(rare.RARE_RINGTONE_FILE);
        expect(built[0].loop).toBe(true);
        expect(built[0].volume).toBeCloseTo(0.5 * 0.8, 5);
        expect(recordEggFound).toHaveBeenCalledWith('rare-ringtone');
    });

    it('plays the normal ringtone, and no egg, on a losing roll', () => {
        sounds.playLoopingSound('call', prefs(), { alternate: never() });
        expect(built[0].src).toBe(sounds.DEFAULT_SOUNDS.call);
        expect(recordEggFound).not.toHaveBeenCalled();
    });

    it('is identical to today with no alternate passed', () => {
        sounds.playLoopingSound('call', prefs());
        expect(built[0].src).toBe(sounds.DEFAULT_SOUNDS.call);
    });

    it('stays silent, never rolls and never counts when sounds are off', () => {
        const roll = vi.fn(() => true);
        sounds.playLoopingSound('call', prefs({ sounds_enabled: false }), { alternate: { file: rare.RARE_RINGTONE_FILE, roll, onPlay: () => recordEggFound('x') } });
        expect(built).toHaveLength(0);
        expect(roll).not.toHaveBeenCalled();
        expect(recordEggFound).not.toHaveBeenCalled();
    });

    it('respects the call category being off or at zero volume', () => {
        const off = prefs();
        off.sounds.call = { ...off.sounds.call, enabled: false };
        sounds.playLoopingSound('call', off, { alternate: always() });
        sounds.playLoopingSound('call', prefs({}, undefined, 0), { alternate: always() });
        expect(built).toHaveLength(0);
        expect(recordEggFound).not.toHaveBeenCalled();
    });

    it('never replaces a ringtone the user chose themselves', () => {
        const roll = vi.fn(() => true);
        sounds.playLoopingSound('call', prefs({}, '/home/me/my-ring.wav'), { alternate: { file: rare.RARE_RINGTONE_FILE, roll } });
        expect(built[0].src).toBe('/home/me/my-ring.wav');
        expect(roll).not.toHaveBeenCalled();
    });

    it('does not count the egg when the audio element cannot be built', () => {
        (globalThis as unknown as { Audio: unknown }).Audio = class { constructor() { throw new Error('no audio'); } };
        const stop = sounds.playLoopingSound('call', prefs(), { alternate: always() });
        expect(() => stop()).not.toThrow();
        expect(recordEggFound).not.toHaveBeenCalled();
    });
});
