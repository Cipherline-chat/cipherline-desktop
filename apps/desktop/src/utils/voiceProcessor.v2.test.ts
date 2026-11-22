import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The new audio engine ('v2') inside CipherlineVoiceProcessor: the graph it builds, the settings it forwards, what a
 * runtime failure does, and the per-microphone gain it remembers. The worklet itself (real wasm) is clAudioWorklet.test.ts.
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

import secureLocalStore from './secureLocalStore';
import { MIC_DEVICE_GAIN_KEY, loadMicDeviceGain, saveMicDeviceGain } from './micDeviceGain';

type Msg = Record<string, unknown>;
interface FakeNode { kind: string; out: FakeNode[]; msgs: Msg[]; options?: Record<string, unknown>; connect(n: FakeNode): FakeNode; disconnect(): void; [k: string]: unknown }

const param = () => ({ value: 0, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} });
function node(kind: string): FakeNode {
    const n: FakeNode = {
        kind, out: [], msgs: [],
        connect(t: FakeNode) { n.out.push(t); return t; },
        disconnect() { n.out = []; },
        gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(),
        attack: param(), release: param(), fftSize: 0, smoothingTimeConstant: 0, type: '',
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
    failing = new Set<string>();
    source?: FakeNode;
    addModule = vi.fn(async (name: string) => {
        if (this.failing.has(name)) throw new Error(`addModule(${name}) blocked`);
        this.registered.add(name);
    });
    audioWorklet = { addModule: this.addModule };
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return (this.source = node('source')); }
    createGain() { return node('gain'); }
    createAnalyser() { return node('analyser'); }
    createBiquadFilter() { return node('eq'); }
    createDynamicsCompressor() { return node('compressor'); }
    createMediaStreamDestination() { return { ...node('destination'), stream: { getAudioTracks: () => [{ id: 'processed' }] } }; }
}

const workletNodes: FakeNode[] = [];
function FakeWorkletNode(this: unknown, ctx: FakeCtx, name: string, options?: Record<string, unknown>) {
    if (!ctx.registered.has(name)) throw new Error(`${name} not registered`);
    const kind = name === 'gate-worklet' ? 'gate' : name === 'agc-worklet' ? 'agc' : name === 'speex-light-worklet' ? 'speex'
        : name === 'cl-audio-worklet' ? 'cl' : 'rnnoise';
    const n = node(kind);
    n.options = options;
    workletNodes.push(n);
    return n;
}
const clNode = () => workletNodes.find(n => n.kind === 'cl');
const emit = (n: FakeNode, data: Msg) => ((n.port as { onmessage: ((e: { data: unknown }) => void) | null }).onmessage as ((e: { data: unknown }) => void))({ data });

const track = (deviceId: string | undefined = 'dev-1') => ({ applyConstraints: async () => {}, getSettings: () => ({ deviceId }) }) as unknown as MediaStreamTrack;
const SETTINGS = {
    noiseSuppression: true, noiseSuppressionMode: 'light' as 'strong' | 'light', volumeNormalization: true, voiceGate: true, voiceGateThreshold: -45,
    pushToTalk: false, pushToTalkKey: null, pushToMuteKey: null, micDeviceId: '', speakerDeviceId: '', cameraDeviceId: '',
    micVolume: 100, speakerVolume: 100, eqEnabled: false, eqBands: [0, 0, 0, 0, 0],
    cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100,
    audioEngine: 'v2' as 'v2' | 'legacy',
};

function path(ctx: FakeCtx): string[] {
    const kinds: string[] = [];
    let n: FakeNode | undefined = ctx.source;
    while (n) { kinds.push(n.kind); n = n.out[0]; }
    return kinds;
}

beforeEach(() => {
    workletNodes.length = 0;
    (secureLocalStore as unknown as { removeItem: (k: string) => void }).removeItem(MIC_DEVICE_GAIN_KEY);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('MediaStream', class { tracks: unknown[]; constructor(t: unknown[]) { this.tracks = t; } });
});

