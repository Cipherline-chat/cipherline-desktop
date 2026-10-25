/**
 * Entrance sounds: ten short, built-in cues a person can pick to be played to
 * everyone else in a call when they join. Synthesised here from a few lines of
 * maths each - no audio files, no uploads, nothing with a licence to check.
 *
 * `ENTRANCE_SOUNDS` ids are MIRRORED BY HAND in
 * apps/api/src/call-personalization/call-personalization.rules.ts (which
 * validates what the server stores); entranceSounds.test.ts reads that file
 * and fails on drift. Ids are stable and never reused.
 *
 * Rendering is deterministic pure JS (a fixed-seed noise source), so it is
 * unit-tested in node; the WAV bytes are played through the app's sound
 * utility (notificationSounds.playGeneratedSound), which is what makes them
 * follow the chosen output device and master volume.
 */

import { isCustomEntranceSoundId } from './customEntranceSound/constants';

export const ENTRANCE_SAMPLE_RATE = 24000;
/** Hard ceiling on any entrance sound, ms. */
export const ENTRANCE_MAX_MS = 1500;

export interface EntranceSoundDef { id: string; label: string; blurb: string }

export const ENTRANCE_SOUNDS: readonly EntranceSoundDef[] = [
    { id: 'bubble-pop',      label: 'Bubble pop',      blurb: 'A quick rising blip' },
    { id: 'sonar-ping',      label: 'Sonar ping',      blurb: 'One clear ping with an echo' },
    { id: 'tide-chime',      label: 'Tide chime',      blurb: 'Two soft bell notes' },
    { id: 'glass-drop',      label: 'Glass drop',      blurb: 'A bright glassy tick' },
    { id: 'kelp-pluck',      label: 'Kelp pluck',      blurb: 'A plucked string' },
    { id: 'wave-swell',      label: 'Wave swell',      blurb: 'A gentle wash of surf' },
    { id: 'deep-bell',       label: 'Deep bell',       blurb: 'A low, long bell' },
    { id: 'coral-arp',       label: 'Coral arpeggio',  blurb: 'Four rising notes' },
    { id: 'lantern-twinkle', label: 'Lantern twinkle', blurb: 'A sprinkle of high sparks' },
    { id: 'soft-knock',      label: 'Soft knock',      blurb: 'Two polite knocks' },
];

export const ENTRANCE_SOUND_IDS: readonly string[] = ENTRANCE_SOUNDS.map(s => s.id);

export function isEntranceSoundId(v: unknown): v is string {
    return typeof v === 'string' && ENTRANCE_SOUND_IDS.includes(v);
}

/**
 * What a person's `entrance_sound` may be: a catalog id, or `custom:<id>` for
 * a custom sound (utils/customEntranceSound/). A build that predates custom
 * sounds only knows isEntranceSoundId, so it reads a custom value as no sound.
 */
export function isEntranceSoundValue(v: unknown): v is string {
    return isEntranceSoundId(v) || isCustomEntranceSoundId(v);
}

// ── synthesis ───────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

/** Mix a decaying sine (with optional partials) into `buf` starting at `startS`. */
function note(
    buf: Float32Array, startS: number, freq: number, durS: number, amp: number,
    decay: number, partials: ReadonlyArray<readonly [number, number]> = [[1, 1]], attackS = 0.004,
): void {
    const sr = ENTRANCE_SAMPLE_RATE;
    const start = Math.floor(startS * sr);
    const n = Math.floor(durS * sr);
    for (let i = 0; i < n && start + i < buf.length; i++) {
        const t = i / sr;
        const env = Math.min(1, t / attackS) * Math.exp(-decay * t);
        let s = 0;
        for (const [mult, a] of partials) s += a * Math.sin(TWO_PI * freq * mult * t);
        buf[start + i] += amp * env * s;
    }
}

/** Deterministic noise in [-1, 1) (LCG; no Math.random, so renders are identical). */
function noise(seed: number): () => number {
    let x = seed >>> 0;
    return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2147483648 - 1; };
}

function finish(buf: Float32Array): Float32Array {
    const fade = Math.floor(0.012 * ENTRANCE_SAMPLE_RATE);
    for (let i = 0; i < fade; i++) { buf[buf.length - 1 - i] *= i / fade; buf[i] *= Math.min(1, i / 24); }
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    const g = peak > 0 ? 0.8 / peak : 1;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
    return buf;
}

const alloc = (seconds: number) => new Float32Array(Math.floor(seconds * ENTRANCE_SAMPLE_RATE));

