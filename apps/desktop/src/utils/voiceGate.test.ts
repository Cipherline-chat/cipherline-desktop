import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_VOICE_SETTINGS } from '../hooks/useVoiceSettings';
import { dbToLinear } from '../audio/agcKernel.js';

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
    run.posted = posted;
    run.node = g as unknown as Record<string, number>;
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

// The automatic voice gate was removed 2026-11-17 (owner: "leave out the auto part and go back to the way it was"). This
// is the gate as it was before 2026-11-11 (d6c6ef7f): the user's threshold, 150 ms hold, ~0.7 ms attack, 50 ms release.
const at = (s: number) => Math.round(s * SR);
const FIXED = (thr: number) => [{ type: 'gate', enabled: true }, { type: 'threshold', value: thr }, { type: 'hold', ms: 150 }];

describe('voice gate: the fixed threshold (pre-auto behaviour, restored)', () => {
    it('defaults: on, -45 dBFS, no Automatic flag', () => {
        expect(DEFAULT_VOICE_SETTINGS.voiceGate).toBe(true);
        expect(DEFAULT_VOICE_SETTINGS.voiceGateThreshold).toBe(-45);
        expect('voiceGateAuto' in DEFAULT_VOICE_SETTINGS).toBe(false);
    });

    it('speech above the threshold passes, room noise under it is gated', async () => {
        const gate = await makeGate(FIXED(-45));
        const y = gate(cat(noise(2, -55), sum(noise(4, -55, 2), talk(4, -30))));
        expect(rmsDb(y, at(0.5), at(2))).toBeLessThan(-100);            // the room alone: closed
        let kept = 0;
        for (let c = 0; c < 8; c++) { const a = at(2.5 + c * 0.4 + 0.1), b = a + at(0.15); if (rmsDb(y, a, b) > -33) kept++; }
        expect(kept).toBe(8);                                           // every burst at its own level
    });

    it("the threshold never moves with the room: an 'auto' message is ignored and a -60 gate stays open on -52 noise", async () => {
        const gate = await makeGate([...FIXED(-60), { type: 'auto', value: true }]);
        const y = gate(noise(6, -52));
        expect(rmsDb(y, at(1), at(6))).toBeGreaterThan(-54);
        expect((gate.node as unknown as { effDb?: number }).effDb).toBeUndefined();
    });

    it('hold 150 ms then a 50 ms release: open 0.1 s after the last burst, closed by 0.25 s', async () => {
        const gate = await makeGate(FIXED(-45));
        const burst = talk(0.3, -30);
        const y = gate(cat(noise(1, -70), sum(burst, noise(0.3, -70, 2)), noise(1, -70, 3)));
        const end = at(1.3);
        expect(rmsDb(y, end + at(0.08), end + at(0.12))).toBeGreaterThan(-72); // still open (hold)
        expect(rmsDb(y, end + at(0.25), end + at(0.35))).toBeLessThan(-100);   // closed
    });

    it('CONTROL (why the automatic mode existed): a quiet talker (-51 dBFS bursts) is cut entirely by the -45 default', async () => {
        const gate = await makeGate(FIXED(-45));
        const y = gate(cat(noise(2, -60), sum(noise(4, -60, 2), talk(4, -51))));
        let kept = 0;
        for (let c = 0; c < 8; c++) { const a = at(2.5 + c * 0.4 + 0.1), b = a + at(0.15); if (rmsDb(y, a, b) > -54) kept++; }
        expect(kept).toBe(0);
    });
});

