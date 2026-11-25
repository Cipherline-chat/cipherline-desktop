import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./secureLocalStore', () => ({
    default: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

import {
    CALL_SOUND_CATEGORIES, DEFAULT_SOUND_PREFS, isCallSoundSilencedByDnd, playGeneratedSound,
    playLoopingSound, playSound, setCallSoundDndProbe, silenceActiveCallLoopsIfDnd,
    type SoundCategory, type SoundsPrefs,
} from './notificationSounds';

const created: FakeAudio[] = [];
let plays = 0;
class FakeAudio {
    src = ''; volume = 1; currentTime = 0; loop = false; paused = false;
    play = vi.fn(() => { plays++; return Promise.resolve(); });
    pause = vi.fn(() => { this.paused = true; });
    setSinkId = vi.fn(() => Promise.resolve());
    constructor(src?: string) { if (src) this.src = src; created.push(this); }
}

const PREFS = { sounds_enabled: true, master_volume: 1, sounds: {} } as unknown as SoundsPrefs;
const NON_CALL = (Object.keys(DEFAULT_SOUND_PREFS) as SoundCategory[]).filter(c => !CALL_SOUND_CATEGORIES.has(c));
let dnd = false;

beforeEach(() => {
    created.length = 0; plays = 0;
    dnd = false;
    (globalThis as unknown as { Audio: unknown }).Audio = FakeAudio;
    setCallSoundDndProbe(() => dnd);
});

describe('call sounds under Do Not Disturb', () => {
    it('every call cue is silent while DND, and audible when not', () => {
        for (const cat of CALL_SOUND_CATEGORIES) {
            created.length = 0; plays = 0; dnd = false;
            playSound(cat, PREFS);
            expect(plays, `${cat} audible off-DND`).toBeGreaterThan(0);
            created.length = 0; plays = 0; dnd = true;
            playSound(cat, PREFS);
            expect(plays, `${cat} silent on DND`).toBe(0);
        }
    });

    it('non-call cues are untouched by the call gate', () => {
        dnd = true;
        expect(NON_CALL.length).toBeGreaterThan(0);
        for (const cat of NON_CALL) expect(isCallSoundSilencedByDnd(cat)).toBe(false);
    });

    it('covers every call-shaped category (guards a new cue being forgotten)', () => {
        const callish = (Object.keys(DEFAULT_SOUND_PREFS) as SoundCategory[])
            .filter(c => /call|ring|join|leave|mute|deafen|camera|screenshare|stream_viewer|annotation/.test(c));
        for (const c of callish) expect(CALL_SOUND_CATEGORIES.has(c), c).toBe(true);
    });

    it('incoming ring and outgoing ringback loops do not start on DND', () => {
        dnd = true;
        playLoopingSound('call', PREFS)();
        playLoopingSound('ringing', PREFS)();
        expect(created.length).toBe(0);
        dnd = false;
        const stop = playLoopingSound('call', PREFS);
        expect(created.length).toBe(1);
        expect(created[0].loop).toBe(true);
        stop();
    });

    it('flipping to DND mid-ring stops the running loop', () => {
        const stop = playLoopingSound('call', PREFS);
        const el = created[0];
        expect(el.paused).toBe(false);
        dnd = true;
        silenceActiveCallLoopsIfDnd();
        expect(el.pause).toHaveBeenCalled();
        expect(el.loop).toBe(false);
        expect(() => stop()).not.toThrow();
    });

    it('does not stop loops when not on DND', () => {
        const stop = playLoopingSound('ringing', PREFS);
        silenceActiveCallLoopsIfDnd();
        expect(created[0].pause).not.toHaveBeenCalled();
        stop();
    });

    it('generated entrance cues (a join cue) are silent on DND', async () => {
        dnd = true;
        expect(await playGeneratedSound('blob:x', 0.5, PREFS)).toBe(true);
        expect(created.length + plays).toBe(0);
        dnd = false;
        await playGeneratedSound('blob:x', 0.5, PREFS);
        expect(plays).toBeGreaterThan(0);
    });

    it('a throwing probe fails open (audible), never crashes playback', () => {
        setCallSoundDndProbe(() => { throw new Error('x'); });
        playSound('join', PREFS);
        expect(plays).toBeGreaterThan(0);
    });
});
