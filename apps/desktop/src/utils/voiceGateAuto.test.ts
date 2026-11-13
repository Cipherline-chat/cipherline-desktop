import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_VOICE_SETTINGS } from '../hooks/useVoiceSettings';
import { AgcProcessor, dbToLinear } from '../audio/agcKernel.js';

vi.mock('../workers/rnnoise.worker?worker', () => ({ default: class {} }));

const SR = 48000;
const Q = 128;

async function makeGate(msgs: Array<Record<string, unknown>>) {
    const { GATE_WORKLET_SOURCE } = await import('./voiceProcessor');
    let Ctor: (new () => { port: { onmessage: ((e: { data: unknown }) => void) | null }; process(i: Float32Array[][], o: Float32Array[][]): boolean }) | undefined;
    const posted: Array<Record<string, unknown>> = [];
    class Base { port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: Record<string, unknown>) => { posted.push(m); } }; }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', GATE_WORKLET_SOURCE)(Base, (_n: string, c: typeof Ctor) => { Ctor = c; }, SR);
    const g = new Ctor!();
    for (const m of msgs) g.port.onmessage!({ data: m });
    const run = (x: Float32Array): Float32Array => {
        const out = new Float32Array(x.length - (x.length % Q));
        const o = new Float32Array(Q);
        for (let b = 0; (b + 1) * Q <= x.length; b++) {
            g.process([[x.subarray(b * Q, (b + 1) * Q)]], [[o]]);
            out.set(o, b * Q);
        }
        return out;
    };
    /** The auto threshold in force (dBFS) after the audio fed so far. */
    run.posted = posted;
    run.effDb = () => (g as unknown as { effDb: number }).effDb;
    return run;
}

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function noise(sec: number, db: number, seed = 1): Float32Array {
    const r = rng(seed); const y = new Float32Array(Math.round(sec * SR)); let lp = 0;
    for (let i = 0; i < y.length; i++) { lp += 0.35 * ((r() * 2 - 1) - lp); y[i] = lp; }
    let s = 0; for (const v of y) s += v * v;
    const g = dbToLinear(db) / Math.sqrt(s / y.length); for (let i = 0; i < y.length; i++) y[i] *= g;
    return y;
}
/** Voiced bursts (glottal-ish, 25 harmonics) of 0.3 s every 0.4 s, scaled to `db` RMS over the burst. */
function talk(sec: number, db: number): Float32Array {
    const y = new Float32Array(Math.round(sec * SR));
    let ph = 0;
    for (let i = 0; i < y.length; i++) {
        ph += 125 / SR; ph -= Math.floor(ph);
        let v = 0; for (let h = 1; h <= 25; h++) v += Math.sin(2 * Math.PI * h * ph) / h;
        const k = (i / SR) % 0.4;
        y[i] = k < 0.3 ? v * Math.min(1, Math.min(k, 0.3 - k) / 0.02) : 0;
    }
    let s = 0, n = 0; for (let i = 0; i < y.length; i++) if (y[i] !== 0) { s += y[i] * y[i]; n++; }
    const g = dbToLinear(db) / Math.sqrt(s / n); for (let i = 0; i < y.length; i++) y[i] *= g;
    return y;
}
const sum = (...p: Float32Array[]) => { const y = new Float32Array(Math.max(...p.map(a => a.length))); for (const a of p) for (let i = 0; i < a.length; i++) y[i] += a[i]; return y; };
const cat = (...p: Float32Array[]) => { const y = new Float32Array(p.reduce((a, b) => a + b.length, 0)); let o = 0; for (const a of p) { y.set(a, o); o += a.length; } return y; };
const rmsDb = (x: Float32Array, from: number, to: number) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return 10 * Math.log10(Math.max(s / (to - from), 1e-20)); };

