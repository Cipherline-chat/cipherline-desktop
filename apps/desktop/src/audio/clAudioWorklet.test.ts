import { describe, it, expect, afterEach, vi } from 'vitest';
import { CL_AUDIO_WORKLET_SOURCE } from '../utils/clAudioWorkletSource';
import { clAudioWasmBytes } from '../utils/clAudioWasm';
import { CL_AUDIO_LATENCY_SAMPLES, CL_AUDIO_ENGINE_DELAY_SAMPLES, CL_AUDIO_PRIME_SAMPLES, LATENCY_TOLERANCE_SAMPLES } from '../utils/clAudioLatency';
import { loadModuleWorklet, waitFor, measureLag, SR, Q, type Proc } from './audit/chainHarness';

/**
 * The REAL cl-audio worklet (audio/clAudioWorklet.js) with the REAL engine wasm, driven in 128-sample render quanta in Node
 * (the technique of noiseSuppressionWorklets.test.ts / chainHarness.ts). Signals are synthetic, no recordings.
 */
vi.setConfig({ testTimeout: 60_000 });

const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => { for (const k of ['registerProcessor', 'AudioWorkletProcessor', 'sampleRate']) delete g[k]; });

type Msg = { type: string; [k: string]: unknown };
const msgs = (p: Proc) => (p as unknown as { _msgs: Msg[] })._msgs;
const ofType = (p: Proc, t: string) => msgs(p).filter(m => m.type === t);
const send = (p: Proc, data: unknown) => p.port.onmessage!({ data });

async function load(opts: Record<string, unknown> = {}): Promise<Proc> {
    const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', { wasmBytes: clAudioWasmBytes(), testAssumeSpeech: true, ...opts });
    await waitFor(() => !!p.ready || !!p.failed, 30_000);
    return p;
}

/** Pitched pulse train through three formant resonators, syllable envelope (the crate's smoke-test speech), `peak` ~ amplitude. */
function speech(seconds: number, amp = 0.5, seed = 12345): Float32Array {
    const res = [[700, 90], [1100, 110], [2400, 140]].map(([fc, bw]) => {
        const r = Math.exp(-Math.PI * bw / SR), th = 2 * Math.PI * fc / SR;
        return { b0: 1 - r, a1: -2 * r * Math.cos(th), a2: r * r, z1: 0, z2: 0 };
    });
    let phase = 0, tilt = 0, s = seed;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 2147483648) - 1; };
    const n = Math.floor(SR * seconds);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / SR, pos = t % 0.24, env = (Math.floor(t / 0.24) % 7 === 6 || pos > 0.21) ? 0 : Math.min(1, pos / 0.05, (0.21 - pos) / 0.05);
        phase += (125 + 20 * Math.sin(2 * Math.PI * 0.7 * t)) / SR;
        let e = 0; if (phase >= 1) { phase -= 1; e = 1; }
        e += 0.04 * rnd();
        tilt += 0.35 * (e - tilt);
        let v = tilt;
        for (const b of res) { const o = b.b0 * v + b.z1; b.z1 = -b.a1 * o + b.z2; b.z2 = -b.a2 * o; v = o; }
        y[i] = v * env * amp + 0.0003 * rnd();
    }
    return y;
}

/** `speech()` scaled so the RMS over its active samples (|x| > 2 % of the peak) is `db` dBFS. */
function speechDb(seconds: number, db: number): Float32Array {
    const x = speech(seconds, 1);
    let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
    let s2 = 0, n = 0; for (const v of x) if (Math.abs(v) > 0.02 * peak) { s2 += v * v; n++; }
    return scaled(x, Math.pow(10, db / 20) / Math.sqrt(s2 / n));
}

function runAll(p: Proc, x: Float32Array): Float32Array {
    const out = new Float32Array(Math.floor(x.length / Q) * Q);
    const o = new Float32Array(Q);
    for (let k = 0; k * Q + Q <= x.length; k++) {
        expect(p.process([[x.subarray(k * Q, (k + 1) * Q)]], [[o]])).toBe(true);
        out.set(o, k * Q);
    }
    return out;
}

