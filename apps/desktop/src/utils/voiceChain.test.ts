import { describe, it, expect } from 'vitest';
import { planVoiceChain, voiceChainNeedsProcessor, type VoiceChainSettings } from './voiceChain';

/**
 * Decision table for the outgoing voice chain's composition.
 *
 * The owner bug: "the noise gate doesn't work when noise suppression is turned
 * off". The rule pinned here is that every stage follows ITS OWN setting (and
 * its own availability) and nothing else; and that the processor is attached
 * at all only while some stage is on.
 */

const s = (ns: boolean, gate: boolean, eq: boolean, over: Partial<VoiceChainSettings> = {}): VoiceChainSettings => ({
    noiseSuppression: ns,
    voiceGate: gate,
    eqEnabled: eq,
    eqBands: [3, 0, -2, 0, 0],
    volumeNormalization: false,
    micVolume: 100,
    ...over,
});

describe('planVoiceChain — NS × gate × EQ (AGC off, mic volume 100 %)', () => {
    // [ns, gate, eq] → expected [ns, gate, eq, needsProcessor]
    const table: Array<[boolean, boolean, boolean, boolean]> = [
        [false, false, false, false],   // everything off → raw capture, no processor
        [false, false, true,  true],
        [false, true,  false, true],    // THE owner case: gate on, NS off → the gate runs
        [false, true,  true,  true],
        [true,  false, false, true],
        [true,  false, true,  true],
        [true,  true,  false, true],
        [true,  true,  true,  true],
    ];
    for (const [ns, gate, eq, needs] of table) {
        it(`NS ${ns ? 'on ' : 'off'} · gate ${gate ? 'on ' : 'off'} · EQ ${eq ? 'on ' : 'off'} → ${needs ? 'processor' : 'raw mic'}`, () => {
            const plan = planVoiceChain(s(ns, gate, eq));
            expect(plan.ns).toBe(ns);
            expect(plan.gate).toBe(gate);
            expect(plan.eq).toBe(eq);
            expect(plan.agc).toBe(false);
            expect(plan.micGain).toBe(false);
            expect(plan.needsProcessor).toBe(needs);
        });
    }
});

describe('planVoiceChain — the other per-user stages each need the processor on their own', () => {
    it('auto gain control alone', () => {
        const plan = planVoiceChain(s(false, false, false, { volumeNormalization: true }));
        expect(plan).toMatchObject({ agc: true, needsProcessor: true });
    });

    it('mic volume ≠ 100 % alone (either direction)', () => {
        expect(planVoiceChain(s(false, false, false, { micVolume: 140 })).needsProcessor).toBe(true);
        expect(planVoiceChain(s(false, false, false, { micVolume: 60 })).needsProcessor).toBe(true);
        expect(planVoiceChain(s(false, false, false, { micVolume: 100 })).needsProcessor).toBe(false);
    });
});

describe('planVoiceChain — a stage that failed to load drops only itself', () => {
    it('RNNoise unavailable: the gate still runs (it used to be built in the same try and dropped with it)', () => {
        const plan = planVoiceChain(s(true, true, true, { volumeNormalization: true }), { ns: false, gate: true, agc: true });
        expect(plan).toMatchObject({ ns: false, gate: true, eq: true, agc: true, needsProcessor: true });
    });

    it('gate unavailable: NS and AGC still run', () => {
        const plan = planVoiceChain(s(true, true, false, { volumeNormalization: true }), { ns: true, gate: false, agc: true });
        expect(plan).toMatchObject({ ns: true, gate: false, agc: true });
    });

    it('availability never decides whether the processor is attached — the settings do', () => {
        expect(planVoiceChain(s(true, false, false), { ns: false, gate: false, agc: false }).needsProcessor).toBe(true);
        expect(voiceChainNeedsProcessor(s(false, false, false))).toBe(false);
    });
});
