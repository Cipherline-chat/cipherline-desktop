import { describe, it, expect, afterEach, vi } from 'vitest';
import { CL_AUDIO_WORKLET_SOURCE } from '../utils/clAudioWorkletSource';
import { clAudioWasmBytes } from '../utils/clAudioWasm';
import { CL_AUDIO_PRIME_SAMPLES, CL_AUDIO_ENGINE_DELAY_SAMPLES, CL_NATIVE_JITTER_FRAMES, CL_STRONG_ENGINE_DELAY_SAMPLES, clNativeStrongLatencySamples } from '../utils/clAudioLatency';
import { Rnnoise } from '@shiguredo/rnnoise-wasm';
import { loadModuleWorklet, waitFor, measureLag, SR, Q, type Proc } from './audit/chainHarness';

/**
 * TIME ALIGNMENT of Strong's hand-off (clAudioWorklet.js, "TIME ALIGNMENT"), proven with the REAL worklet, the REAL wasm as the
 * in-page Light engine, and a SECOND real instance of the same wasm as Strong's worker engine, fed by the real
 * `@shiguredo/rnnoise-wasm` exactly as workers/clAudioStrong.worker.ts does (since 2026-11-24): 960 samples of delay against
 * Light's 480 (FastEnhancer's was 3072). When a Strong frame is late the worklet plays the
 * Light frame of the same slot; if the two engines delayed audio differently that would repeat or skip audio. Each test measures, by cross-correlation against the input, WHICH moment of the
 * input a stretch of output holds, for stretches played from Strong and stretches played from Light.
 */
vi.setConfig({ testTimeout: 120_000 });

const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => { for (const k of ['registerProcessor', 'AudioWorkletProcessor', 'sampleRate']) delete g[k]; });

type Msg = { type: string; [k: string]: unknown };
const msgs = (p: Proc) => (p as unknown as { _msgs: Msg[] })._msgs;
const ofType = (p: Proc, t: string) => msgs(p).filter(m => m.type === t);
const FRAME = 480;
const J = CL_NATIVE_JITTER_FRAMES;
const NATP = CL_AUDIO_PRIME_SAMPLES + FRAME * J;      // output sample at which frame 0 plays
const L_STRONG = clNativeStrongLatencySamples(J);        // where input sample i appears in the output, for a Strong stretch

/** Pitched pulse train through three formant resonators with a syllable envelope (same synthetic voice as clAudioWorklet.test.ts). */
function speech(seconds: number, seed = 12345): Float32Array {
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
        y[i] = v * env + 0.0003 * rnd();
    }
    let peak = 0; for (const v of y) peak = Math.max(peak, Math.abs(v));
    let s2 = 0, c = 0; for (const v of y) if (Math.abs(v) > 0.02 * peak) { s2 += v * v; c++; }
    const k = Math.pow(10, -30 / 20) / Math.sqrt(s2 / c);   // -30 dBFS active RMS
    return y.map(v => v * k);
}

interface StrongExports {
    memory: WebAssembly.Memory;
    cla_new(rate: number): number; cla_in_ptr(c: number): number; cla_out_ptr(c: number): number; cla_push(c: number, n: number): number;
    cla_set_settings(c: number, noise: number, ag: number, mg: number, orig: number, idle: number): number;
    cla_delay_samples(c: number): number; cla_test_assume_speech(on: number): void;
    cla_set_external_strong(c: number, on: number): number; cla_ext_ptr(c: number): number; cla_set_ext(c: number, vad: number): number;
}
/** What the worker runs: RNNoise (rnnoise-wasm) on each frame, handed to a second instance of the engine asked for Strong, fed 480-sample frames in order. */
async function strongHost() {
    const [{ instance }, rn] = await Promise.all([WebAssembly.instantiate(clAudioWasmBytes(), {}), Rnnoise.load()]);
    const e = instance.exports as unknown as StrongExports;
    e.cla_test_assume_speech(1);
    const c = e.cla_new(48000);
    expect(e.cla_set_external_strong(c, 1)).toBe(1);
    expect(e.cla_set_settings(c, 2, 1, 0, 0, 1)).toBe(1);
    const ip = e.cla_in_ptr(c), op = e.cla_out_ptr(c), xp = e.cla_ext_ptr(c);
    const ds = rn.createDenoiseState(), scratch = new Float32Array(FRAME);
    return {
        delay: e.cla_delay_samples(c),
        process(pcm: Float32Array): Float32Array {
            for (let i = 0; i < FRAME; i++) scratch[i] = pcm[i] * 32768;
            const vad = ds.processFrame(scratch);
            const x = new Float32Array(e.memory.buffer, xp, FRAME); for (let i = 0; i < FRAME; i++) x[i] = scratch[i] / 32768;
            expect(e.cla_set_ext(c, vad)).toBe(1);
            new Float32Array(e.memory.buffer, ip, FRAME).set(pcm);
            const n = e.cla_push(c, FRAME);
            if (n !== FRAME) throw new Error('engine answered ' + n);
            return new Float32Array(e.memory.buffer, op, FRAME).slice();
        },
    };
}

