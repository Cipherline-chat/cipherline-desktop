import { describe, it, expect, afterEach, vi } from 'vitest';
import { clAudioWasmBytes } from '../utils/clAudioWasm';
import { CL_STRONG_ENGINE_DELAY_SAMPLES } from '../utils/clAudioLatency';

/**
 * The Strong worker's script, run in Node with the REAL engine wasm: a stand-in `self`, a stand-in MessagePort. Covers what the page
 * relies on: init from bytes, ready with the engine's real delay, settings acked as Strong, every frame answered in order (a late one
 * too: skipping it would shift the engine's timeline against the in-page Light), duplicates dropped, bad input answered with 'failed'.
 */
vi.setConfig({ testTimeout: 60_000 });

const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => { delete g.self; });

type Out = { type: string; [k: string]: unknown };
async function boot() {
    const told: Out[] = [];
    const scope = { onmessage: null as null | ((e: { data: unknown; ports?: unknown[] }) => void), postMessage: (m: Out) => { told.push(m); } };
    g.self = scope;
    vi.resetModules();
    await import('./clAudioStrong.worker');
    return { scope, told };
}
const until = async (cond: () => boolean, ms = 30_000) => { for (let t = 0; t < ms && !cond(); t += 10) await new Promise(r => setTimeout(r, 10)); if (!cond()) throw new Error('timed out'); };

function fakePort() {
    const sent: Array<Record<string, unknown>> = [];
    return { sent, onmessage: null as null | ((e: { data: unknown }) => void), postMessage(m: Record<string, unknown>) { sent.push(m); }, close() { /* no-op */ } };
}
const frame = (seq: number) => { const f = new Float32Array(480); for (let i = 0; i < 480; i++) f[i] = 0.1 * Math.sin((seq * 480 + i) * 0.05); return f; };

describe('Strong worker (clAudioStrong.worker.ts), real engine', () => {
    it('init with the engine bytes -> ready with the Strong delay; settings are acked as Strong; frames come back 480 floats at a time, in order', async () => {
        const { scope, told } = await boot();
        scope.onmessage!({ data: { type: 'init', wasm: clAudioWasmBytes() } });
        await until(() => told.length > 0);
        expect(told[0]).toEqual({ type: 'ready', delaySamples: CL_STRONG_ENGINE_DELAY_SAMPLES });

        const port = fakePort();
        scope.onmessage!({ data: { type: 'open' }, ports: [port] });
        expect(port.sent[0]).toMatchObject({ t: 'ready', delaySamples: CL_STRONG_ENGINE_DELAY_SAMPLES, effectiveNoise: 2 });
        port.onmessage!({ data: { t: 's', id: 1, noise: 2, autoGain: true, manualGainDb: 0, originalSound: false } });
        expect(port.sent.at(-1)).toMatchObject({ t: 'ack', id: 1, ok: true, effectiveNoise: 2 });

        for (let seq = 0; seq < 12; seq++) port.onmessage!({ data: { t: 'f', seq, ts: Date.now(), pcm: frame(seq) } });
        const replies = port.sent.filter(m => m.t === 'o');
        expect(replies.map(r => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        for (const r of replies) { expect((r.pcm as Float32Array).length).toBe(480); expect(r.st).toBe(0); }
    });

    it('a late frame is still processed (its answer is late, the timeline is not shifted); a duplicate and an old one are dropped', async () => {
        const { scope, told } = await boot();
        scope.onmessage!({ data: { type: 'init', wasm: clAudioWasmBytes() } });
        await until(() => told.length > 0);
        const port = fakePort();
        scope.onmessage!({ data: { type: 'open' }, ports: [port] });
        port.onmessage!({ data: { t: 'f', seq: 0, ts: Date.now(), pcm: frame(0) } });
        port.onmessage!({ data: { t: 'f', seq: 1, ts: Date.now() - 500, pcm: frame(1) } });   // 500 ms old: over the page's stale limit, still answered
        port.onmessage!({ data: { t: 'f', seq: 1, ts: Date.now(), pcm: frame(1) } });         // duplicate
        port.onmessage!({ data: { t: 'f', seq: 2, ts: Date.now(), pcm: frame(2) } });
        port.onmessage!({ data: { t: 'f', seq: 0, ts: Date.now(), pcm: frame(0) } });         // old
        expect(port.sent.filter(m => m.t === 'o').map(r => r.seq)).toEqual([0, 1, 2]);
    });

    it('bytes that are not the engine -> failed, and nothing is answered', async () => {
        const { scope, told } = await boot();
        scope.onmessage!({ data: { type: 'init', wasm: new ArrayBuffer(16) } });
        await until(() => told.length > 0);
        expect(told[0].type).toBe('failed');
        const port = fakePort();
        scope.onmessage!({ data: { type: 'open' }, ports: [port] });
        expect(port.sent[0]).toMatchObject({ t: 'failed' });
        port.onmessage!({ data: { t: 'f', seq: 0, ts: Date.now(), pcm: frame(0) } });
        expect(port.sent.some(m => m.t === 'o')).toBe(false);
    });

    it('an old-style init (URLs, no bytes) is ignored: there is nothing to load from', async () => {
        const { scope, told } = await boot();
        scope.onmessage!({ data: { type: 'init', wasmUrl: 'x', modelUrl: 'y' } });
        await new Promise(r => setTimeout(r, 50));
        expect(told).toEqual([]);
    });
});