async function build(settings: Partial<typeof SETTINGS> = {}, opts: { failing?: string[]; rate?: number; deviceId?: string; callbacks?: Record<string, unknown> } = {}) {
    const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
    const ctx = new FakeCtx();
    if (opts.rate) ctx.sampleRate = opts.rate;
    (opts.failing ?? []).forEach(f => ctx.failing.add(f));
    const vp = new CipherlineVoiceProcessor({ ...SETTINGS, ...settings } as never, (opts.callbacks ?? {}) as never);
    await vp.init({ track: track(opts.deviceId), audioContext: ctx as unknown as AudioContext });
    return { vp, ctx };
}

describe('v2 graph', () => {
    it('legacy (the default) builds NO engine node', async () => {
        const { vp, ctx } = await build({ audioEngine: 'legacy' });
        expect(clNode()).toBeUndefined();
        expect(path(ctx)).toContain('gate');
        expect(vp.engineBuilt).toBe('legacy');
        await vp.destroy();
    });

    it('a settings object with no audioEngine at all (a saved blob from before) is legacy', async () => {
        const { audioEngine: _drop, ...noEngine } = SETTINGS; void _drop;
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const ctx = new FakeCtx();
        const vp = new CipherlineVoiceProcessor(noEngine as never);
        await vp.init({ track: track(), audioContext: ctx as unknown as AudioContext });
        expect(vp.engineBuilt).toBe('legacy');
        expect(clNode()).toBeUndefined();
        await vp.destroy();
    });

    it('v2: source -> clAudio -> EQ x5 -> analyser -> destination; none of the legacy stages exist', async () => {
        const { vp, ctx } = await build();
        expect(path(ctx)).toEqual(['source', 'cl', 'eq', 'eq', 'eq', 'eq', 'eq', 'analyser', 'destination']);
        expect(workletNodes.map(n => n.kind)).toEqual(['cl']); // no gate / agc / rnnoise / speex worklet was even created
        expect(vp.engineBuilt).toBe('v2');
        expect(vp.processedTrack).toBeDefined();
        expect((vp.outputNode as unknown as FakeNode | undefined)?.kind).toBe('analyser');
        await vp.destroy();
    });

    it('hands the worklet the wasm bytes, the mapped settings and (when known) the remembered gain in processorOptions', async () => {
        saveMicDeviceGain('dev-1', 14.5);
        const { vp } = await build({ noiseSuppression: true, volumeNormalization: false, micVolume: 200 });
        const o = clNode()!.options!.processorOptions as Record<string, unknown>;
        expect(o.wasmBytes).toBeInstanceOf(ArrayBuffer);
        expect(o.settings).toMatchObject({ noise: 1, autoGain: false, originalSound: false });
        expect((o.settings as { manualGainDb: number }).manualGainDb).toBeCloseTo(7.5, 1);
        expect(o.initialDeviceGainDb).toBe(14.5);
        await vp.destroy();
        const { vp: vp2 } = await build({}, { deviceId: 'other-mic' });
        expect('initialDeviceGainDb' in (workletNodes.filter(n => n.kind === 'cl').at(-1)!.options!.processorOptions as object)).toBe(false);
        await vp2.destroy();
    });

    it('EQ bands still carry the user gains', async () => {
        const { vp, ctx } = await build({ eqEnabled: true, eqBands: [1, 2, 3, 4, 5] });
        const eqs: FakeNode[] = []; for (let n = ctx.source; n; n = n.out[0]) if (n.kind === 'eq') eqs.push(n);
        expect(eqs.map(e => (e.gain as { value: number }).value)).toEqual([1, 2, 3, 4, 5]);
        await vp.destroy();
    });

    it('the worklet cannot be registered: the legacy chain is built instead (a call is never left without a mic)', async () => {
        const { vp, ctx } = await build({}, { failing: ['cl-audio-worklet'] });
        expect(vp.engineBuilt).toBe('legacy');
        expect(path(ctx)).toContain('gate');
        expect(path(ctx)).not.toContain('cl');
        expect(vp.processedTrack).toBeDefined();
        expect(vp.needsEngineRebuild()).toBe(false); // settled on legacy: the manager must not keep rebuilding it
        await vp.destroy();
    });

    it('a context the browser locked at another rate: legacy (the engine answers at 48 kHz, a mismatch would play at the wrong speed)', async () => {
        vi.stubGlobal('AudioContext', class extends FakeCtx { sampleRate = 44100; });
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const vp = new CipherlineVoiceProcessor({ ...SETTINGS } as never);
        await vp.init({ track: track() }); // no host context: the processor builds its own, and gets 44.1 kHz
        expect(vp.engineBuilt).toBe('legacy');
        expect(clNode()).toBeUndefined();
        await vp.destroy();
    });
});

