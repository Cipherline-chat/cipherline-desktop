import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { SPEEX_LIGHT_WORKLET_SOURCE } from './speexLightWorkletSource';
import { RNNOISE_INLINE_WORKLET_SOURCE } from './rnnoiseInWorkletSource';
import { speexWasmBytes } from './speexWasm';
import { SPEEX_WASM_BASE64, SPEEX_WASM_PACKAGE_VERSION } from './speexWasmBase64';
import { NS_LATENCY_SAMPLES, NS_SAMPLE_RATE, SPEEX_FRAME, nsLatencyMs, formatLatencyMs } from './nsLatency';
import { isAscii } from './asciiJsSource';

/**
 * Drives the REAL worklet processors in Node (same technique as
 * rnnoiseInWorkletSource.smoke.test.ts: the assembled source is evaluated as a
 * genuine ES module) at 128-sample render quanta. This is what keeps the latency
 * numbers Settings shows honest, and proves Light actually denoises while keeping
 * whistles / whispers.
 *
 * Signals are synthetic (no microphone in CI): they measure what is removed, not
 * how it sounds.
 */

// These drive real WASM through hundreds of thousands of samples; allow for a loaded CI box.
vi.setConfig({ testTimeout: 30_000 });

const SR = NS_SAMPLE_RATE;
const Q = 128;

type Proc = {
    port: { onmessage: ((m: { data: unknown }) => void) | null };
    process: (i: Float32Array[][], o: Float32Array[][]) => boolean;
    ready?: boolean; rnnoiseReady?: boolean;
    _msgs: Array<{ type: string; error?: string }>;
};

const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => { for (const k of ['registerProcessor', 'AudioWorkletProcessor', 'sampleRate']) delete g[k]; });

async function loadProcessor(src: string, name: string): Promise<Proc> {
    let Ctor: (new (opts?: unknown) => Proc) | undefined;
    g.registerProcessor = (n: string, c: unknown) => { if (n === name) Ctor = c as typeof Ctor; };
    g.AudioWorkletProcessor = class {
        _msgs: unknown[] = [];
        port = { onmessage: null, postMessage: (m: unknown) => { this._msgs.push(m); } };
    };
    g.sampleRate = SR;
    const f = join(tmpdir(), `ns-worklet-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(f, src);
    try { await import(/* @vite-ignore */ `file://${f}`); } finally { unlinkSync(f); }
    if (!Ctor) throw new Error(`${name} did not register`);
    return new Ctor({ processorOptions: {} });
}

const waitFor = async (cond: () => boolean, ms = 4000) => {
    for (let t = 0; t < ms && !cond(); t += 20) await new Promise(r => setTimeout(r, 20));
    if (!cond()) throw new Error('timed out waiting for worklet');
};

async function lightProcessor(enabled = true): Promise<Proc> {
    const p = await loadProcessor(SPEEX_LIGHT_WORKLET_SOURCE, 'speex-light-worklet');
    p.port.onmessage!({ data: { type: 'init', wasm: speexWasmBytes() } });
    await waitFor(() => !!p.ready);
    if (enabled) p.port.onmessage!({ data: { type: 'toggle', enabled: true } });
    return p;
}

async function strongProcessor(): Promise<Proc> {
    const p = await loadProcessor(RNNOISE_INLINE_WORKLET_SOURCE, 'rnnoise-inline-worklet');
    await waitFor(() => !!p.rnnoiseReady, 8000);
    p.port.onmessage!({ data: { type: 'toggle', enabled: true } });
    return p;
}

function run(p: Proc, x: Float32Array): Float32Array {
    const y = new Float32Array(x.length);
    for (let o = 0; o + Q <= x.length; o += Q) {
        const out = new Float32Array(Q);
        p.process([[x.subarray(o, o + Q)]], [[out]]);
        y.set(out, o);
    }
    return y;
}

let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) * 1.4142; };
const rms = (a: Float32Array, s = 0, e = a.length) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / Math.max(1, e - s)); };
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

/** Voiced-speech-like signal with a gliding pitch (so correlation has a unique peak) over a faint hiss. */
function speechLike(secs: number): Float32Array {
    const n = SR * secs, x = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) {
        const t = i / SR, f0 = 120 + 50 * (t / secs) + 8 * Math.sin(2 * Math.PI * 0.9 * t);
        ph += 2 * Math.PI * f0 / SR;
        let v = 0; for (let h = 1; h <= 25; h++) v += Math.sin(h * ph) / h;
        const env = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * 3.1 * t), 0.7);
        x[i] = 0.07 * env * v + 0.0015 * gauss();
    }
    return x;
}

function measureLagSamples(x: Float32Array, y: Float32Array): number {
    // 1 s of signal, every 3rd sample, every lag 0..3000: sample-accurate and ~10x cheaper
    // than correlating the whole tail, which matters when the full suite runs in parallel.
    const a = SR * 2, n = SR; let best = -Infinity, lag = 0;
    for (let l = 0; l <= 3000; l++) {
        let c = 0; for (let i = 0; i < n; i += 3) c += x[a + i] * y[a + i + l];
        if (c > best) { best = c; lag = l; }
    }
    return lag;
}

