/**
 * Native audio engine HOST: runs in an Electron utilityProcess (never the main process, never the renderer), so an
 * engine crash cannot take the app down. It owns one `cl_audio_node.node` (crates/cl-audio-node: cl-audio with
 * DeepFilterNet "Strong") and answers 10 ms PCM frames that arrive over a MessagePort straight from the page's AudioWorklet.
 *
 * Trust boundary: the port is fed by the renderer, which must be assumed hostile. Every message goes through
 * `parseWorkletMessage` (audio-engine-protocol.ts) and only frames (480 floats), settings and numbers get through.
 * The addon never throws; it passes a bad/failed frame through and says so in `st`.
 *
 * Startup message from main (parentPort): { type: 'init', addonPath, modelPath } then { type: 'open' } with one port in
 * `ports`. Replies to main: { type: 'ready' | 'failed' | 'closed', ... }.
 */
import { parseWorkletMessage, FrameGate, NATIVE_FRAME, type HostToWorklet } from './audio-engine-protocol';

interface PortLike { postMessage(m: unknown): void; on(ev: 'message', cb: (e: { data: unknown }) => void): void; on(ev: 'close', cb: () => void): void; start(): void; close(): void }
interface ParentPort { postMessage(m: unknown): void; on(ev: 'message', cb: (e: { data: unknown; ports: PortLike[] }) => void): void }
interface Addon {
    ClAudioNode: new (rate?: number) => {
        process480(f: Float32Array): number; setSettings(s: { noise: number; autoGain: boolean; manualGainDb: number; originalSound: boolean; idleSkip: boolean }): boolean;
        setStrongModel(b: Buffer): boolean; setGate(enabled: boolean, thresholdDb: number): boolean; deviceChanged(has: boolean, db: number): void; setInitialDeviceGainDb(db: number): void;
        delaySamples(): number; failed(): boolean; lastError(): string; stats(take?: boolean): Record<string, number | boolean>;
    };
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
const hr = () => Number(process.hrtime.bigint()) / 1e6; // ms, monotonic

let engine: InstanceType<Addon['ClAudioNode']> | null = null;
let port: PortLike | null = null;
let usedOnce = false; // true after the first call: later opens start from a fresh engine state
const gate = new FrameGate();
let framesIn = 0, framesOut = 0, procUsSum = 0, procUsMax = 0, statusBad = 0;

function tell(m: Record<string, unknown>): void { try { parentPort?.postMessage(m); } catch { /* parent gone */ } }
function reply(m: HostToWorklet): void { try { port?.postMessage(m); } catch { /* port closed */ } }

function init(addonPath: string, modelPath: string | null): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native addon, loaded lazily in the utility process only
        const addon = require(addonPath) as Addon;
        const e = new addon.ClAudioNode(48000);
        if (e.failed()) throw new Error('engine failed to build: ' + e.lastError());
        let modelOk = false;
        if (modelPath) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- node built-in
            const fs = require('node:fs') as typeof import('node:fs');
            try { modelOk = e.setStrongModel(fs.readFileSync(modelPath)); } catch { modelOk = false; }
        }
        // Strong, auto gain on by default; the page sends its real settings right after 'open'.
        e.setSettings({ noise: 2, autoGain: true, manualGainDb: 0, originalSound: false, idleSkip: true });
        engine = e;
        tell({ type: 'ready', modelOk, delaySamples: e.delaySamples(), effectiveNoise: Number(e.stats(false).effectiveNoise) });
    } catch (err) {
        tell({ type: 'failed', error: String((err as Error)?.message ?? err).slice(0, 200) });
    }
}

function onFrame(seq: number, ts: number, pcm: Float32Array): void {
    framesIn++;
    if (!engine) return;
    const t0 = hr();
    const v = gate.judge(seq, Date.now(), ts); // after a ~1 s settings rebuild the queued frames are stale and dropped here
    if (v.act === 'drop') return;
    let st = 2;
    try { st = engine.process480(pcm); } catch { st = 2; } // in place; the addon does not throw for bad values, a type error here would be our own bug
    const us = (hr() - t0) * 1000;
    procUsSum += us; if (us > procUsMax) procUsMax = us;
    if (st !== 0) statusBad++;
    framesOut++;
    reply({ t: 'o', seq, ts, pcm, st: st === 0 ? 0 : st === 1 ? 1 : 2, us });
    if (st === 2 || engine.failed()) { tell({ type: 'failed', error: 'engine failed: ' + engine.lastError() }); engine = null; }
}

