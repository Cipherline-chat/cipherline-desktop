import { describe, it, expect, vi } from 'vitest';
import { runWindow, backgroundVoicePass, loadGate, voicedBursts, steadyNoise, rng, SR, type WindowSpec, type WindowResult } from './voiceGateHarness';

vi.mock('../workers/rnnoise.worker?worker', () => ({ default: class {} }));

/**
 * The AUTO voice gate against windows taken from REAL prod diagnostic reports (2026-11-14..16, `mic_level` call events,
 * 167 windows from 6 reports; see docs/worklog/entries/2026-11-16-gate-data-tune.md for the data and the model).
 *
 * Each case replays the real worklet on a synthetic signal built from one real window's `speech_db` (the level the
 * gate's own detector sees) and `talk_pct` (duty cycle) with an ASSUMED noise floor (0.1.0 did not export it).
 * Syllable dynamics are modelled, not measured, so the numbers rank constants against each other; they are not a
 * prediction of a real call. The "0.1.0" CONTROL is the shipped 0.1.0 gate rebuilt from its constants (verified
 * bit-identical to the v0.1.0 worklet source on 16 windows when this was written), so each assertion can fail.
 */
const AUTO = [{ type: 'gate', enabled: true }, { type: 'threshold', value: -45 }, { type: 'auto', value: true }];
/** The gate exactly as 0.1.0 shipped it (stable users): 60% / -8 dB / cap -30, 150 ms hold, 50 ms release, no voice rule. */
const V010 = {
    AUTO_MARGIN_DB: 7, AUTO_MAX_MARGIN_DB: 30, AUTO_SPEECH_RATIO: 0.6, AUTO_MAX_DB: -30, AUTO_HEADROOM_DB: 8,
    AUTO_HOLD_SAMPLES: 7200, AUTO_RELEASE_RATE: 1 / 2400, VOICE_RESCUE_SCORE: 2,
};

async function gateSource(): Promise<string> { return (await import('./voiceProcessor')).GATE_WORKLET_SOURCE; }
const run = (src: string, spec: WindowSpec, ov: Record<string, number> = {}): WindowResult => runWindow(src, AUTO, ov, { seconds: 24, ...spec }, 8);

describe('AUTO gate on real report windows: speech is not cut', () => {
    // [label, speech_db, talk_pct, assumed floor]: a663d053's quietest window (-46.7), the owner's quiet light-NS mic
    // (dfcbb9fe, -42.2 at 6% talk), c03022d3's median (-31.5), a663d053's loud passages (-23).
    const WINDOWS: Array<[string, number, number, number]> = [
        ['quiet talker (a663d053, -46.7 dBFS)', -46.7, 19, -75],
        ['quiet talker, light NS (dfcbb9fe, -42.2 dBFS, 6% talk)', -42.2, 6, -65],
        ['normal talker (c03022d3 median, -31.5)', -31.5, 19, -65],
        ['loud talker (a663d053 passages, -23)', -23, 49, -65],
    ];
    for (const [label, speech, talk, floor] of WINDOWS) {
        it(`${label}: voiced syllables keep the gate open (< 2% cut); the 0.1.0 gate cuts them`, async () => {
            const src = await gateSource();
            const spec: WindowSpec = { speechDb: speech, duty: talk / 100, floorDb: floor, seed: 3, events: 'both', sigmaDb: 4.5, phraseSigmaDb: 5 };
            const now = run(src, spec);
            expect(now.cutNucleus).toBeLessThan(0.02);
            const old = run(src, spec, V010);
            expect(old.cutNucleus).toBeGreaterThan(0.06); // CONTROL: the same audio through 0.1.0's constants
            expect(old.cutNucleus).toBeGreaterThan(now.cutNucleus * 4);
        }, 60_000);
    }

    it('a loud talker then a quiet phrase 21 dB lower (-22 then -43 dBFS): the voice rule keeps it (it sat outside the old 18 dB range)', async () => {
        const src = await gateSource();
        const kept = (ov: Record<string, number>) => {
            const r = rng(9);
            const loud = voicedBursts(12, -22), quiet = voicedBursts(4, -43);
            const n = steadyNoise(loud.length + quiet.length, -70, r);
            const x = new Float32Array(n.length);
            for (let i = 0; i < loud.length; i++) x[i] = loud[i] + n[i];
            for (let i = 0; i < quiet.length; i++) x[loud.length + i] = quiet[i] + n[loud.length + i];
            const y = loadGate(src, AUTO, ov).run(x);
            let ok = 0, tot = 0;
            for (let c = 0; c < 8; c++) { // the quiet phrase's burst cores, skipping its first second
                const a = loud.length + SR + Math.round((c * 0.4 + 0.1) * SR), b = a + Math.round(0.15 * SR);
                let ei = 0, eo = 0; for (let i = a; i < b; i++) { ei += x[i] * x[i]; eo += y[i] * y[i]; }
                tot++; if (eo > ei * 0.5) ok++;
            }
            return ok / tot;
        };
        expect(kept({})).toBeGreaterThanOrEqual(0.75);
        expect(kept({ VOICE_RESCUE_RANGE_DB: 18 })).toBeLessThanOrEqual(0.5); // CONTROL: the previous range chops it
    }, 60_000);
});

describe('AUTO gate on real report windows: noise stays out', () => {
    it('noisy room (floor -50 dBFS, speech -30): steady room noise between phrases is gated, speech is not cut', async () => {
        const src = await gateSource();
        const r = run(src, { speechDb: -30, duty: 0.3, floorDb: -50, seed: 4, events: 'none' });
        expect(r.passSteady).toBeLessThan(0.02);
        expect(r.cutNucleus).toBeLessThan(0.02);
    }, 60_000);

    it('keyboard clicks and breaths (speech-16 / speech-22 dB) over a quiet floor are gated between phrases', async () => {
        const src = await gateSource();
        const r = run(src, { speechDb: -35, duty: 0.3, floorDb: -75, seed: 6, events: 'both', seconds: 40 });
        expect(r.nEvt).toBeGreaterThan(40); // the scenario really has events to judge (control against a vacuous pass)
        expect(r.passEvent).toBeLessThan(0.1);
        expect(r.passSteady).toBeLessThan(0.02);
    }, 60_000);

    it('CONTROL: a gate far lower than the chosen rule (manual -60) lets the same room noise and events through', async () => {
        const src = await gateSource();
        const spec: WindowSpec = { speechDb: -35, duty: 0.3, floorDb: -58, seed: 6, events: 'both', seconds: 40 };
        const manual = runWindow(src, [{ type: 'gate', enabled: true }, { type: 'threshold', value: -60 }, { type: 'auto', value: false }], {}, spec, 8);
        expect(manual.passSteady).toBeGreaterThan(0.5);
    }, 60_000);

    it('a second voice 34 dB under a loud talker (a TV across the room) is still gated after the talker stops; one 12 dB under is not', async () => {
        const src = await gateSource();
        const pass = (offset: number) => backgroundVoicePass(src, {}, -22, offset, -80);
        expect(pass(34)).toBeLessThan(0.05);
        expect(pass(12)).toBeGreaterThan(0.5); // CONTROL: a close second voice is speech as far as the gate can tell
    }, 60_000);
});
