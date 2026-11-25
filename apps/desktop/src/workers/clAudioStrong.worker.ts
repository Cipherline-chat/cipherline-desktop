/**
 * "Strong" noise suppression: RNNoise's current model (`@shiguredo/rnnoise-wasm`, the package the app used for its one
 * noise suppression until 2026-10-19; the owner 2026-11-24: "on strong we should go back to the old one ... it was
 * rnnoise-wasm"), in a worker thread of the page, feeding the call-audio engine's Strong chain (auto gain, compressor,
 * limiter: the same as Light's). Light runs the engine's own RNNoise, the 2017 model. Plain web
 * platform (a Worker, a MessagePort, WebAssembly), so it is the same code in Electron and in the Rust app's webview.
 *
 * The engine is the SAME wasm binary the audio worklet runs (src/audio/engine/cl_audio.wasm), asked for the Strong profile
 * with its noise model fed from outside (`cla_set_external_strong`): each 10 ms frame goes through RNNoise here first,
 * the result is handed over (`cla_ext_ptr` + `cla_set_ext`), then the same frame is pushed (`cla_push`).
 *
 * Why a worker: the newer RNNoise model is several times the work of the 2017 one, too much to add to the audio thread's
 * 2.7 ms slots next to Light. The
 * audio worklet (audio/clAudioWorklet.js, "native mode") sends each 10 ms frame here over a MessagePort and plays the
 * answer; whenever an answer is late it plays the Light frame of the same slot, which it computes anyway and keeps
 * time-aligned with this engine's delay (960 samples: rnnoise-wasm answers one frame later than Light's RNNoise). So a busy PC costs a moment of Light, never a gap.
 *
 * Every frame is processed, in order, even a late one: the worklet has already played Light for it, but a frame that is
 * skipped would shift this engine's timeline against the Light one for the rest of the call. A frame costs well under
 * its 10 ms, so a stall clears itself.
 *
 * The wire protocol is the one the retired utility-process host spoke (electron/audio-engine-protocol.ts): the
 * worklet does not know or care which kind of peer it has. Nothing here logs or stores audio.
 *
 * From the page:  { type: 'init', wasm: ArrayBuffer }   ->  { type: 'ready', delaySamples } | { type: 'failed', error }
 *                 { type: 'open' } + one MessagePort     (the other end goes to the worklet)
 *                 { type: 'close' }
 */
import { Rnnoise, type DenoiseState } from '@shiguredo/rnnoise-wasm';
import { parseWorkletMessage, FrameGate, NATIVE_FRAME, type HostToWorklet, type WorkletToHost } from '../../electron/audio-engine-protocol';

interface Engine {
    memory: WebAssembly.Memory;
    cla_new(rate: number): number; cla_free(ctx: number): void;
    cla_in_ptr(ctx: number): number; cla_out_ptr(ctx: number): number; cla_push(ctx: number, n: number): number;
    cla_set_settings(ctx: number, noise: number, autoGain: number, manualGainDb: number, originalSound: number, idleSkip: number): number;
    cla_set_gate(ctx: number, enabled: number, thresholdDb: number): void;
    cla_device_changed(ctx: number, hasGain: number, gainDb: number): void;
    cla_set_initial_device_gain_db(ctx: number, db: number): void;
    cla_delay_samples(ctx: number): number; cla_stats(ctx: number, out: number): void;
    cla_set_external_strong(ctx: number, on: number): number; cla_ext_ptr(ctx: number): number; cla_set_ext(ctx: number, vad: number): number;
}
interface Scope {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage(m: unknown): void;
}
const scope = self as unknown as Scope;

const STRONG = 2;
let x: Engine | null = null;
let ctx = 0, inPtr = 0, outPtr = 0, statsPtr = 0, extPtr = 0;
let rn: Rnnoise | null = null;
let ds: DenoiseState | null = null;
const scratch = new Float32Array(NATIVE_FRAME);
/** a new microphone or a new call starts the model with no memory of the last one */
function freshModel(): void { try { ds?.destroy(); } catch { /* gone */ } ds = rn ? rn.createDenoiseState() : null; }
let port: MessagePort | null = null;
let usedOnce = false;
const gate = new FrameGate();
let framesIn = 0, framesOut = 0, procUsSum = 0, procUsMax = 0, statusBad = 0;

const tell = (m: Record<string, unknown>): void => { try { scope.postMessage(m); } catch { /* page gone */ } };
const reply = (m: HostToWorklet, transfer?: Transferable[]): void => { try { if (transfer) port?.postMessage(m, transfer); else port?.postMessage(m); } catch { /* port closed */ } };

/** effective noise profile as the engine reports it (word 7 of its stats block) */
function effectiveNoise(): number {
    if (!x || !ctx) return -1;
    x.cla_stats(ctx, statsPtr);
    return new Uint32Array(x.memory.buffer, statsPtr, 16)[7];
}

async function init(wasm: ArrayBuffer): Promise<void> {
    try {
        const [{ instance }, r] = await Promise.all([WebAssembly.instantiate(wasm, {}), Rnnoise.load()]);
        if (r.frameSize !== NATIVE_FRAME) throw new Error('RNNoise frame size ' + r.frameSize);
        rn = r; freshModel();
        const e = instance.exports as unknown as Engine;
        const c = e.cla_new(48000);
        if (!c) throw new Error('engine failed to build');
        if (e.cla_set_external_strong(c, 1) !== 1) throw new Error('engine has no outside noise model hook');
        // Strong, auto gain on; the worklet sends the call's real settings as soon as the port opens
        if (e.cla_set_settings(c, STRONG, 1, 0, 0, 1) !== 1) throw new Error('Strong could not be built');
        x = e; ctx = c; extPtr = e.cla_ext_ptr(c); inPtr = e.cla_in_ptr(c); outPtr = e.cla_out_ptr(c); statsPtr = inPtr + 2048 * 4; // scratch: the unused half of the input buffer
        if (effectiveNoise() !== STRONG) throw new Error('engine did not select Strong');
        tell({ type: 'ready', delaySamples: e.cla_delay_samples(c) });
    } catch (err) {
        x = null; ctx = 0;
        try { ds?.destroy(); } catch { /* gone */ } ds = null; rn = null;
        tell({ type: 'failed', error: String((err as Error)?.message ?? err).slice(0, 200) });
    }
}

