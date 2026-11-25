import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { clNativeStrongLatencySamples, clNativeStrongLatencyMs, CL_NATIVE_JITTER_FRAMES, CL_STRONG_ENGINE_DELAY_SAMPLES, CL_AUDIO_PRIME_SAMPLES, CL_AUDIO_UNREPORTED_SAMPLES } from './clAudioLatency';

// the page hands the worker the engine's wasm bytes; the real loader decodes 3.9 MB of base64, a stand-in is enough here
const WASM = new ArrayBuffer(8);
vi.mock('./clAudioSources', () => ({ loadClAudioWasmBytes: async () => WASM.slice(0) }));

/** A stand-in Worker: records what it is sent; the test answers through `onmessage` / `onerror`. */
class FakeWorker {
    static last: FakeWorker | null = null;
    static made = 0;
    sent: { data: unknown; transfer?: unknown[] }[] = [];
    terminated = false;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { FakeWorker.last = this; FakeWorker.made++; }
    postMessage(data: unknown, transfer?: unknown[]) { this.sent.push({ data, transfer }); }
    terminate() { this.terminated = true; }
}
class FakeChannel { port1 = { id: 'worker-end' }; port2 = { id: 'worklet-end' }; }

function stubPlatform() {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('MessageChannel', FakeChannel);
    vi.stubGlobal('document', { baseURI: 'http://127.0.0.1:42917/' });
}
async function load() { vi.resetModules(); return import('./clAudioNative'); }
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeEach(() => { FakeWorker.last = null; FakeWorker.made = 0; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('page side of Strong (worker): every failure is "keep the engine\'s own Strong"', () => {
    it('available wherever the platform has Workers, WebAssembly and MessageChannel: the engine is inside the page, there is no file to look for', async () => {
        stubPlatform();
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        expect(await (await load()).nativeEngineStatus()).toEqual({ available: true });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('no Worker on this platform: not available, no port, nothing throws', async () => {
        stubPlatform();
        vi.stubGlobal('Worker', undefined);
        const m = await load();
        expect(await m.nativeEngineStatus()).toEqual({ available: false, reason: 'no-bridge' });
        expect(await m.openNativeEngine(50)).toBeNull();
        expect(FakeWorker.made).toBe(0);
    });

    it('open: starts the worker, hands it the engine bytes (transferred), waits for ready, gives it one end of a channel and returns the other', async () => {
        stubPlatform();
        const m = await load();
        const p = m.openNativeEngine(1000);
        await tick();
        const w = FakeWorker.last!;
        const init = w.sent[0].data as { type: string; wasm: ArrayBuffer };
        expect(init.type).toBe('init');
        expect(init.wasm).toBeInstanceOf(ArrayBuffer);
        expect(init.wasm.byteLength).toBe(WASM.byteLength);
        expect(w.sent[0].transfer).toEqual([init.wasm]);
        expect(Object.keys(init).sort()).toEqual(['type', 'wasm']);   // no model URL, no engine URL: nothing to fetch
        w.onmessage!({ data: { type: 'ready', delaySamples: CL_STRONG_ENGINE_DELAY_SAMPLES } });
        expect((await p)!.port).toEqual({ id: 'worklet-end' });
        expect(w.sent[1]).toEqual({ data: { type: 'open' }, transfer: [{ id: 'worker-end' }] });
        expect(FakeWorker.made).toBe(1);
    });

    // Report 348d6f9b (2026-11-25): the Settings page's mic preview builds its own voice processor with the call's settings. It used to be
    // handed the call's (one, shared) worker, whose open closes the previous port: the call's Strong went silent (paused, Light), the
    // preview's close terminated the worker under the call, and the next settings change on the call timed out into "Switched to Light".
    it('two owners (a call and the Settings preview) get two workers: one owner\'s open, close or failure never touches the other', async () => {
        stubPlatform();
        const m = await load();
        const pCall = m.openNativeEngine(1000);
        await tick();
        const wCall = FakeWorker.last!;
        wCall.onmessage!({ data: { type: 'ready' } });
        const call = (await pCall)!;
        const callExit = vi.fn();
        call.onExit(callExit);

        const pPreview = m.openNativeEngine(1000);
        await tick();
        const wPreview = FakeWorker.last!;
        expect(wPreview).not.toBe(wCall);
        expect(FakeWorker.made).toBe(2);
        wPreview.onmessage!({ data: { type: 'ready' } });
        const preview = (await pPreview)!;
        // the preview's open went to ITS worker; the call's worker was asked to open exactly once
        expect(wCall.sent.filter(x => (x.data as { type: string }).type === 'open')).toHaveLength(1);
        expect(wPreview.sent.filter(x => (x.data as { type: string }).type === 'open')).toHaveLength(1);

        // closing the preview stops only the preview's worker, and quietly
        preview.close();
        expect(wPreview.terminated).toBe(true);
        expect(wCall.terminated).toBe(false);
        expect(callExit).not.toHaveBeenCalled();

        // a preview worker dying is not the call's business either
        const p3 = m.openNativeEngine(1000);
        await tick();
        const w3 = FakeWorker.last!;
        w3.onmessage!({ data: { type: 'ready' } });
        const third = (await p3)!;
        const thirdExit = vi.fn();
        third.onExit(thirdExit);
        w3.onmessage!({ data: { type: 'failed', error: 'engine stopped' } });
        expect(thirdExit).toHaveBeenCalledWith('engine-failed');
        expect(callExit).not.toHaveBeenCalled();
        expect(wCall.terminated).toBe(false);
    });

    it('open is null, and the worker is stopped, when it reports failure or does not get ready in time', async () => {
        stubPlatform();
        let m = await load();
        let p = m.openNativeEngine(1000);
        await tick();
        FakeWorker.last!.onmessage!({ data: { type: 'failed', error: 'engine failed to build' } });
        expect(await p).toBeNull();
        expect(FakeWorker.last!.terminated).toBe(true);

        vi.useFakeTimers();
        m = await load();
        p = m.openNativeEngine(1000);
        await vi.advanceTimersByTimeAsync(1001);
        expect(await p).toBeNull();
        expect(FakeWorker.last!.terminated).toBe(true);
    });

    it('a worker that dies mid-call tells the listeners once; close stops it quietly', async () => {
        stubPlatform();
        const m = await load();
        const p = m.openNativeEngine(1000);
        await tick();
        const w = FakeWorker.last!;
        w.onmessage!({ data: { type: 'ready' } });
        const e = (await p)!;
        const cb = vi.fn();
        const off = e.onExit(cb);
        w.onmessage!({ data: { type: 'failed', error: 'engine stopped' } });
        w.onmessage!({ data: { type: 'failed', error: 'engine stopped' } });
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith('engine-failed');
        expect(w.terminated).toBe(true);
        off();

        const p2 = m.openNativeEngine(1000);
        await tick();
        const w2 = FakeWorker.last!;
        w2.onmessage!({ data: { type: 'ready' } });
        const e2 = (await p2)!;
        const cb2 = vi.fn();
        e2.onExit(cb2);
        e2.close();
        e2.close();
        expect(w2.terminated).toBe(true);
        expect(cb2).not.toHaveBeenCalled();
    });

    it('only v2 + noise suppression on + Strong asks for the worker', async () => {
        const { wantsNativeStrong } = await load();
        expect(wantsNativeStrong({ audioEngine: 'v2', noiseSuppression: true, noiseSuppressionMode: 'strong' })).toBe(true);
        expect(wantsNativeStrong({ audioEngine: 'v2', noiseSuppression: true, noiseSuppressionMode: 'light' })).toBe(false);
        expect(wantsNativeStrong({ audioEngine: 'v2', noiseSuppression: false, noiseSuppressionMode: 'strong' })).toBe(false);
        expect(wantsNativeStrong({ audioEngine: 'legacy', noiseSuppression: true, noiseSuppressionMode: 'strong' })).toBe(false);
    });

    it('Strong\'s delay is the buffering every mode pays, the reserved hand-off frames, the model\'s own 960 samples and the unreported look-ahead', () => {
        const samples = CL_AUDIO_PRIME_SAMPLES + 480 * CL_NATIVE_JITTER_FRAMES + CL_STRONG_ENGINE_DELAY_SAMPLES + CL_AUDIO_UNREPORTED_SAMPLES;
        expect(clNativeStrongLatencySamples()).toBe(samples);
        expect(clNativeStrongLatencyMs()).toBeCloseTo(samples / 48, 6);
        expect(Math.round(clNativeStrongLatencyMs())).toBe(60);
    });

    it('a worker that cannot get the engine bytes ends the open with null, and is stopped', async () => {
        stubPlatform();
        vi.resetModules();
        vi.doMock('./clAudioSources', () => ({ loadClAudioWasmBytes: async () => { throw new Error('no engine'); } }));
        const m = await import('./clAudioNative');
        expect(await m.openNativeEngine(1000)).toBeNull();
        expect(FakeWorker.last!.terminated).toBe(true);
        vi.doUnmock('./clAudioSources');
    });
});
