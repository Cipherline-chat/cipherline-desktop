/**
 * Positive controls for the call-audio E2E analysis (e2eAnalysis.ts): every round-trip measurement must fire on a
 * signal where the answer is known. Runs by default (pure JS, a few seconds); the browser sweep itself is
 * callAudioE2E.sweep.test.ts (skipped unless AUDIO_E2E=1).
 */
import { describe, it, expect } from 'vitest';
import { synth } from '../../utils/voiceGateHarness';
import { GATE_WORKLET_SOURCE } from '../../utils/voiceProcessor';
import { SR, labelSpeech, scaleTo, background, buildChain, score } from './chainHarness';
import { findLag, trackLag, alignByTrack, roundTrip, scoreAligned } from './e2eAnalysis';

function speech(seconds: number, db: number): Float32Array {
    const s = synth({ speechDb: -30, duty: 0.35, floorDb: -140, seconds, seed: 5, events: 'none', sigmaDb: 4.5, phraseSigmaDb: 5 });
    return scaleTo(s.x, db);
}
const delayed = (x: Float32Array, d: number, gainDb = 0, extra = 0) => {
    const y = new Float32Array(x.length + d + extra); const k = Math.pow(10, gainDb / 20);
    for (let i = 0; i < x.length; i++) y[i + d] = x[i] * k;
    return y;
};

describe('call-audio E2E analysis', () => {
    const x = speech(20, -30);
    const lab = labelSpeech(x);

    it('finds a known lag and a jitter-buffer step', () => {
        const y = delayed(x, 12_345);
        expect(findLag(x, y, 0, 3 * SR).lag).toBe(12_345);
        // +5 ms from 10 s on (what a receiver's time stretching does)
        const z = new Float32Array(y.length + 240);
        z.set(y.subarray(0, 12_345 + 10 * SR), 0);
        z.set(y.subarray(12_345 + 10 * SR), 12_345 + 10 * SR + 240);
        const tr = trackLag(x, z, 12_345);
        const lagsWithSpeech = Array.from(tr.lags);
        expect(lagsWithSpeech[3]).toBe(12_345);
        expect(lagsWithSpeech[15]).toBe(12_345 + 240);
    });

    it('sees no dropouts on an identical copy, and a gain change exactly', () => {
        const y = delayed(x, 4_800, -2);
        const tr = trackLag(x, y, 4_800);
        const r = roundTrip(x, alignByTrack(y, tr, x.length), lab, SR);
        expect(r.levelDeltaDb).toBeCloseTo(-2, 1);
        expect(r.dropouts).toBe(0);
        expect(r.segSnrDb).toBeGreaterThan(60);
    });

    it('counts a 40 ms hole in speech as one dropout (CONTROL)', () => {
        const y = delayed(x, 4_800);
        // first phrase core after 5 s
        let at = -1;
        for (let f = Math.ceil(5 * SR / 240); f < lab.frame.length; f++) if (lab.frame[f] === 2 && lab.frame[f + 10] === 2) { at = f * 240; break; }
        for (let i = at; i < at + 0.04 * SR; i++) y[i + 4_800] = 0;
        const r = roundTrip(x, alignByTrack(y, trackLag(x, y, 4_800), x.length), lab, SR);
        expect(r.dropouts).toBe(1);
        expect(r.dropoutMs).toBeGreaterThanOrEqual(30);
        expect(r.dropoutMs).toBeLessThanOrEqual(50);
    });

    it('the signal-based speech-cut estimate agrees with the real gate trace (fixed -45 gate, quiet talker)', async () => {
        const quiet = speech(30, -45);
        const qlab = labelSpeech(quiet);
        const bg = background('fan', quiet.length, -65, 11);
        const inp = new Float32Array(quiet.length);
        for (let i = 0; i < inp.length; i++) inp[i] = quiet[i] + bg[i];
        const chain = await buildChain({ ns: 'off', gate: 'manual', agc: true, gateSource: GATE_WORKLET_SOURCE }, { light: '', strong: '', speexWasm: () => new ArrayBuffer(0) });
        const tr = chain.run(inp);
        const truth = score(inp, qlab, tr, 0, 10 * SR);
        const est = scoreAligned(inp, qlab, tr.out, 10 * SR);
        expect(truth.speechCutPct).toBeGreaterThan(1); // the -45 gate does cut a -45 talker (otherwise this proves nothing)
        expect(Math.abs(est.speechCutPct - truth.speechCutPct)).toBeLessThan(Math.max(1.5, truth.speechCutPct * 0.35));
        expect(Math.abs(est.gateOnsetMs - truth.gateOnsetMs)).toBeLessThan(6);
        expect(est.outSpeechDb).toBeCloseTo(truth.outSpeechDb, 5);
    });
});