describe('v2 settings', () => {
    it('updateSettings posts the mapped settings to the engine and nothing to legacy stages (there are none)', async () => {
        const { vp } = await build();
        const cl = clNode()!;
        cl.msgs.length = 0;
        vp.updateSettings({ ...SETTINGS, noiseSuppression: false, volumeNormalization: false, micVolume: 100 } as never);
        expect(cl.msgs).toContainEqual({ type: 'setSettings', noise: 0, autoGain: false, manualGainDb: 0, originalSound: true, gate: { enabled: false, thresholdDb: -55 } });
        // a manual gate that is ON: posted, and it takes the engine out of the true bypass
        cl.msgs.length = 0;
        vp.updateSettings({ ...SETTINGS, noiseSuppression: false, volumeNormalization: false, micVolume: 100, voiceGateManual: true, voiceGateManualDb: -48 } as never);
        expect(cl.msgs.at(-1)).toMatchObject({ type: 'setSettings', originalSound: false, gate: { enabled: true, thresholdDb: -48 } });
        vp.updateSettings({ ...SETTINGS, voiceGate: false, voiceGateThreshold: -30 } as never);
        expect(cl.msgs.at(-1)).toMatchObject({ type: 'setSettings', noise: 1, autoGain: true });
        await vp.destroy();
    });

    it('the Settings meter: asks the engine for level reports and turns them into onGateLevel; a call (no meter) asks for none', async () => {
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const seen: Array<[number, boolean]> = [];
        const vp = new CipherlineVoiceProcessor({ ...SETTINGS } as never, { onGateLevel: (db: number, open: boolean) => seen.push([db, open]) } as never, { gateMeterMs: 50 });
        await vp.init({ track: track(), audioContext: new FakeCtx() as unknown as AudioContext });
        const cl = clNode()!;
        expect((cl as unknown as { msgs: unknown[] }).msgs).toContainEqual({ type: 'reportLevel', ms: 50 });
        emit(cl, { type: 'level', dbfs: -52.5, open: false });
        emit(cl, { type: 'level', dbfs: NaN, open: true }); // junk is ignored
        expect(seen).toEqual([[-52.5, false]]);
        await vp.destroy();
        workletNodes.length = 0;
        const { vp: call } = await build();
        expect((clNode() as unknown as { msgs: Array<{ type: string }> }).msgs.some(m => m.type === 'reportLevel')).toBe(false);
        await call.destroy();
    });

    it('switching the engine is a rebuild (needsEngineRebuild), not an in-place change', async () => {
        const { vp } = await build();
        expect(vp.needsEngineRebuild(SETTINGS as never)).toBe(false);
        expect(vp.needsEngineRebuild({ ...SETTINGS, audioEngine: 'legacy' } as never)).toBe(true);
        await vp.destroy();
        const { vp: leg } = await build({ audioEngine: 'legacy' });
        expect(leg.needsEngineRebuild({ ...SETTINGS, audioEngine: 'legacy' } as never)).toBe(false);
        expect(leg.needsEngineRebuild({ ...SETTINGS, audioEngine: 'v2' } as never)).toBe(true);
        await leg.destroy();
    });
});