type Port = { onmessage: null | ((e: { data: unknown }) => void); posted: Array<Record<string, unknown>>; postMessage(m: Record<string, unknown>): void; close(): void; start(): void };
async function setup(opts: Record<string, unknown> = {}) {
    const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet',
        { wasmBytes: clAudioWasmBytes(), testAssumeSpeech: true, native: true, nativeJitterFrames: J, nativeDelaySamples: CL_STRONG_ENGINE_DELAY_SAMPLES, nativeNoFail: true, ...opts });
    await waitFor(() => !!p.ready || !!p.failed, 30_000);
    const port: Port = { onmessage: null, posted: [], postMessage(m) { this.posted.push(m.pcm ? { ...m, pcm: new Float32Array(m.pcm as Float32Array) } : m); }, close() { /* no-op */ }, start() { /* no-op */ } };
    p.port.onmessage!({ data: { type: 'nativePort', port } });
    return { p, port };
}

/**
 * Run `x` through the worklet. `host(frame) -> pcm | null` answers one 10 ms frame (null = the reply never comes: the worklet plays
 * Light for that slot). Replies arrive one quantum after the frame was sent. `at` is called before each quantum.
 */
function drive(p: Proc, port: Port, x: Float32Array, hostDelay: number, host: (seq: number, pcm: Float32Array) => Float32Array | null, at?: (q: number) => void) {
    const out = new Float32Array(Math.floor(x.length / Q) * Q);
    const o = new Float32Array(Q);
    let seen = 0;
    const due: Array<{ at: number; m: Record<string, unknown> }> = [];
    port.onmessage!({ data: { t: 'ready', delaySamples: hostDelay, effectiveNoise: 2 } });
    for (let k = 0; k * Q + Q <= x.length; k++) {
        at?.(k);
        p.process([[x.subarray(k * Q, (k + 1) * Q)]], [[o]]);
        out.set(o, k * Q);
        for (; seen < port.posted.length; seen++) {
            const m = port.posted[seen];
            if (m.t === 's') due.push({ at: k + 1, m: { t: 'ack', id: m.id, ok: true, effectiveNoise: 2 } });
            else if (m.t === 'f') {
                const pcm = host(m.seq as number, m.pcm as Float32Array); // the host always processes the frame (its timeline must not skip), it may withhold the answer
                if (pcm) due.push({ at: k + 1, m: { t: 'o', seq: m.seq, ts: m.ts, pcm, st: 0, us: 100 } });
            }
        }
        for (const d of due.filter(d => d.at <= k + 1)) { due.splice(due.indexOf(d), 1); port.onmessage!({ data: d.m }); }
    }
    return out;
}

/** Lag (samples) of y against x within [lo, hi], by cross-correlation over x[a, a + n). */
function lagNear(x: Float32Array, y: Float32Array, a: number, n: number, lo: number, hi: number): number {
    let best = -Infinity, lag = lo;
    for (let l = lo; l <= hi; l++) {
        let c = 0; for (let i = 0; i < n; i += 3) c += x[a + i] * y[a + i + l];
        if (c > best) { best = c; lag = l; }
    }
    return lag;
}

/** Output time at which the block of `blockFrames` frames numbered k starts. */
const blockStart = (k: number, blockFrames: number) => NATP + FRAME * blockFrames * k;
/** The lag measured inside block k (frames [k*bf, (k+1)*bf)): the window sits 2000..2000+n samples after the block's start. */
function blockLag(x: Float32Array, y: Float32Array, k: number, bf: number, around: number, tol = 150): number {
    const a = blockStart(k, bf) + 2000 - around;
    return lagNear(x, y, a, 60000, around - tol, around + tol);
}