const scaled = (x: Float32Array, k: number) => x.map(v => v * k);
const dbOf = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));
/** RMS in dBFS over the active samples (|x| > 2 % of the peak), after dropping the first `skipS` seconds. */
function activeRmsDb(x: Float32Array, skipS = 0): number {
    let peak = 0;
    for (let i = Math.floor(skipS * SR); i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    let s = 0, n = 0;
    for (let i = Math.floor(skipS * SR); i < x.length; i++) if (Math.abs(x[i]) > 0.02 * peak) { s += x[i] * x[i]; n++; }
    return dbOf(Math.sqrt(s / Math.max(1, n)));
}

const LIGHT = { noise: 1, autoGain: true, manualGainDb: 0, originalSound: false };
const OFF_MANUAL = { noise: 0, autoGain: false, manualGainDb: 0, originalSound: false };
const BYPASS = { noise: 0, autoGain: false, manualGainDb: 0, originalSound: true };

describe('cl-audio worklet: offline, real wasm', () => {
    it('comes up and reports the engine delay of its profile and the FIFO prime', async () => {
        const light = await load();
        expect(light.ready).toBe(true);
        expect(ofType(light, 'ready')[0]).toMatchObject({ delaySamples: CL_AUDIO_ENGINE_DELAY_SAMPLES.light, primeSamples: CL_AUDIO_PRIME_SAMPLES });
        const off = await load({ settings: OFF_MANUAL });
        expect(ofType(off, 'ready')[0]).toMatchObject({ delaySamples: CL_AUDIO_ENGINE_DELAY_SAMPLES.off, primeSamples: CL_AUDIO_PRIME_SAMPLES });
    });

    it('processes synthetic speech: same length, finite, inside [-1, 1], no underruns or overflow', async () => {
        const p = await load();
        const x = speechDb(12, -50); // a quiet mic
        const y = runAll(p, x);
        expect(y.length).toBe(Math.floor(x.length / Q) * Q);
        let bad = 0, over = 0;
        for (const v of y) { if (!Number.isFinite(v)) bad++; else if (Math.abs(v) > 1) over++; }
        expect(bad).toBe(0);
        expect(over).toBe(0);
        const stats = ofType(p, 'stats');
        expect(stats.length).toBeGreaterThanOrEqual(10); // one a second
        expect(stats.reduce((s, m) => s + (m.underrun as number), 0)).toBe(0);
        expect(stats.reduce((s, m) => s + (m.overflow as number), 0)).toBe(0);
        // and it did process: a quiet mic was raised toward the normal range
        expect(Math.abs(activeRmsDb(y, 8) - activeRmsDb(x, 8))).toBeGreaterThan(2);
    });

    // CL_AUDIO_LATENCY_SAMPLES are measured numbers (clAudioLatency.ts): input vs output cross-correlation on fixed-seed synthetic speech.
    it.each([
        ['bypass (original sound)', BYPASS, 'bypass', 0],
        ['Off', OFF_MANUAL, 'off', LATENCY_TOLERANCE_SAMPLES],
        ['Light', { ...LIGHT, autoGain: false }, 'light', LATENCY_TOLERANCE_SAMPLES],
        // Strong is the same engine at full strength: the delay the Settings card shows for it is Light's, and this proves it
        ['Strong', { ...LIGHT, noise: 2, autoGain: false }, 'light', LATENCY_TOLERANCE_SAMPLES],
        ['Light with auto gain (as shipped)', { ...LIGHT }, 'light', LATENCY_TOLERANCE_SAMPLES],
        ['Strong with auto gain (as shipped)', { ...LIGHT, noise: 2 }, 'light', LATENCY_TOLERANCE_SAMPLES],
    ] as const)('measured latency, %s, equals the exported constant', async (_n, settings, kind, tol) => {
        const x = speechDb(10, -30);
        const y = runAll(await load({ settings }), x);
        const lag = measureLag(x, y, SR * 5, SR * 3, 1500);
        expect(Math.abs(lag - CL_AUDIO_LATENCY_SAMPLES[kind])).toBeLessThanOrEqual(tol);
    });

    it('auto gain (2026-11-23): every mic is brought to about the same level, quiet is lifted, hot is turned down by the gain', async () => {
        const out = async (db: number) => activeRmsDb(runAll(await load(), speechDb(25, db)), 18);
        const normal = await out(-25), quiet = await out(-45), hot = await out(-8);
        expect(normal).toBeGreaterThan(-28);      // about the target (-22 dBFS at the 75th percentile of the frames), no make-up gain
        expect(normal).toBeLessThan(-19);
        expect(quiet).toBeGreaterThan(-45 + 7);   // lifted most of the way to the cap (half of the shortfall, at most +12 dB: the owner's "lift them less", 2026-11-23, then 80 % past a 6 dB shortfall, 2026-11-24)
        expect(quiet).toBeLessThan(normal + 1);
        // a normal mic is lifted only half of its shortfall (lift_ratio 0.5), a hot one is turned down in full, so the hot one lands about
        // 4 dB above the normal one (measured 4.1; the bound was 3.5 at full lift, plus half of the normal mic's ~4 dB shortfall)
        expect(hot).toBeLessThan(normal + 5.5);   // a hot mic comes out about where a normal one does...
        expect(hot).toBeGreaterThan(normal - 2.5);
        expect(hot).toBeLessThan(-17);            // ... far under the -8 dBFS it came in at (the old rule left it at about -10)
    });

    it('a restored device gain starts settled: the first seconds are already near the final level', async () => {
        const x = speechDb(25, -50);
        const cold = await load();
        const coldOut = runAll(cold, x);
        const gain = ofType(cold, 'stats').at(-1)!.deviceGainDb as number;
        expect(gain).toBeGreaterThan(9);          // a very quiet mic sits at the +12 dB cap (at least 9)
        const warm = await load({ initialDeviceGainDb: gain });
        const warmOut = runAll(warm, x.subarray(0, SR * 4));
        const finalDb = activeRmsDb(coldOut, 18);
        const coldFirst = activeRmsDb(coldOut.subarray(0, SR * 4), 0);
        const warmFirst = activeRmsDb(warmOut, 0);
        expect(Math.abs(warmFirst - finalDb)).toBeLessThan(Math.abs(coldFirst - finalDb));
        expect(Math.abs(warmFirst - finalDb)).toBeLessThan(6);
    });

    it('reports what leaves between words: pause quanta, their level at the mic and on the wire', async () => {
        const p = await load();
        // 8 s of quiet-mic speech (so the leveller earns a large gain), then 6 s of steady room hiss at -62 dBFS
        const sp = speechDb(8, -45);
        let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
        const hiss = new Float32Array(SR * 6).map(() => rnd() * Math.pow(10, -62 / 20) * Math.sqrt(3));
        const x = new Float32Array(sp.length + hiss.length); x.set(sp); x.set(hiss, sp.length);
        runAll(p, x);
        const st = ofType(p, 'stats').filter(m => !m.reply);
        const sum = (k: string) => st.reduce((a, m) => a + (m[k] as number), 0);
        const pauseN = sum('pauseN');
        expect(pauseN).toBeGreaterThan(375 * 4); // at least 4 of the 6 s of hiss counted as a pause
        const inDb = 10 * Math.log10(sum('pauseInMs') / pauseN);
        const outDb = 10 * Math.log10(sum('pauseOutMs') / pauseN);
        const speechOutDb = 10 * Math.log10(sum('outMs') / sum('voiced'));
        expect(inDb).toBeGreaterThan(-66);
        expect(inDb).toBeLessThan(-58);
        // the room must not leave anywhere near the voice: before the pause attenuation it sat about 25 dB under it
        expect(speechOutDb - outDb).toBeGreaterThan(30); // Light keeps some of the room on purpose; Strong (below) does not
        expect(sum('pauseLoud')).toBeLessThan(pauseN * 0.05);
        expect(Math.max(...st.map(m => m.pauseMaxMs as number))).toBeGreaterThan(0);
    });

    it('a Strong request (noise 2) runs LIGHT in the audio thread (Strong is the worker\'s: FastEnhancer is too heavy here), at the same level and silent in a pause', async () => {
        let seed = 9; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
        const sp = speechDb(8, -30);
        const hiss = new Float32Array(SR * 6).map(() => rnd() * Math.pow(10, -55 / 20) * Math.sqrt(3));
        const x = new Float32Array(sp.length + hiss.length); x.set(sp); x.set(hiss, sp.length);
        const tail = async (noise: number) => {
            const p = await load();
            send(p, { type: 'setSettings', noise, autoGain: true, manualGainDb: 0, originalSound: false });
            const y = runAll(p, x);
            send(p, { type: 'getStats' });
            const eff = msgs(p).filter(m => m.type === 'stats' && m.reply).at(-1)!.effectiveNoise;
            let s2 = 0; const from = sp.length + SR * 2; for (let i = from; i < y.length; i++) s2 += y[i] * y[i];
            return { hissDb: 10 * Math.log10(s2 / (y.length - from) + 1e-14), voiceDb: activeRmsDb(y.subarray(0, sp.length), 4), eff };
        };
        const off = await tail(0), light = await tail(1), strong = await tail(2);
        expect(light.eff).toBe(1);
        expect(strong.eff).toBe(1); // the in-page engine never runs the Strong models: this is Light (the worker plays Strong, see clAudioWorkletAlign.test.ts)
        expect(off.hissDb).toBeGreaterThan(-70);   // no noise profile: the room passes
        expect(light.hissDb).toBeLessThan(-100);   // a pause is silence, as on Discord
        expect(strong.hissDb).toBeLessThan(-100);
        expect(Math.abs(strong.voiceDb - light.voiceDb)).toBeLessThan(2);
    });

    it('settings and a restored gain that arrive before the module is up are applied once it is (nothing is lost)', async () => {
        const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', { wasmBytes: clAudioWasmBytes() });
        send(p, { type: 'setInitialDeviceGain', db: 8 });
        send(p, { type: 'setSettings', noise: 0, autoGain: true, manualGainDb: 0, originalSound: false });
        await waitFor(() => !!p.ready, 30_000);
        send(p, { type: 'getStats' });
        const r = msgs(p).filter(m => m.type === 'stats' && m.reply).at(-1)!;
        expect(r.deviceGainDb as number).toBeCloseTo(8, 1);  // under the +12 dB cap, which would clamp it
        expect(r.effectiveNoise).toBe(0); // the Off profile
    });

    it('original sound is a bit-exact bypass (apart from its fixed delay); a manual gain is applied', async () => {
        const x = speechDb(4, -20);
        const y = runAll(await load({ settings: BYPASS }), x);
        const d = CL_AUDIO_LATENCY_SAMPLES.bypass;
        let maxDiff = 0;
        for (let i = SR; i < x.length - d; i++) maxDiff = Math.max(maxDiff, Math.abs(y[i + d] - x[i]));
        expect(maxDiff).toBe(0);

        const man = await load({ settings: { ...OFF_MANUAL, manualGainDb: -6 } });
        const half = speechDb(4, -30);
        const z = runAll(man, half);
        const diff = activeRmsDb(z, 1) - activeRmsDb(half, 1);
        expect(diff).toBeGreaterThan(-7);
        expect(diff).toBeLessThan(-5);
    });

    it('setSettings after start switches profile and keeps the learned device gain', async () => {
        const p = await load();
        runAll(p, speechDb(20, -50));
        send(p, { type: 'getStats' });
        const g1 = msgs(p).filter(m => m.type === 'stats' && m.reply).at(-1)!.deviceGainDb as number;
        expect(g1).toBeGreaterThan(9); // at the +12 dB cap (at least 9)
        send(p, { type: 'setSettings', noise: 0, autoGain: true, manualGainDb: 0, originalSound: false });
        send(p, { type: 'getStats' });
        const r = msgs(p).filter(m => m.type === 'stats' && m.reply).at(-1)!;
        expect(r.effectiveNoise).toBe(0);
        expect(r.deviceGainDb as number).toBeCloseTo(g1, 1);
    });

    it('deviceChanged starts over (from the make-up gain, 0 dB, or from the remembered gain of the new microphone)', async () => {
        const p = await load();
        runAll(p, speechDb(15, -45)); // a quiet mic: the gain has walked well up
        const gainNow = () => { send(p, { type: 'getStats' }); return msgs(p).filter(m => m.type === 'stats' && m.reply).at(-1)!.deviceGainDb as number; };
        expect(gainNow()).toBeGreaterThan(8);
        send(p, { type: 'deviceChanged', hasGain: false });
        expect(gainNow()).toBeCloseTo(0, 1); // a new microphone starts at the make-up gain (0 dB since 2026-11-23, was 2.2)
        send(p, { type: 'deviceChanged', hasGain: true, gainDb: 8 });
        expect(gainNow()).toBeCloseTo(8, 1);
    });

    it('hostile input (NaN, Infinity, huge, silence, a missing input) never produces a non-finite or out-of-range output', async () => {
        const p = await load();
        const o = new Float32Array(Q);
        const bad = new Float32Array(Q);
        const check = () => { for (const v of o) { if (!Number.isFinite(v) || Math.abs(v) > 1) throw new Error(`bad output ${v}`); } };
        for (let k = 0; k < 400; k++) {
            for (let i = 0; i < Q; i++) bad[i] = [NaN, Infinity, -Infinity, 1e9, -1e9, 0.5, 0][(i + k) % 7];
            p.process([[bad]], [[o]]); check();
        }
        for (let k = 0; k < 50; k++) { p.process([[new Float32Array(Q)]], [[o]]); check(); }
        for (let k = 0; k < 50; k++) { p.process([[]], [[o]]); check(); }
        expect(p.failed).toBeFalsy();
    });

    it('does not allocate typed arrays in process() in steady state', async () => {
        const p = await load();
        const x = speechDb(3, -30);
        runAll(p, x.subarray(0, SR)); // warm up
        const RealF32 = Float32Array;
        let made = 0;
        const Counting = new Proxy(RealF32, { construct(t, a, nt) { made++; return Reflect.construct(t, a, nt); } });
        (globalThis as unknown as { Float32Array: unknown }).Float32Array = Counting;
        const o = new RealF32(Q); const inp = x.subarray(SR, SR + Q);
        try {
            made = 0;
            for (let k = 0; k < 500; k++) p.process([[inp]], [[o]]);
            const during = made;
            new (globalThis as unknown as { Float32Array: new (n: number) => unknown }).Float32Array(1); // positive control: the counter does see a construction
            expect(made).toBe(during + 1);
            made = during;
        } finally { (globalThis as unknown as { Float32Array: unknown }).Float32Array = RealF32; }
        expect(made).toBe(0);
    });
});

describe('cl-audio worklet: failure falls back to passthrough, once', () => {
    it('garbage wasm bytes: passthrough, ONE failed message, never throws', async () => {
        const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', { wasmBytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer });
        await waitFor(() => !!p.failed);
        expect(ofType(p, 'failed')).toHaveLength(1);
        const x = speech(1, 0.2);
        const y = runAll(p, x);
        expect(Array.from(y.subarray(1000, 1010))).toEqual(Array.from(x.subarray(1000, 1010)));
        expect(ofType(p, 'failed')).toHaveLength(1);
        expect(ofType(p, 'ready')).toHaveLength(0);
    });

    it('no wasm at all: failed once, audio passes through', async () => {
        const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', {});
        await waitFor(() => !!p.failed);
        expect(ofType(p, 'failed')).toHaveLength(1);
        const o = new Float32Array(Q);
        const inp = Float32Array.from({ length: Q }, (_, i) => Math.sin(i / 5) * 0.3);
        p.process([[inp]], [[o]]);
        expect(Array.from(o)).toEqual(Array.from(inp));
    });

    it('a wasm trap in cla_push mid-call: that quantum and every later one pass through, one failed message, the module is not called again', async () => {
        const p = await load();
        const x = speech(2, 0.2);
        runAll(p, x.subarray(0, SR));
        const real = p.x as Record<string, unknown>;
        let calls = 0;
        p.x = { ...real, cla_push: () => { calls++; throw new WebAssembly.RuntimeError('unreachable'); } };
        const o = new Float32Array(Q);
        const inp = x.subarray(SR, SR + Q);
        expect(() => p.process([[inp]], [[o]])).not.toThrow();
        expect(Array.from(o)).toEqual(Array.from(inp));
        for (let k = 1; k < 20; k++) {
            const i2 = x.subarray(SR + k * Q, SR + (k + 1) * Q);
            p.process([[i2]], [[o]]);
            expect(Array.from(o)).toEqual(Array.from(i2));
        }
        expect(calls).toBe(1);
        expect(ofType(p, 'failed')).toHaveLength(1);
        expect(String(ofType(p, 'failed')[0].error)).toContain('unreachable');
        // messages after a failure are ignored, not fatal
        expect(() => send(p, { type: 'setSettings', noise: 0, autoGain: true })).not.toThrow();
        expect(() => send(p, { type: 'getStats' })).not.toThrow();
    });

    it('a trap while handling a message also fails over, once', async () => {
        const p = await load();
        p.x = { ...(p.x as Record<string, unknown>), cla_set_settings: () => { throw new WebAssembly.RuntimeError('memory access out of bounds'); } };
        expect(() => send(p, { type: 'setSettings', noise: 0, autoGain: true, manualGainDb: 0, originalSound: false })).not.toThrow();
        expect(p.failed).toBe(true);
        expect(ofType(p, 'failed')).toHaveLength(1);
        const o = new Float32Array(Q); const inp = new Float32Array(Q).fill(0.25);
        p.process([[inp]], [[o]]);
        expect(o[7]).toBe(0.25);
    });

    it('refuses a non-48 kHz context (the engine answers at 48 kHz): failed, passthrough', async () => {
        const g2 = globalThis as unknown as Record<string, unknown>;
        const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', {});
        void p;
        g2.sampleRate = 44100; // after load: the constructor reads sampleRate when the wasm comes up
        const q = await (async () => {
            let Ctor: (new (o: unknown) => Proc) | undefined;
            g2.registerProcessor = (_n: string, c: unknown) => { Ctor = c as typeof Ctor; };
            const f = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
            const file = path.join(os.tmpdir(), `cl44-${Date.now()}.mjs`);
            f.writeFileSync(file, CL_AUDIO_WORKLET_SOURCE);
            try { await import(/* @vite-ignore */ `file://${file}`); } finally { f.unlinkSync(file); }
            return new Ctor!({ processorOptions: { wasmBytes: clAudioWasmBytes(), testAssumeSpeech: true } });
        })();
        await waitFor(() => !!q.failed, 30_000);
        expect(String(ofType(q, 'failed')[0].error)).toMatch(/48 kHz/);
    });
});

describe('cl-audio worklet: manual gate', () => {
    const statsOf = (p: Proc) => { send(p, { type: 'getStats' }); return msgs(p).filter(m => m.type === 'stats' && m.reply).at(-1)!; };
    const GATE_OFF = { ...OFF_MANUAL, gate: { enabled: false, thresholdDb: -55 } };

    it('is off unless asked: no gate in the settings = audio passes, stats say so', async () => {
        const p = await load({ settings: OFF_MANUAL });
        runAll(p, speechDb(2, -45));
        const s = statsOf(p);
        expect(s).toMatchObject({ gateOn: false, gateSupported: true, gateOpen: true });
    });

    it('the gate in the initial settings and in setSettings reaches the engine: quiet is cut, loud passes, gateOpen follows', async () => {
        const quiet = speechDb(3, -60), loud = speechDb(3, -25);
        const p = await load({ settings: { ...OFF_MANUAL, gate: { enabled: true, thresholdDb: -45 } } });
        const yq = runAll(p, quiet);
        const tail = yq.subarray(SR); // after the hold
        expect(Math.max(...tail.map(Math.abs))).toBeLessThan(1e-4);
        expect(statsOf(p)).toMatchObject({ gateOn: true, gateOpen: false });
        const yl = runAll(p, loud);
        expect(activeRmsDb(yl, 1)).toBeGreaterThan(-40);
        expect(statsOf(p)).toMatchObject({ gateOn: true, gateOpen: true });

        // switch it off at run time: the quiet voice comes back
        send(p, { type: 'setSettings', ...GATE_OFF });
        const y2 = runAll(p, speechDb(3, -60));
        expect(activeRmsDb(y2, 1)).toBeGreaterThan(-70);
        expect(statsOf(p)).toMatchObject({ gateOn: false, gateOpen: true });
        // and on again with a threshold under the voice: it passes
        send(p, { type: 'setSettings', ...OFF_MANUAL, gate: { enabled: true, thresholdDb: -80 } });
        runAll(p, speechDb(2, -60));
        expect(statsOf(p)).toMatchObject({ gateOn: true, gateOpen: true });
    });

    it('a gate message that arrives before the module is up is applied once it is', async () => {
        const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', { wasmBytes: clAudioWasmBytes() });
        send(p, { type: 'setSettings', ...OFF_MANUAL, gate: { enabled: true, thresholdDb: -30 } });
        await waitFor(() => !!p.ready, 30_000);
        const y = runAll(p, speechDb(3, -50));
        expect(Math.max(...y.subarray(SR).map(Math.abs))).toBeLessThan(1e-4);
    });

    it('malformed gate input never enables or throws', async () => {
        const p = await load({ settings: OFF_MANUAL });
        for (const gate of [null, 5, 'on', { enabled: 'yes', thresholdDb: NaN }, { enabled: false, thresholdDb: Infinity }]) {
            expect(() => send(p, { type: 'setSettings', gate })).not.toThrow();
        }
        expect(statsOf(p)).toMatchObject({ gateOn: false, gateOpen: true });
        expect(ofType(p, 'failed')).toHaveLength(0);
    });

    it('a wasm without cla_set_gate / cla_gate_open (an older cached build) still runs: no gate, no failure', async () => {
        const RealInstance = WebAssembly.Instance;
        const mod = await WebAssembly.compile(clAudioWasmBytes());
        (WebAssembly as unknown as { Instance: unknown }).Instance = function (m: WebAssembly.Module, imp?: WebAssembly.Imports) {
            const inst = new RealInstance(m, imp);
            const ex = { ...inst.exports } as Record<string, unknown>;
            delete ex.cla_set_gate; delete ex.cla_gate_open;
            return { exports: ex };
        };
        let p: Proc;
        try {
            p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', { wasmModule: mod, settings: { ...OFF_MANUAL, gate: { enabled: true, thresholdDb: -30 } } });
            await waitFor(() => !!p.ready || !!p.failed, 30_000);
        } finally { (WebAssembly as unknown as { Instance: unknown }).Instance = RealInstance; }
        expect(p.ready).toBe(true);
        expect(p.failed).toBe(false);
        const y = runAll(p, speechDb(3, -50)); // a gate at -30 would have cut this
        expect(activeRmsDb(y, 1)).toBeGreaterThan(-60);
        send(p, { type: 'setSettings', ...OFF_MANUAL, gate: { enabled: true, thresholdDb: -20 } });
        send(p, { type: 'reportLevel', ms: 50 });
        runAll(p, speechDb(1, -50));
        expect(statsOf(p)).toMatchObject({ gateOn: false, gateSupported: false, gateOpen: true });
        expect(ofType(p, 'failed')).toHaveLength(0);
        expect(ofType(p, 'level').length).toBeGreaterThan(0);
    });

    it('reportLevel: posts the loudest 10 ms RMS at the microphone input (raw dBFS) and the gate state, only while asked', async () => {
        const p = await load({ settings: { ...OFF_MANUAL, gate: { enabled: true, thresholdDb: -45 } } });
        runAll(p, speechDb(1, -30));
        expect(ofType(p, 'level')).toHaveLength(0);
        send(p, { type: 'reportLevel', ms: 50 });
        const sine = new Float32Array(SR); // 1 kHz at RMS -30 dBFS
        for (let i = 0; i < sine.length; i++) sine[i] = Math.SQRT2 * Math.pow(10, -30 / 20) * Math.sin(2 * Math.PI * 1000 * i / SR);
        runAll(p, sine);
        const lv = ofType(p, 'level');
        expect(lv.length).toBeGreaterThan(15); // ~20 per second at 50 ms
        expect(lv.length).toBeLessThan(25);
        const last = lv.at(-1)!;
        expect(last.dbfs as number).toBeGreaterThan(-31);
        expect(last.dbfs as number).toBeLessThan(-29);
        expect(last.open).toBe(true);
        send(p, { type: 'reportLevel', ms: 0 });
        const n = ofType(p, 'level').length;
        runAll(p, sine);
        expect(ofType(p, 'level')).toHaveLength(n);
    });
});