function onFrame(seq: number, ts: number, pcm: Float32Array): void {
    framesIn++;
    if (!x || !ctx) return;
    const t0 = performance.now();
    const v = gate.judge(seq, Date.now(), ts);
    if (v.act === 'drop') {
        if (v.why !== 'stale') return;  // a duplicate or an old one
        gate.lastSeq = seq;             // late, but still part of the stream: process it (see the top of this file); judge() counted it as stale
    }
    if (ds) {
        // RNNoise takes 16-bit-scaled samples; its answer is the denoised frame (one frame late, as in the engine's own RNNoise)
        for (let i = 0; i < NATIVE_FRAME; i++) scratch[i] = pcm[i] * 32768;
        const vad = ds.processFrame(scratch);
        const ext = new Float32Array(x.memory.buffer, extPtr, NATIVE_FRAME);
        for (let i = 0; i < NATIVE_FRAME; i++) ext[i] = scratch[i] / 32768;
        x.cla_set_ext(ctx, vad);
    }
    new Float32Array(x.memory.buffer, inPtr, NATIVE_FRAME).set(pcm);
    const n = x.cla_push(ctx, NATIVE_FRAME);
    let st: 0 | 1 = 0;
    if (n === NATIVE_FRAME) pcm.set(new Float32Array(x.memory.buffer, outPtr, NATIVE_FRAME)); else st = 1; // st 1: the frame goes back untouched
    const us = (performance.now() - t0) * 1000;
    procUsSum += us; if (us > procUsMax) procUsMax = us;
    if (st !== 0) statusBad++;
    framesOut++;
    reply({ t: 'o', seq, ts, pcm, st, us }, [pcm.buffer]);
}

function handle(m: WorkletToHost): void {
    if (!x || !ctx) return;
    switch (m.t) {
        case 'f': onFrame(m.seq, m.ts, m.pcm); break;
        case 's': {
            const ok = x.cla_set_settings(ctx, m.noise, m.autoGain ? 1 : 0, m.manualGainDb, m.originalSound ? 1 : 0, 1) === 1;
            reply({ t: 'ack', id: m.id, ok, effectiveNoise: effectiveNoise() });
            break;
        }
        // the mic volume with auto gain on: the engine retargets its pre-gain on the running chain; nothing restarts, nothing to answer
        case 'sl': x.cla_set_settings(ctx, m.noise, m.autoGain ? 1 : 0, m.manualGainDb, m.originalSound ? 1 : 0, 1); break;
        case 'dc': x.cla_device_changed(ctx, m.hasGain ? 1 : 0, m.gainDb); freshModel(); break;
        case 'gate': x.cla_set_gate(ctx, m.enabled ? 1 : 0, m.thresholdDb); break;
        case 'g': x.cla_set_initial_device_gain_db(ctx, m.db); break;
        case 'stats': {
            x.cla_stats(ctx, statsPtr);
            const f = new Float32Array(x.memory.buffer, statsPtr, 16), u = new Uint32Array(x.memory.buffer, statsPtr, 16);
            reply({ t: 'stats', framesIn, framesOut, procUsAvg: framesOut ? procUsSum / framesOut : 0, procUsMax, statusBad,
                dropDup: gate.dropped.dup, dropOld: gate.dropped.old, dropStale: gate.dropped.stale, lost: gate.lost,
                effectiveNoise: u[7], speechProb: f[10], watchdogFrames: 0, rssMb: Math.round(x.memory.buffer.byteLength / 1048576) });
            procUsSum = 0; procUsMax = 0; framesIn = 0; framesOut = 0;
            break;
        }
        case 'bye': closePort(); break;
    }
}

function closePort(): void {
    if (port) { try { port.close(); } catch { /* closed */ } port = null; }
    gate.reset();
}

function openPort(p: MessagePort): void {
    closePort();
    port = p;
    // a new call must not inherit the last call's learned level or the model's memory
    if (x && ctx && usedOnce) { x.cla_device_changed(ctx, 0, 0); freshModel(); }
    usedOnce = true;
    p.onmessage = (e) => {
        const m = parseWorkletMessage(e.data);
        if (!m) return;
        try { handle(m); } catch (err) {
            // a trap inside the engine: stop answering, the worklet plays Light and reports it
            x = null; ctx = 0;
            tell({ type: 'failed', error: 'engine stopped: ' + String((err as Error)?.message ?? err).slice(0, 120) });
        }
    };
    if (x && ctx) reply({ t: 'ready', delaySamples: x.cla_delay_samples(ctx), effectiveNoise: effectiveNoise() });
    else reply({ t: 'failed', error: 'engine not ready' });
}

scope.onmessage = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; wasm?: unknown } | null;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'init' && d.wasm instanceof ArrayBuffer) void init(d.wasm);
    else if (d.type === 'open' && e.ports && e.ports[0]) openPort(e.ports[0]);
    else if (d.type === 'close') closePort();
};