describe('voice gate AUTO mode (threshold left at its default)', () => {
    it('Automatic is ON by default; the manual threshold default is unchanged', () => {
        expect(DEFAULT_VOICE_SETTINGS.voiceGateAuto).toBe(true);
        expect(DEFAULT_VOICE_SETTINGS.voiceGateThreshold).toBe(-45);
    });

    it('speech at -45 dBFS over a -52 dBFS floor opens the gate (its onset is not clipped)', async () => {
        const gate = await makeGate([{ type: 'gate', enabled: true }, { type: 'threshold', value: -45 }, { type: 'auto', value: true }]);
        const x = cat(noise(2, -52), sum(noise(4, -52, 2), talk(4, -45)));
        const y = gate(x);
        // inside a burst (0.1-0.25 s of the 0.4 s cycle) the output keeps the speech level
        let kept = 0;
        for (let c = 0; c < 8; c++) { const a = at(2.5 + c * 0.4 + 0.1), b = a + at(0.15); if (rmsDb(y, a, b) > -48) kept++; }
        expect(kept).toBeGreaterThanOrEqual(7);
    });

    it('a user-set threshold is untouched: auto never moves it (a -60 gate stays open on -52 noise)', async () => {
        const gate = await makeGate([{ type: 'gate', enabled: true }, { type: 'threshold', value: -60 }, { type: 'auto', value: false }]);
        const y = gate(noise(4, -52));
        expect(rmsDb(y, at(1), at(4))).toBeGreaterThan(-54); // open: noise passes
    });

    it('CONTROL: auto on a noisy room (-38 dBFS floor) closes the gate between words where the fixed -45 stays open', async () => {
        const room = (auto: boolean) => makeGate([{ type: 'gate', enabled: true }, { type: 'threshold', value: -45 }, { type: 'auto', value: auto }]);
        const x = cat(noise(9, -38), sum(noise(4, -38, 2), talk(4, -20)), noise(3, -38, 3));
        const fixed = (await room(false))(x), auto = (await room(true))(x);
        expect(rmsDb(fixed, at(14), at(16))).toBeGreaterThan(-40); // fixed -45 gate: noise at -38 passes forever
        expect(rmsDb(auto, at(14), at(16))).toBeLessThan(-60);
    });

    it('gap noise after speech on a -52 dBFS floor mic: gate (default, auto) -> AGC leaves nothing above ~-90 dBFS in the gaps, speech about -16', async () => {
        const gate = await makeGate([{ type: 'gate', enabled: true }, { type: 'threshold', value: -45 }, { type: 'auto', value: true }]);
        const x = cat(sum(noise(14, -52, 4), talk(14, -45)), noise(8, -52, 5));
        const g = gate(x);
        const agc = new AgcProcessor({ sampleRate: SR });
        const o = new Float32Array(Q);
        const out = new Float32Array(g.length);
        for (let b = 0; (b + 1) * Q <= g.length; b++) { agc.process(g.subarray(b * Q, (b + 1) * Q), o); out.set(o, b * Q); }
        expect(agc.gainDb).toBeGreaterThan(25); // the speech was boosted ...
        expect(rmsDb(out, at(17), at(22))).toBeLessThan(-80); // ... and the gap noise stays gated, not lifted to ~-21
        // CONTROL: the same chain with the gate OFF lifts the gap noise by the held gain.
        const agc2 = new AgcProcessor({ sampleRate: SR });
        const out2 = new Float32Array(x.length);
        for (let b = 0; (b + 1) * Q <= x.length; b++) { agc2.process(x.subarray(b * Q, (b + 1) * Q), o); out2.set(o, b * Q); }
        expect(rmsDb(out2, at(17), at(22))).toBeGreaterThan(-30);
    });
});
const at = (s: number) => Math.round(s * SR);

describe('voice gate AUTO: 60% of the way from room noise to speech (owner 2026-11-12: "adjusts too low", "picking up my breathing and movements", "very low noise floor")', () => {
    const auto = () => makeGate([{ type: 'gate', enabled: true }, { type: 'threshold', value: -45 }, { type: 'auto', value: true }]);
    it('a loud, clean mic (-25 dBFS speech over a -52 floor) gets a gate well above floor + 7', async () => {
        const gate = await auto();
        gate(cat(noise(2, -52), sum(noise(12, -52, 2), talk(12, -25))));
        expect(gate.effDb()).toBeGreaterThan(-42);   // the old rule gave -45
        expect(gate.effDb()).toBeLessThanOrEqual(-22); // never more than 30 dB over the floor
    });
    it('a quiet talker (-45 speech over -52) keeps the 7 dB minimum, so the speech still opens it', async () => {
        const gate = await auto();
        const y = gate(cat(noise(2, -52), sum(noise(8, -52, 2), talk(8, -45))));
        expect(gate.effDb()).toBeLessThanOrEqual(-44.5);
        expect(rmsDb(y, Math.round(4 * SR), Math.round(9 * SR))).toBeGreaterThan(-50); // speech passes
    });
    it('silence only (no speech yet): stays near floor + 7, never jumps up', async () => {
        const gate = await auto();
        gate(noise(6, -52));
        expect(gate.effDb()).toBeLessThan(-42);
    });
    it("the owner's case: a very low-noise mic (-72 floor, -30 speech) gates breathing at -50 but passes speech", async () => {
        const gate = await auto();
        // Learn the room and the voice first.
        gate(cat(noise(2, -72), sum(noise(10, -72, 2), talk(10, -30))));
        expect(gate.effDb()).toBeGreaterThan(-50);
        // Then breathing/movement only (-50 dBFS bursts), no speech.
        const breath = gate(sum(noise(3, -72, 3), talk(3, -50)));
        expect(rmsDb(breath, Math.round(0.5 * SR), breath.length)).toBeLessThan(-75); // gated (after the hold from the preceding speech): silence
        // And speech still passes.
        const speech = gate(sum(noise(3, -72, 4), talk(3, -30)));
        expect(rmsDb(speech, Math.round(0.5 * SR), speech.length)).toBeGreaterThan(-36);
    });
});

