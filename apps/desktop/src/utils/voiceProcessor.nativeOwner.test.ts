import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Report 348d6f9b (2026-11-25, owner): "pc switched to light even though I have a good computer". Strong had no underruns; the owner had
 * the Voice settings open mid-call (EQ toggled, Input volume dragged 100 -> 196 -> 31 -> 13 -> 100 -> 200 %) and Strong was given up with
 * "ack-timeout". The Settings page builds its OWN voice processor (the mic preview) with the call's settings, so it opened Strong too, and
 * was handed the call's one shared worker, whose open closes the previous port: the call's worklet lost its engine without a word.
 *
 * Here: two real CipherlineVoiceProcessors (the call and the Settings preview) on the new engine with Strong, over a stand-in Worker. The
 * worklet itself (real wasm) is audio/clAudioWorkletNative.test.ts.
 */
vi.mock('./rnnoiseInWorkletSource', () => ({ RNNOISE_INLINE_WORKLET_SOURCE: 'registerProcessor("rnnoise-inline-worklet", class {})' }));
vi.mock('./speexLightWorkletSource', () => ({ SPEEX_LIGHT_WORKLET_SOURCE: 'registerProcessor("speex-light-worklet", class {})' }));
vi.mock('./workletModuleUrl', () => ({ workletModuleUrl: (name: string) => name, forgetWorkletModuleUrl: () => {} }));
vi.mock('./clAudioSources', () => ({
    loadClAudioWorkletSource: async () => 'registerProcessor("cl-audio-worklet", class {})',
    loadClAudioWasmBytes: async () => new ArrayBuffer(16),
}));
vi.mock('./secureLocalStore', () => {
    const mem = new Map<string, string>();
    return { default: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } } };
});

type Msg = Record<string, unknown>;
interface FakeNode { kind: string; out: FakeNode[]; msgs: Msg[]; options?: Record<string, unknown>; connect(n: FakeNode): FakeNode; disconnect(): void; [k: string]: unknown }
const param = () => ({ value: 0, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} });
function node(kind: string): FakeNode {
    const n: FakeNode = {
        kind, out: [], msgs: [],
        connect(t: FakeNode) { n.out.push(t); return t; },
        disconnect() { n.out = []; },
        gain: param(), frequency: param(), Q: param(), fftSize: 0, smoothingTimeConstant: 0, type: '',
        getFloatTimeDomainData() {},
        port: { postMessage: (m: Msg) => n.msgs.push(m), onmessage: null as ((e: { data: unknown }) => void) | null },
    };
    return n;
}
class FakeCtx {
    sampleRate = 48000;
    state: AudioContextState = 'running';
    currentTime = 0; baseLatency = 0.01; outputLatency = 0;
    registered = new Set<string>();
    addModule = vi.fn(async (name: string) => { this.registered.add(name); });
    audioWorklet = { addModule: this.addModule };
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return node('source'); }
    createGain() { return node('gain'); }
    createAnalyser() { return node('analyser'); }
    createBiquadFilter() { return node('eq'); }
    createDynamicsCompressor() { return node('compressor'); }
    createMediaStreamDestination() { return { ...node('destination'), stream: { getAudioTracks: () => [{ id: 'processed' }] } }; }
}
const clNodes: FakeNode[] = [];
function FakeWorkletNode(this: unknown, _ctx: FakeCtx, name: string, options?: Record<string, unknown>) {
    const n = node(name === 'cl-audio-worklet' ? 'cl' : name);
    n.options = options;
    if (n.kind === 'cl') clNodes.push(n);
    return n;
}