describe('Speex vendor assets', () => {
    it('speexWasmBase64.ts matches the installed package (run scripts/gen-speex-wasm.mjs after a bump)', () => {
        const req = createRequire(import.meta.url);
        const wasmPath = req.resolve('@sapphi-red/speex-preprocess-wasm/speex.wasm');
        const onDisk = readFileSync(wasmPath);
        expect(SPEEX_WASM_BASE64).toBe(onDisk.toString('base64'));
        const pkg = JSON.parse(readFileSync(join(wasmPath, '..', '..', 'package.json'), 'utf8'));
        expect(SPEEX_WASM_PACKAGE_VERSION).toBe(pkg.version);
        const bytes = new Uint8Array(speexWasmBytes());
        expect(Array.from(bytes.slice(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]); // \0asm
    });

    it('the assembled worklet template is pure ASCII (one byte per char in renderer memory)', () => {
        expect(isAscii(SPEEX_LIGHT_WORKLET_SOURCE)).toBe(true);
    });
});

describe('Light (Speex) worklet', () => {
    it('passes audio through bit-exactly while disabled, without doing any work', async () => {
        const p = await lightProcessor(false);
        const x = speechLike(1);
        expect(Array.from(run(p, x).subarray(0, 4096))).toEqual(Array.from(x.subarray(0, 4096)));
    });

    it('passes audio through bit-exactly before its WASM has arrived, even if enabled', async () => {
        const p = await loadProcessor(SPEEX_LIGHT_WORKLET_SOURCE, 'speex-light-worklet');
        p.port.onmessage!({ data: { type: 'toggle', enabled: true } });
        const x = speechLike(1);
        expect(Array.from(run(p, x).subarray(0, 4096))).toEqual(Array.from(x.subarray(0, 4096)));
    });

    it('reports loadFailed (and keeps passing audio through) when the WASM is garbage', async () => {
        const p = await loadProcessor(SPEEX_LIGHT_WORKLET_SOURCE, 'speex-light-worklet');
        p.port.onmessage!({ data: { type: 'init', wasm: new Uint8Array([1, 2, 3, 4]).buffer } });
        await waitFor(() => p._msgs.some(m => m.type === 'loadFailed'));
        p.port.onmessage!({ data: { type: 'toggle', enabled: true } });
        const x = speechLike(1);
        expect(Array.from(run(p, x).subarray(0, 2048))).toEqual(Array.from(x.subarray(0, 2048)));
    });

    it('adds exactly one 128-sample frame of latency', async () => {
        const p = await lightProcessor();
        const x = speechLike(6);
        expect(measureLagSamples(x, run(p, x))).toBe(SPEEX_FRAME);
        expect(SPEEX_FRAME).toBe(Q); // in-place per render quantum is what makes the cost one frame
    });

    it('lowers a steady noise floor but keeps voice, a whistle and whisper-like noise', async () => {
        const secs = 5, n = SR * secs;
        const hiss = (len: number) => { const w = new Float32Array(len); let lp = 0; for (let i = 0; i < len; i++) { const gs = gauss(); lp = 0.97 * lp + 0.03 * gs; w[i] = 0.5 * gs + 3 * lp; } const k = Math.pow(10, -55 / 20) / rms(w); return w.map(v => v * k); };
        const floor = hiss(n);
        const seg = (gen: (i: number) => number) => { const x = Float32Array.from(floor); for (let i = SR * 2; i < SR * 4; i++) x[i] += gen(i - SR * 2); return x; };
        const whistle = seg(i => 0.0251 * Math.sin(2 * Math.PI * (2600 + 60 * Math.sin(2 * Math.PI * 5 * i / SR)) * i / SR));
        const whisperNoise = (() => { const nz = new Float32Array(SR * 2); for (let i = 0; i < nz.length; i++) nz[i] = gauss(); const k = Math.pow(10, -38 / 20) / rms(nz); return nz.map((v, i) => v * k * (0.5 - 0.5 * Math.cos(2 * Math.PI * 3.5 * i / SR))); })();
        const whisper = seg(i => whisperNoise[i]);

        for (const [name, x] of [['whistle', whistle], ['whisper', whisper]] as const) {
            const y = run(await lightProcessor(), x);
            const kept = db(rms(y, SR * 2.5, SR * 4)) - db(rms(x, SR * 2.5, SR * 4));
            expect(kept, `${name} kept`).toBeGreaterThan(-1.5);
            const cut = db(rms(y, SR * 4.5, n - 1024)) - db(rms(x, SR * 4.5, n - 1024));
            expect(cut, `${name} floor cut`).toBeLessThan(-4);
        }
    });
});

describe('Strong vs Light latency (what Settings shows)', () => {
    it('the real processors add what nsLatency.ts says they do', async () => {
        const x = speechLike(6);
        const light = measureLagSamples(x, run(await lightProcessor(), x));
        const strong = measureLagSamples(x, run(await strongProcessor(), x));
        expect(light).toBe(NS_LATENCY_SAMPLES.light);
        // Strong's phase relative to the 128-sample quantum can shift it by under a quantum.
        expect(Math.abs(strong - NS_LATENCY_SAMPLES.strong)).toBeLessThanOrEqual(Q / 2);
        // The point of the feature: Light is an order of magnitude quicker.
        expect(strong / light).toBeGreaterThan(8);
    }, 60000);

    it('formats the numbers for the UI', () => {
        expect(formatLatencyMs(nsLatencyMs('light'))).toBe('2.7 ms');
        expect(formatLatencyMs(nsLatencyMs('strong'))).toBe('39 ms');
    });
});