describe('v2 failure', () => {
    it("a 'failed' message from the worklet: fallback callback once, the processor now wants the legacy chain, and a rebuild gives it", async () => {
        const onEngineFallback = vi.fn();
        const { vp, ctx } = await build({}, { callbacks: { onEngineFallback } });
        const cl = clNode()!;
        emit(cl, { type: 'failed', error: 'unreachable' });
        emit(cl, { type: 'failed', error: 'unreachable' });
        expect(onEngineFallback).toHaveBeenCalledTimes(1);
        expect(onEngineFallback).toHaveBeenCalledWith({ error: 'unreachable' });
        expect(vp.needsEngineRebuild()).toBe(true);
        // what voiceProcessorManager does next: stopProcessor (destroy) + setProcessor (init)
        await vp.destroy();
        await vp.init({ track: track(), audioContext: new FakeCtx() as unknown as AudioContext });
        expect(vp.engineBuilt).toBe('legacy');
        expect(vp.needsEngineRebuild()).toBe(false);
        void ctx;
        await vp.destroy();
    });

    it('choosing the engine again clears the failure', async () => {
        const { vp } = await build({}, {});
        emit(clNode()!, { type: 'failed', error: 'x' });
        expect(vp.needsEngineRebuild()).toBe(true);
        vp.updateSettings({ ...SETTINGS, audioEngine: 'legacy' } as never);
        vp.updateSettings({ ...SETTINGS, audioEngine: 'v2' } as never);
        await vp.destroy();
        await vp.init({ track: track(), audioContext: new FakeCtx() as unknown as AudioContext });
        expect(vp.engineBuilt).toBe('v2');
        await vp.destroy();
    });
});

describe('v2 diagnostics and the remembered gain', () => {
    const stats = (over: Msg = {}): Msg => ({
        type: 'stats', engine: 'v2', frames: 100, badSamples: 2, clamped: 1, resets: 0, idleFrames: 5, inputClipCount: 0, mutedAtDevice: false, effectiveNoise: 1,
        inputLevelDbfs: -42, deviceGainDb: 18.2, speechProb: 0.9, delaySamples: 480,
        blocks: 375, voiced: 200, inMs: 0.0004, outMs: 0.01, peak: 0.4, clip: 3, underrun: 0, overflow: 0, ...over,
    });

    it('maps the engine stats into the existing fields (gain, speech level, clip) and its own counters', async () => {
        const onMicLevelStats = vi.fn(); const onAgcStats = vi.fn();
        const { vp } = await build({ volumeNormalization: false, micVolume: 150 }, { callbacks: { onMicLevelStats, onAgcStats } });
        emit(clNode()!, stats());
        expect(onAgcStats).toHaveBeenCalledWith({ gainDb: 18.2, voiceActive: true, speechDb: -42 });
        const s = onMicLevelStats.mock.calls[0][0];
        expect(s).toMatchObject({
            engine: 'v2', gainDb: 18.2, voiceActive: true, speechDb: -42, blocks: 375, voiced: 200, peak: 0.4, clip: 3, held: 0,
            gateOpenFrac: null, rawMs: null, nsMs: null, engineFrames: 100, engineBad: 3, engineResets: 0, engineIdle: 5, engineUnder: 0, mutedAtDevice: false,
        });
        expect(s.micGainDb).toBeCloseTo(20 * Math.log10(Math.pow(1.5, 1.25)), 1);
        await vp.destroy();
    });

    it('no speech heard yet: speechDb is null and nothing is persisted', async () => {
        const onMicLevelStats = vi.fn();
        const { vp } = await build({}, { callbacks: { onMicLevelStats } });
        emit(clNode()!, stats({ inputLevelDbfs: -120, deviceGainDb: 0, speechProb: 0.01 }));
        expect(onMicLevelStats.mock.calls[0][0]).toMatchObject({ speechDb: null, voiceActive: false });
        await vp.destroy();
        expect(loadMicDeviceGain('dev-1')).toBeNull();
    });

    it('persists the learned gain per capture deviceId on destroy and every ~10 s', async () => {
        vi.useFakeTimers();
        try {
            const { vp } = await build();
            emit(clNode()!, stats({ deviceGainDb: 11.1 }));
            expect(loadMicDeviceGain('dev-1')).toBeNull(); // not yet
            vi.advanceTimersByTime(10_001);
            expect(loadMicDeviceGain('dev-1')).toBe(11.1);
            emit(clNode()!, stats({ deviceGainDb: 12.3 }));
            await vp.destroy();
            expect(loadMicDeviceGain('dev-1')).toBe(12.3);
            expect(loadMicDeviceGain('dev-2')).toBeNull();
        } finally { vi.useRealTimers(); }
    });

    it('a track with no deviceId persists nothing', async () => {
        const { vp } = await build({}, { deviceId: '' });
        emit(clNode()!, stats());
        await vp.destroy();
        expect((secureLocalStore as unknown as { getItem: (k: string) => string | null }).getItem(MIC_DEVICE_GAIN_KEY)).toBeNull();
    });
});