/** A stand-in Strong worker: says ready as soon as it gets the engine bytes; records opens. */
class FakeWorker {
    static all: FakeWorker[] = [];
    sent: Msg[] = [];
    terminated = false;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { FakeWorker.all.push(this); }
    postMessage(data: Msg) {
        this.sent.push(data);
        if (data.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', delaySamples: 960 } }));
    }
    terminate() { this.terminated = true; }
    get opens() { return this.sent.filter(m => m.type === 'open').length; }
}
let chan = 0;
class FakeChannel { id = ++chan; port1 = { side: 'worker', ch: this.id }; port2 = { side: 'worklet', ch: this.id }; }

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const track = () => ({ applyConstraints: async () => {}, getSettings: () => ({ deviceId: 'dev-1' }) }) as unknown as MediaStreamTrack;
const SETTINGS = {
    noiseSuppression: true, noiseSuppressionMode: 'strong' as 'strong' | 'light', volumeNormalization: true, voiceGate: false, voiceGateThreshold: -45,
    pushToTalk: false, pushToTalkKey: null, pushToMuteKey: null, micDeviceId: '', speakerDeviceId: '', cameraDeviceId: '',
    micVolume: 100, speakerVolume: 100, eqEnabled: false, eqBands: [0, 0, 0, 0, 0],
    cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100,
    audioEngine: 'v2' as 'v2' | 'legacy',
};

beforeEach(() => {
    clNodes.length = 0;
    FakeWorker.all = [];
    vi.resetModules();
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('MediaStream', class { tracks: unknown[]; constructor(t: unknown[]) { this.tracks = t; } });
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('MessageChannel', FakeChannel);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function build(callbacks: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
    const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
    const vp = new CipherlineVoiceProcessor({ ...SETTINGS } as never, callbacks as never, opts as never);
    await vp.init({ track: track(), audioContext: new FakeCtx() as unknown as AudioContext });
    await flush();
    return { vp, cl: clNodes.at(-1)! };
}
const nativePortOf = (cl: FakeNode) => cl.msgs.find(m => m.type === 'nativePort')?.port as { ch: number } | undefined;

describe('native Strong belongs to ONE voice processor (report 348d6f9b)', () => {
    it('the Settings preview opening and closing mid-call leaves the call\'s Strong worker alone', async () => {
        const onNativeFallback = vi.fn();
        const call = await build({ onNativeFallback });
        expect(call.cl.options!.processorOptions).toMatchObject({ native: true });
        const callPort = nativePortOf(call.cl);
        expect(callPort).toBeDefined();
        const callWorker = FakeWorker.all.find(w => w.opens === 1)!;
        expect(callWorker).toBeDefined();

        // Settings opened mid-call: its own processor, the same settings (v2 + Strong), with the level meter
        const preview = await build({}, { gateMeterMs: 50 });
        const previewPort = nativePortOf(preview.cl);
        expect(previewPort).toBeDefined();
        expect(previewPort!.ch).not.toBe(callPort!.ch);
        // the preview's open did not go to the call's worker (that open would have closed the call's port)
        expect(callWorker.opens).toBe(1);
        expect(FakeWorker.all.length).toBe(2);

        // the owner's slider drag and EQ toggles reach both processors (the settings hook updates the call; the page its preview)
        for (const micVolume of [100, 196, 31, 13, 100, 200]) {
            call.vp.updateSettings({ ...SETTINGS, micVolume } as never);
            preview.vp.updateSettings({ ...SETTINGS, micVolume } as never);
        }
        call.vp.updateSettings({ ...SETTINGS, micVolume: 200, eqEnabled: true } as never);
        call.vp.updateSettings({ ...SETTINGS, micVolume: 200, eqEnabled: false } as never);

        // Settings closed: the preview is destroyed; the call's worker keeps running
        await preview.vp.destroy();
        expect(callWorker.terminated).toBe(false);

        // the call never stopped Strong, never asked for a rebuild, never announced a fallback
        expect(call.cl.msgs.some(m => m.type === 'nativeOff' || m.type === 'nativeOverload')).toBe(false);
        expect(call.vp.needsEngineRebuild({ ...SETTINGS, micVolume: 200 } as never)).toBe(false);
        expect(onNativeFallback).not.toHaveBeenCalled();
        // every mic-volume move went to the worklet as plain settings (the worklet sends the host the gain live, no restart)
        const posted = call.cl.msgs.filter(m => m.type === 'setSettings').map(m => m.manualGainDb);
        expect(posted.length).toBeGreaterThanOrEqual(6);

        await call.vp.destroy();
        expect(callWorker.terminated).toBe(true);
    });

    it('a call processor that fails its own Strong closes only its own worker', async () => {
        const call = await build({ onNativeFallback: vi.fn() });
        const preview = await build({}, { gateMeterMs: 50 });
        const [wCall, wPreview] = FakeWorker.all;
        // the preview's worklet reports its Strong failed: the preview closes ITS worker
        (preview.cl.port as { onmessage: (e: { data: unknown }) => void }).onmessage({ data: { type: 'nativeFailed', reason: 'engine-failed' } });
        expect(wPreview.terminated).toBe(true);
        expect(wCall.terminated).toBe(false);
        await preview.vp.destroy();
        await call.vp.destroy();
    });
});
