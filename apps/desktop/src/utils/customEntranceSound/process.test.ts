import { describe, expect, it } from 'vitest';
import {
    applyFades, downmix, gainToDb, integratedLoudness, kWeightingFilters, limitTruePeak, processClip,
    samplePeak, trimWindow, truePeak, waveformPeaks,
} from './process';
import { MAX_CLIP_SAMPLES, SAMPLE_RATE, TARGET_LUFS, TRUE_PEAK_CEILING_DB } from './constants';

const sine = (freq: number, amp: number, seconds: number, fs = SAMPLE_RATE) =>
    Float32Array.from({ length: Math.round(seconds * fs) }, (_, i) => amp * Math.sin(2 * Math.PI * freq * i / fs));

/**
 * An INDEPENDENT true-peak estimate for the assertions: 8x oversampling with
 * a longer (24-taps-per-side) Blackman-windowed sinc, not the 4x / 12-tap
 * interpolator the limiter itself uses. So "the limiter keeps true peak under
 * the ceiling" is not checked with the limiter's own ruler.
 */
function referenceTruePeak(x: Float32Array): number {
    const OS = 8, HALF = 24;
    let peak = samplePeak(x);
    for (let n = 0; n < x.length - 1; n++) {
        for (let p = 1; p < OS; p++) {
            const frac = p / OS;
            let v = 0;
            for (let j = -HALF + 1; j <= HALF; j++) {
                const idx = n + j;
                if (idx < 0 || idx >= x.length) continue;
                const t = j - frac;
                const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
                const u = (t + HALF) / (2 * HALF);
                const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
                v += x[idx] * sinc * w;
            }
            peak = Math.max(peak, Math.abs(v));
        }
    }
    return peak;
}

describe('K-weighting', () => {
    it('matches the BS.1770 coefficients at 48 kHz', () => {
        const [shelf, hp] = kWeightingFilters(48_000);
        expect(shelf.b0).toBeCloseTo(1.53512485958697, 10);
        expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10);
        expect(shelf.b2).toBeCloseTo(1.19839281085285, 10);
        expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10);
        expect(shelf.a2).toBeCloseTo(0.73248077421585, 10);
        expect(hp.a1).toBeCloseTo(-1.99004745483398, 10);
        expect(hp.a2).toBeCloseTo(0.99007225036621, 10);
    });

    it('a full-scale 997 Hz sine on one channel reads -3.01 LUFS (the BS.1770 reference)', () => {
        expect(integratedLoudness(sine(997, 1, 5))).toBeCloseTo(-3.01, 1);
    });

    it('-20 dB of signal is -20 LU, and silence is -Infinity (absolute gate)', () => {
        const a = integratedLoudness(sine(997, 1, 3));
        const b = integratedLoudness(sine(997, 0.1, 3));
        expect(a - b).toBeCloseTo(20, 1);
        expect(integratedLoudness(new Float32Array(48_000))).toBe(-Infinity);
        expect(integratedLoudness(sine(997, 1e-5, 2))).toBe(-Infinity); // ~ -103 LUFS, under -70
    });

    it('measures a clip shorter than one 400 ms block as a single block', () => {
        expect(integratedLoudness(sine(997, 1, 0.3))).toBeCloseTo(-3.01, 0);
    });
});

