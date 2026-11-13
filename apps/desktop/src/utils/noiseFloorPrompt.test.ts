import { describe, it, expect } from 'vitest';
import {
    NoiseFloorWatcher, noisePromptApplies, noisePromptAllowed, snoozeNoisePrompt,
    NOISE_FLOOR_WINDOW_S, NOISE_PROMPT_SNOOZE_MS, NOISE_PROMPT_KEY,
} from './noiseFloorPrompt';

const feed = (w: NoiseFloorWatcher, db: number | null, n: number, applies = true): boolean[] =>
    Array.from({ length: n }, () => w.observe(db, applies));

describe('NoiseFloorWatcher', () => {
    it('a noisy room (floor -42) fires exactly once, after the full window', () => {
        const w = new NoiseFloorWatcher();
        const r = feed(w, -42, NOISE_FLOOR_WINDOW_S + 10);
        expect(r.indexOf(true)).toBe(NOISE_FLOOR_WINDOW_S - 1);
        expect(r.filter(Boolean)).toHaveLength(1); // once per call
    });
    it('CONTROL: a quiet room (-70) never fires', () => {
        expect(feed(new NoiseFloorWatcher(), -70, 200).some(Boolean)).toBe(false);
    });
    it('a single high second or two does not fire (a door slam), a sustained rise does', () => {
        const w = new NoiseFloorWatcher();
        const seq = [...Array(10).fill(-70), -40, -40, ...Array(40).fill(-70)];
        expect(seq.map(d => w.observe(d, true)).some(Boolean)).toBe(false);
    });
    it('tolerates one quiet second inside the window', () => {
        const w = new NoiseFloorWatcher();
        const seq = [...Array(12).fill(-42), -70, ...Array(12).fill(-42)];
        expect(seq.map(d => w.observe(d, true)).some(Boolean)).toBe(true);
    });
    it('silence / no input (null, -Infinity) counts as quiet', () => {
        expect(feed(new NoiseFloorWatcher(), null, 100).some(Boolean)).toBe(false);
        expect(feed(new NoiseFloorWatcher(), -Infinity, 100).some(Boolean)).toBe(false);
    });
    it('when Strong is selected the window is discarded: switching back later needs a fresh full window', () => {
        const w = new NoiseFloorWatcher();
        feed(w, -42, 20);
        feed(w, -42, 5, false);               // strong on
        expect(feed(w, -42, 10).some(Boolean)).toBe(false); // only 10 s since
        expect(feed(w, -42, 15).some(Boolean)).toBe(true);
    });
    it('exactly at the threshold (-50) is not "high"; just above is', () => {
        expect(feed(new NoiseFloorWatcher(), -50, 60).some(Boolean)).toBe(false);
        expect(feed(new NoiseFloorWatcher(), -49.9, 60).some(Boolean)).toBe(true);
    });
});

describe('noisePromptApplies', () => {
    it('Light and Off yes; Strong no', () => {
        expect(noisePromptApplies({ noiseSuppression: true, noiseSuppressionMode: 'light' })).toBe(true);
        expect(noisePromptApplies({ noiseSuppression: false, noiseSuppressionMode: 'strong' })).toBe(true);
        expect(noisePromptApplies({ noiseSuppression: true, noiseSuppressionMode: 'strong' })).toBe(false);
    });
});

describe('snooze (7 days, per device)', () => {
    const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
    it('allowed with no stamp; blocked right after; allowed again after 7 days', () => {
        const st = mem(); const now = 1_000_000;
        expect(noisePromptAllowed(now, st)).toBe(true);
        snoozeNoisePrompt(now, st);
        expect(st.m.has(NOISE_PROMPT_KEY)).toBe(true);
        expect(noisePromptAllowed(now + NOISE_PROMPT_SNOOZE_MS - 1, st)).toBe(false);
        expect(noisePromptAllowed(now + NOISE_PROMPT_SNOOZE_MS + 1, st)).toBe(true);
    });
    it('a garbage stamp or a throwing store never blocks the prompt', () => {
        const st = mem(); st.m.set(NOISE_PROMPT_KEY, 'abc');
        expect(noisePromptAllowed(5, st)).toBe(true);
        expect(noisePromptAllowed(5, { getItem: () => { throw new Error('x'); }, setItem: () => { /* */ } })).toBe(true);
    });
});