function onPortMessage(raw: unknown): void {
    const m = parseWorkletMessage(raw);
    if (!m) return;
    try { handle(m); } catch (err) {
        // the addon does not throw for bad values; anything that does is a bug here: stop answering and let the page fall back
        tell({ type: 'failed', error: 'host exception: ' + String((err as Error)?.message ?? err).slice(0, 120) });
        engine = null;
    }
}

function handle(m: NonNullable<ReturnType<typeof parseWorkletMessage>>): void {
    switch (m.t) {
        case 'f': onFrame(m.seq, m.ts, m.pcm); break;
        case 's': {
            if (!engine) break;
            const ok = engine.setSettings({ noise: m.noise, autoGain: m.autoGain, manualGainDb: m.manualGainDb, originalSound: m.originalSound, idleSkip: true });
            reply({ t: 'ack', id: m.id, ok, effectiveNoise: Number(engine.stats(false).effectiveNoise) });
            break;
        }
        case 'sl': if (engine) engine.setSettings({ noise: m.noise, autoGain: m.autoGain, manualGainDb: m.manualGainDb, originalSound: m.originalSound, idleSkip: true }); break;
        case 'dc': if (engine) engine.deviceChanged(m.hasGain, m.gainDb); break;
        case 'gate': if (engine) engine.setGate(m.enabled, m.thresholdDb); break;
        case 'g': if (engine) engine.setInitialDeviceGainDb(m.db); break;
        case 'stats': {
            if (!engine) break;
            const s = engine.stats(false);
            reply({ t: 'stats', ...s, framesIn, framesOut, procUsAvg: framesOut ? procUsSum / framesOut : 0, procUsMax, statusBad,
                dropDup: gate.dropped.dup, dropOld: gate.dropped.old, dropStale: gate.dropped.stale, lost: gate.lost,
                rssMb: Math.round(process.memoryUsage().rss / 1048576) } as HostToWorklet);
            procUsSum = 0; procUsMax = 0; framesIn = 0; framesOut = 0;
            break;
        }
        case 'bye': closePort(); break;
    }
}

function closePort(): void {
    if (port) { try { port.close(); } catch { /* closed */ } port = null; }
    gate.reset();
    tell({ type: 'closed' });
}

function openPort(p: PortLike): void {
    if (port) { try { port.close(); } catch { /* closed */ } }
    port = p;
    gate.reset();
    // A new call must not inherit the previous call's learned state (device gain, level trackers, DeepFilterNet's recurrent state): the host
    // process outlives a call by up to 30 s. deviceChanged() restarts everything (about 1 s for the Strong model; the page's frames queue meanwhile
    // and the stale gate drops what is too old).
    if (engine && usedOnce) { try { engine.deviceChanged(false, 0); } catch { /* the addon does not throw for bad values */ } }
    usedOnce = true;
    p.on('message', (e) => onPortMessage(e.data));
    p.on('close', () => { if (port === p) { port = null; gate.reset(); tell({ type: 'closed' }); } });
    p.start();
    if (engine) reply({ t: 'ready', delaySamples: engine.delaySamples(), effectiveNoise: Number(engine.stats(false).effectiveNoise) });
    else reply({ t: 'failed', error: 'engine not ready' });
}

if (parentPort) {
    parentPort.on('message', (e) => {
        const d = e.data as { type?: unknown; addonPath?: unknown; modelPath?: unknown } | null;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'init' && typeof d.addonPath === 'string') init(d.addonPath, typeof d.modelPath === 'string' ? d.modelPath : null);
        else if (d.type === 'open' && e.ports && e.ports[0]) openPort(e.ports[0]);
        else if (d.type === 'close') closePort();
    });
}
void NATIVE_FRAME;