describe('processClip', () => {
    it.each([
        ['a loud sine', sine(440, 0.95, 3)],
        ['a quiet sine', sine(440, 0.01, 3)],
        ['a mid sine at 3 kHz', sine(3000, 0.2, 3)],
    ])('%s lands near the target loudness', (_l, src) => {
        const r = processClip(src, 0, 2.5);
        expect(r.outputLufs).toBeGreaterThan(TARGET_LUFS - 1);
        expect(r.outputLufs).toBeLessThan(TARGET_LUFS + 0.5);
        expect(r.durationMs).toBe(2500);
    });

    it('normalizes the loud and the quiet sine to the same loudness (within 0.5 LU)', () => {
        const loud = processClip(sine(440, 0.95, 3), 0, 2);
        const quiet = processClip(sine(440, 0.01, 3), 0, 2);
        expect(Math.abs(loud.outputLufs - quiet.outputLufs)).toBeLessThan(0.5);
    });

    it('a high-crest signal is limited: true peak <= -1 dBTP by an independent 8x meter', () => {
        // A quiet bed with sharp loud clicks: normalizing the bed to -16 LUFS
        // pushes the clicks far over full scale, so the limiter has to work.
        const src = sine(220, 0.02, 1);
        for (let k = 0; k < 4; k++) { const at = 4000 + k * 11_000; src[at] = 0.9; src[at + 1] = -0.9; src[at + 2] = 0.7; }
        const r = processClip(src, 0, 1);
        expect(gainToDb(referenceTruePeak(r.pcm))).toBeLessThanOrEqual(-1);
        expect(r.truePeakDb).toBeLessThanOrEqual(TRUE_PEAK_CEILING_DB + 1e-6);
        // The limiter only touched the clicks: well away from them the bed
        // carries exactly the normalization gain.
        const gain = Math.pow(10, (TARGET_LUFS - r.inputLufs) / 20);
        const bed = r.pcm.slice(8_000 + 2_000, 8_000 + 5_000);
        expect(samplePeak(bed)).toBeCloseTo(0.02 * gain, 2);
    }, 30_000);

    it('a full-scale square wave (inter-sample overshoot) ends under the ceiling, without clipping', () => {
        const fs = SAMPLE_RATE;
        const sq = Float32Array.from({ length: fs / 4 }, (_, i) => (Math.floor(i / (fs / 1000 / 2)) % 2 ? -1 : 1) * 0.99);
        const out = limitTruePeak(sq);
        expect(gainToDb(referenceTruePeak(out))).toBeLessThanOrEqual(-1);
        expect(samplePeak(out)).toBeLessThan(0.89);
        // Not a clip: the shape survives (a clipped square would be flat at the ceiling everywhere).
        expect(samplePeak(out)).toBeGreaterThan(0.5);
    }, 30_000);

    it('fades start and end at ~0, and the middle is untouched', () => {
        const r = processClip(sine(440, 0.3, 3), 0.5, 1);
        expect(Math.abs(r.pcm[0])).toBeLessThan(1e-6);
        expect(Math.abs(r.pcm[r.pcm.length - 1])).toBeLessThan(0.02);
        const x = applyFades(new Float32Array(48_000).fill(1));
        expect(x[0]).toBe(0);
        expect(x[24_000]).toBe(1);
        expect(x[x.length - 1]).toBeLessThan(1e-3);
    });

    it('rejects a silent window', () => {
        expect(() => processClip(new Float32Array(SAMPLE_RATE * 2), 0, 1)).toThrow('silent');
    });
});

describe('trim / length caps', () => {
    const src = sine(440, 0.5, 10);
    it('caps the window at 2.5 s whatever length is asked for', () => {
        expect(trimWindow(src, 1, 9).length).toBe(MAX_CLIP_SAMPLES);
        expect(processClip(src, 0, 30).durationMs).toBe(2500);
    });
    it('takes exactly the asked window when it fits', () => {
        const w = trimWindow(src, 2, 1.25);
        expect(w.length).toBe(60_000);
        expect(w[0]).toBeCloseTo(src[96_000], 6);
    });
    it('clamps to the end of the source', () => {
        expect(trimWindow(src, 9, 2.5).length).toBe(48_000);
    });
    it('refuses a window that is too short or out of range', () => {
        expect(() => trimWindow(src, 0, 0)).toThrow('window too short');
        expect(() => trimWindow(src, 10, 2)).toThrow('window too short');
        expect(() => trimWindow(src, 9.9, 2)).toThrow('window too short');
        expect(() => trimWindow(src, Number.NaN, 1)).toThrow('bad window');
    });
});

describe('helpers', () => {
    it('downmix averages channels', () => {
        const m = downmix([Float32Array.from([1, 0, 0.5]), Float32Array.from([0, 1, 0.5])]);
        expect([...m]).toEqual([0.5, 0.5, 0.5]);
        expect(downmix([]).length).toBe(0);
    });
    it('truePeak sees an inter-sample peak a sample-peak meter misses', () => {
        // fs/4 sine at 45 degrees: samples at +-0.707, the waveform peaks at 1.
        const x = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(Math.PI / 2 * i + Math.PI / 4));
        expect(samplePeak(x)).toBeCloseTo(0.7071, 3);
        expect(truePeak(x)).toBeGreaterThan(0.95);
    });
    it('waveformPeaks buckets the magnitude', () => {
        const p = waveformPeaks(Float32Array.from([0, 0.5, -1, 0.25]), 2);
        expect([...p]).toEqual([0.5, 1]);
    });
});