const RECIPES: Record<string, () => Float32Array> = {
    'bubble-pop': () => {
        const b = alloc(0.28);
        const sr = ENTRANCE_SAMPLE_RATE;
        let phase = 0;
        for (let i = 0; i < Math.floor(0.12 * sr); i++) {
            const t = i / sr;
            phase += TWO_PI * (320 + 900 * (t / 0.12)) / sr;
            b[i] += Math.sin(phase) * Math.exp(-14 * t);
        }
        note(b, 0.1, 880, 0.15, 0.35, 22);
        return b;
    },
    'sonar-ping': () => {
        const b = alloc(1.15);
        note(b, 0, 1318.5, 0.7, 1, 6.5);
        note(b, 0.36, 1318.5, 0.7, 0.32, 7.5);
        return b;
    },
    'tide-chime': () => {
        const b = alloc(0.95);
        const bell = [[1, 1], [2.01, 0.35], [3.9, 0.12]] as const;
        note(b, 0, 659.3, 0.6, 0.8, 5.5, bell);
        note(b, 0.17, 987.8, 0.75, 0.8, 4.5, bell);
        return b;
    },
    'glass-drop': () => {
        const b = alloc(0.5);
        note(b, 0, 2093, 0.4, 0.7, 11, [[1, 1], [1.5, 0.4], [2.76, 0.18]], 0.001);
        note(b, 0.045, 3136, 0.3, 0.35, 15, [[1, 1]], 0.001);
        return b;
    },
    'kelp-pluck': () => {
        // Karplus-Strong string, 196 Hz
        const sr = ENTRANCE_SAMPLE_RATE;
        const b = alloc(0.7);
        const period = Math.round(sr / 196);
        const rand = noise(7);
        const line = new Float32Array(period).map(() => rand());
        for (let i = 0; i < b.length; i++) {
            const j = i % period;
            const cur = line[j];
            b[i] = cur;
            line[j] = 0.5 * (cur + line[(j + 1) % period]) * 0.996;
        }
        return b;
    },
    'wave-swell': () => {
        const b = alloc(1.3);
        const rand = noise(11);
        let lp = 0;
        for (let i = 0; i < b.length; i++) {
            const x = i / b.length;
            const swell = Math.pow(Math.sin(Math.PI * x), 2);
            lp += (rand() - lp) * (0.04 + 0.14 * swell); // brightens as the wave peaks
            b[i] = lp * swell;
        }
        return b;
    },
    'deep-bell': () => {
        const b = alloc(1.45);
        note(b, 0, 220, 1.4, 0.9, 2.6, [[1, 1], [2, 0.5], [2.76, 0.3], [5.4, 0.12]], 0.006);
        return b;
    },
    'coral-arp': () => {
        const b = alloc(0.62);
        [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => note(b, k * 0.085, f, 0.3, 0.7, 11, [[1, 1], [2, 0.2]]));
        return b;
    },
    'lantern-twinkle': () => {
        const b = alloc(0.8);
        [[0, 2637], [0.09, 3136], [0.19, 2349], [0.3, 3951], [0.43, 3136]].forEach(([s, f], k) =>
            note(b, s, f, 0.25, 0.5 - k * 0.04, 14, [[1, 1], [2, 0.12]], 0.001));
        return b;
    },
    'soft-knock': () => {
        const b = alloc(0.4);
        const sr = ENTRANCE_SAMPLE_RATE;
        for (const start of [0, 0.15]) {
            let phase = 0;
            const s0 = Math.floor(start * sr);
            for (let i = 0; i < Math.floor(0.1 * sr); i++) {
                const t = i / sr;
                phase += TWO_PI * (170 - 700 * t) / sr; // pitch falls: a wooden thump
                b[s0 + i] += Math.sin(phase) * Math.exp(-38 * t) * (start ? 0.8 : 1);
            }
        }
        return b;
    },
};

const rendered = new Map<string, Float32Array>();

/** Mono float samples (-1..1) at ENTRANCE_SAMPLE_RATE for a catalog id, or null. */
export function renderEntranceSound(id: string): Float32Array | null {
    const recipe = RECIPES[id];
    if (!recipe) return null;
    let s = rendered.get(id);
    if (!s) { s = finish(recipe()); rendered.set(id, s); }
    return s;
}

export function entranceSoundDurationMs(id: string): number {
    const s = renderEntranceSound(id);
    return s ? Math.round((s.length / ENTRANCE_SAMPLE_RATE) * 1000) : 0;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate = ENTRANCE_SAMPLE_RATE) {
    const bytes = new Uint8Array(new ArrayBuffer(44 + samples.length * 2));
    const v = new DataView(bytes.buffer);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(44 + i * 2, Math.round(s * 32767), true);
    }
    return bytes;
}

const urls = new Map<string, string>();

/** `blob:` URL of the sound's WAV (cached per id; CSP media-src allows blob:), or null. */
export function entranceSoundUrl(id: string): string | null {
    const hit = urls.get(id);
    if (hit) return hit;
    const s = renderEntranceSound(id);
    if (!s || typeof URL === 'undefined' || typeof Blob === 'undefined') return null;
    const url = URL.createObjectURL(new Blob([encodeWav(s)], { type: 'audio/wav' }));
    urls.set(id, url);
    return url;
}