describe('voice gate AUTO, round 2 (owner 2026-11-13: "still too low all the time"): never more than 8 dB under the speech level', () => {
    const auto = () => makeGate([{ type: 'gate', enabled: true }, { type: 'threshold', value: -45 }, { type: 'auto', value: true }]);
    const manual = (thr: number) => makeGate([{ type: 'gate', enabled: true }, { type: 'threshold', value: thr }, { type: 'auto', value: false }]);
    const tail = (y: Float32Array) => rmsDb(y, at(0.6), y.length);

    it('low-noise mic, normal speech -30 over a -72 floor: gate ~-38 (was -46); breathing at -45 is gated; CONTROL: a gate at the old -46 lets it through', async () => {
        const gate = await auto();
        gate(cat(noise(2, -72), sum(noise(12, -72, 2), talk(12, -30))));
        expect(gate.effDb()).toBeGreaterThan(-41);
        expect(gate.effDb()).toBeLessThan(-35);
        const breath = gate(sum(noise(3, -72, 3), talk(3, -45)));
        expect(tail(breath)).toBeLessThan(-75);
        // control: the same breathing through a manual gate at the previous auto value (-46)
        const old = await manual(-46);
        expect(tail(old(sum(noise(3, -72, 3), talk(3, -45))))).toBeGreaterThan(-52);
        // and speech still passes the new gate
        expect(tail(gate(sum(noise(3, -72, 4), talk(3, -30))))).toBeGreaterThan(-36);
    });

    it("the owner's own mic (raw speech -45 over a -78 floor): gate about -51 (was -56); movement at -57 is gated, speech passes", async () => {
        const gate = await auto();
        gate(cat(noise(2, -78), sum(noise(20, -78, 2), talk(20, -45))));
        expect(gate.effDb()).toBeGreaterThan(-54);
        expect(gate.effDb()).toBeLessThan(-48);
        expect(tail(gate(sum(noise(3, -78, 3), talk(3, -57))))).toBeLessThan(-80);
        expect(tail(gate(sum(noise(3, -78, 4), talk(3, -45))))).toBeGreaterThan(-50);
        // control: the old rule's -56 would have passed that movement
        const old = await manual(-56);
        expect(tail(old(sum(noise(3, -78, 3), talk(3, -57))))).toBeGreaterThan(-62);
    });

    it('a quiet talker (-45 over -52) is not made worse: still at the 7 dB minimum and the speech opens it', async () => {
        const gate = await auto();
        const y = gate(cat(noise(2, -52), sum(noise(10, -52, 2), talk(10, -45))));
        expect(gate.effDb()).toBeLessThanOrEqual(-44.5);
        expect(rmsDb(y, at(5), at(11))).toBeGreaterThan(-50);
    });

    it('a very quiet source (-55 speech over -80) still opens from the first seconds', async () => {
        const gate = await auto();
        const y = gate(cat(noise(2, -80), sum(noise(15, -80, 2), talk(15, -55))));
        expect(gate.effDb()).toBeLessThanOrEqual(-52);
        expect(gate.effDb()).toBeGreaterThanOrEqual(-60);
        expect(rmsDb(y, at(4), at(17))).toBeGreaterThan(-62); // the voice passes from the first seconds (no minute-long chop)
        // CONTROL: a gate fixed at -45 would chop this talker, so the assertion above can fail
        const x = cat(noise(2, -80), sum(noise(15, -80, 2), talk(15, -55)));
        expect(rmsDb((await manual(-45))(x), at(4), at(17))).toBeLessThan(-80);
    });

    it('noisy room (-45 floor, -28 speech): gate follows the speech, gaps are silent, speech passes; CONTROL: fixed -50 leaves the noise on', async () => {
        const gate = await auto();
        const x = cat(noise(2, -45), sum(noise(10, -45, 2), talk(10, -28)), noise(3, -45, 3));
        const y = gate(x);
        expect(gate.effDb()).toBeGreaterThan(-40);
        expect(rmsDb(y, at(13), at(15))).toBeLessThan(-70);
        const fixed = (await manual(-50))(x);
        expect(rmsDb(fixed, at(13), at(15))).toBeGreaterThan(-50);
    });

    it('stays inside the clamp (-60..-30) for a loud mic (-15 speech)', async () => {
        const gate = await auto();
        gate(cat(noise(2, -60), sum(noise(10, -60, 2), talk(10, -15))));
        expect(gate.effDb()).toBeLessThanOrEqual(-30);
    });
});

describe('gate worklet reports the quietest moment of each second (for the background-noise prompt)', () => {
    it('minDb tracks the room even while someone talks, and is null when nothing was fed', async () => {
        const gate = await makeGate([{ type: 'gate', enabled: false }]);
        gate(sum(noise(3, -40, 2), talk(3, -20)));
        const stats = gate.posted.filter(m => m.type === 'gateStats');
        expect(stats.length).toBeGreaterThanOrEqual(2);
        const mins = stats.map(m => m.minDb as number);
        expect(Math.max(...mins)).toBeLessThan(-34);   // not lifted to the speech level (-20) ...
        expect(Math.min(...mins)).toBeGreaterThan(-60); // ... and not far below the -40 room
        // CONTROL: a silent room reads far lower, so the number does discriminate
        const quiet = await makeGate([{ type: 'gate', enabled: false }]);
        quiet(noise(3, -75, 2));
        const q = quiet.posted.filter(m => m.type === 'gateStats').map(m => m.minDb as number);
        expect(Math.max(...q)).toBeLessThan(-70);
    });
});