describe('Strong hand-off is time-aligned with the Light safety net (real worklet, real wasm for both engines)', () => {
    it('the engines delay as the constants say, and the worklet reserves the difference', async () => {
        const host = await strongHost();
        expect(host.delay).toBe(CL_STRONG_ENGINE_DELAY_SAMPLES);
        const { p } = await setup();
        const ready = ofType(p, 'ready')[0];
        const align = CL_STRONG_ENGINE_DELAY_SAMPLES - CL_AUDIO_ENGINE_DELAY_SAMPLES.light;
        expect(ready).toMatchObject({ delaySamples: CL_AUDIO_ENGINE_DELAY_SAMPLES.light, nativeAlignSamples: align, primeSamples: NATP + align });
    });

    it('the in-page engine never runs Strong: a Strong request runs Light (delay 480, effective profile Light), with or without the worker', async () => {
        for (const native of [true, false]) {
            const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet',
                { wasmBytes: clAudioWasmBytes(), testAssumeSpeech: true, settings: { noise: 2, autoGain: true, manualGainDb: 0, originalSound: false }, ...(native ? { native: true, nativeJitterFrames: J, nativeDelaySamples: CL_STRONG_ENGINE_DELAY_SAMPLES } : {}) });
            await waitFor(() => !!p.ready || !!p.failed, 30_000);
            const x = speech(2.5);
            const o = new Float32Array(Q);
            for (let k = 0; k * Q + Q <= x.length; k++) p.process([[x.subarray(k * Q, (k + 1) * Q)]], [[o]]);
            expect(ofType(p, 'ready')[0]).toMatchObject({ delaySamples: CL_AUDIO_ENGINE_DELAY_SAMPLES.light });
            expect(ofType(p, 'stats').at(-1)).toMatchObject({ effectiveNoise: 1, delaySamples: CL_AUDIO_ENGINE_DELAY_SAMPLES.light });
        }
    });

    it('a Strong stretch and a Light stretch hold the SAME moment of input, and so does a mix of both (blocks of 1.5 s alternate)', async () => {
        const x = speech(14);
        const BF = 150;
        const run = async (answers: (seq: number) => boolean) => {
            const host = await strongHost();
            const { p, port } = await setup();
            const y = drive(p, port, x, host.delay, (seq, pcm) => { const r = host.process(pcm); return answers(seq) ? r : null; });
            return { y, st: ofType(p, 'stats').at(-1)!.native as Record<string, number> };
        };
        const lags = async (answers: (seq: number) => boolean, ks: number[]) => {
            const { y, st } = await run(answers);
            return { lags: ks.map(k => blockLag(x, y, k, BF, L_STRONG)), st };
        };
        const ks = [1, 2, 3, 4, 5, 6, 7, 8];
        const allStrong = await lags(() => true, ks);
        const allLight = await lags(() => false, ks);
        const mixed = await lags(seq => Math.floor(seq / BF) % 2 === 0, ks);   // even blocks Strong, odd blocks Light

        // the Strong stretches sit where the reported latency says
        for (const l of allStrong.lags) expect(Math.abs(l - L_STRONG)).toBeLessThanOrEqual(6);
        expect(allStrong.st.underrun).toBe(0);
        // Light, when substituted for every frame, sits at the SAME place (it is nonlinear: a few samples of tolerance)
        for (const l of allLight.lags) expect(Math.abs(l - L_STRONG)).toBeLessThanOrEqual(6);
        expect(allLight.st.played).toBe(0);
        // and in the mix, every block, whichever engine it came from, is the same moment: no repeated or skipped audio at a switch
        const all = mixed.lags;
        expect(Math.max(...all) - Math.min(...all)).toBeLessThanOrEqual(8);
        for (const l of all) expect(Math.abs(l - L_STRONG)).toBeLessThanOrEqual(6);
        expect(mixed.st.played).toBeGreaterThan(300);
        expect(mixed.st.underrun).toBeGreaterThan(300);
    });

    it('control: WITHOUT the alignment the same mix is 480 samples (10 ms) apart (the extra frame rnnoise-wasm waits), so the test above can see a misalignment', async () => {
        const x = speech(9);
        const BF = 150;
        const host = await strongHost();
        // nativeDelaySamples unknown (0): the worklet takes the two engines to delay equally, as the old tests' echo host did
        const { p, port } = await setup({ nativeDelaySamples: 0 });
        const y = drive(p, port, x, host.delay, (seq, pcm) => { const r = host.process(pcm); return Math.floor(seq / BF) % 2 === 1 ? r : null; }); // block 1 Strong, 2 Light
        // measured against a window wide enough to hold both
        const wide = (k: number) => { const a = blockStart(k, BF) + 3500 - (NATP + 3072 + 45); return measureLag(x, y, a, 40000, 6000); };
        const strongLag = wide(1), lightLag = wide(2);
        expect(Math.abs(strongLag - lightLag - (CL_STRONG_ENGINE_DELAY_SAMPLES - CL_AUDIO_ENGINE_DELAY_SAMPLES.light))).toBeLessThanOrEqual(8);
    });

    it('a late frame is replaced by exactly the audio it would have been: a delayed echo host plays bit-exactly, Light fills the rest', async () => {
        // The host "processes" a frame by returning the input delayed by the engine's 3072 samples, so a played Strong sample is recognisable.
        const x = speech(6);
        const delayed = (seq: number) => { const f = new Float32Array(FRAME); for (let i = 0; i < FRAME; i++) { const j = seq * FRAME + i - CL_STRONG_ENGINE_DELAY_SAMPLES; f[i] = j >= 0 ? x[j] : 0; } return f; };
        const { p, port } = await setup();
        const y = drive(p, port, x, CL_STRONG_ENGINE_DELAY_SAMPLES, seq => delayed(seq));
        let bad = 0, n = 0;
        for (let t = NATP + FRAME * 20; t < y.length; t++) { n++; if (Math.abs(y[t] - x[t - NATP - CL_STRONG_ENGINE_DELAY_SAMPLES]) > 1e-7) bad++; }
        expect(bad / n).toBeLessThan(0.001);
        // the frames before natStart (the engine's own warm-up: its first 3072 samples are not our audio) were NOT played from Strong
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number>;
        expect(st.underrun).toBe(0);
        expect(st.played).toBeGreaterThan(400);
    });

    it('switching Strong -> Light mid-call neither clicks nor jumps in time', async () => {
        const x = speech(9);
        const host = await strongHost();
        const { p, port } = await setup();
        const kSwitch = Math.floor(5 * SR / Q);
        const y = drive(p, port, x, host.delay, (_seq, pcm) => host.process(pcm), k => { if (k === kSwitch) p.port.onmessage!({ data: { type: 'nativeOff' } }); });
        const at = kSwitch * Q;
        const maxStep = (s: number, e: number) => { let m = 0; for (let i = s + 1; i < e; i++) m = Math.max(m, Math.abs(y[i] - y[i - 1])); return m; };
        const baseline = Math.max(maxStep(3 * SR, at - 2 * SR / 10), maxStep(at + SR / 2, at + 2 * SR));
        expect(baseline).toBeGreaterThan(0.001);                       // the output is a real signal, not silence
        expect(maxStep(at - 64, at + 256)).toBeLessThanOrEqual(baseline * 1.25);
        // time: the stretch before and the stretch after the switch hold the same moment of the input
        const before = lagNear(x, y, 3 * SR - L_STRONG + 2000, 60000, L_STRONG - 150, L_STRONG + 150);
        const after = lagNear(x, y, at + SR / 2 - L_STRONG, 60000, L_STRONG - 150, L_STRONG + 150);
        expect(Math.abs(before - L_STRONG)).toBeLessThanOrEqual(6);
        expect(Math.abs(after - L_STRONG)).toBeLessThanOrEqual(6);
        // and Light keeps playing at the same (long) delay afterwards: that is the price of a switch that is not a skip
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);              // a deliberate 'off' is silent
    });

    it('a worker that reports a different delay than the one the worklet aligned to is refused (the alignment would be wrong)', async () => {
        const { p, port } = await setup();
        port.onmessage!({ data: { t: 'ready', delaySamples: 3072, effectiveNoise: 2 } }); // e.g. a worker still on FastEnhancer (3072) against a page that expects rnnoise-wasm (960)
        const failed = ofType(p, 'nativeFailed');
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ reason: 'delay-mismatch' });
    });

    it('measured end to end, Strong\'s delay is the constant the settings text is built from', async () => {
        const x = speech(10);
        const host = await strongHost();
        const { p, port } = await setup();
        const y = drive(p, port, x, host.delay, (_s, pcm) => host.process(pcm));
        const lag = lagNear(x, y, 5 * SR - L_STRONG, 60000, L_STRONG - 150, L_STRONG + 150);
        expect(Math.abs(lag - L_STRONG)).toBeLessThanOrEqual(6);
    });
});
