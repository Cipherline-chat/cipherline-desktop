import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The voice gate is a stage of its own (owner bug: "the noise gate doesn't work
 * when noise suppression is turned off").
 *
 *  1. The gate worklet itself, run as plain JS: closes on sub-threshold input
 *     and passes speech — whatever precedes it — and reports its own detector
 *     level for the Settings meter.
 *  2. The graph the processor builds: the gate is wired in and enabled with NS
 *     off, toggles live, and survives RNNoise failing to load (NEGATIVE
 *     CONTROL: the old init built the gate in the same try as RNNoise and only
 *     connected it when the RNNoise node existed).
 */

// The real module is ~4.8 MB of vendored WASM glue; a stub keeps this fast.
vi.mock('./rnnoiseInWorkletSource', () => ({ RNNOISE_INLINE_WORKLET_SOURCE: 'registerProcessor("rnnoise-inline-worklet", class {})' }));
vi.mock('./speexLightWorkletSource', () => ({ SPEEX_LIGHT_WORKLET_SOURCE: 'registerProcessor("speex-light-worklet", class {})' }));
// Module "URLs" are the processor names, so the fake context knows what it is registering.
vi.mock('./workletModuleUrl', () => ({ workletModuleUrl: (name: string) => name, forgetWorkletModuleUrl: () => {} }));

// ── 1. The gate worklet, as DSP ─────────────────────────────────────────────

interface GateInstance {
    port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: ReturnType<typeof vi.fn> };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

async function loadGate(): Promise<{ gate: GateInstance; send: (data: unknown) => void }> {
    const { GATE_WORKLET_SOURCE } = await import('./voiceProcessor');
    let Cls: (new () => GateInstance) | null = null;
    class AudioWorkletProcessor {
        port = { onmessage: null as GateInstance['port']['onmessage'], postMessage: vi.fn() };
    }
    const registerProcessor = (_name: string, c: new () => GateInstance) => { Cls = c; };
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', GATE_WORKLET_SOURCE)(
        AudioWorkletProcessor, registerProcessor, 48000,
    );
    const gate = new Cls!();
    return { gate, send: (data) => gate.port.onmessage?.({ data }) };
}

const lin = (db: number) => Math.pow(10, db / 20);
/** A 128-sample block whose RMS is exactly `db` dBFS (a ±a square wave). */
const block = (db: number) => Float32Array.from({ length: 128 }, (_, i) => (i % 2 ? 1 : -1) * lin(db));
const rmsDb = (b: Float32Array) => {
    let s = 0; for (const x of b) s += x * x;
    const r = Math.sqrt(s / b.length);
    return r > 0 ? 20 * Math.log10(r) : -Infinity;
};
/** Run `n` blocks at `db` through the gate; returns the last output block. */
function run(gate: GateInstance, db: number, n: number): Float32Array {
    const out = new Float32Array(128);
    for (let i = 0; i < n; i++) gate.process([[block(db)]], [[out]]);
    return out;
}
const BLOCKS_PER_SECOND = 48000 / 128;

describe('gate worklet — the DSP', () => {
    it('room noise below the threshold is gated to silence (after hold + release)', async () => {
        const { gate, send } = await loadGate();
        send({ type: 'gate', enabled: true });
        send({ type: 'threshold', value: -45 });
        send({ type: 'hold', ms: 150 });
        run(gate, -20, 20);                                   // speech first, gate open
        const out = run(gate, -52, BLOCKS_PER_SECOND);         // then 1 s of noise at -52 dBFS
        expect(rmsDb(out)).toBe(-Infinity);
    });

    it('speech above the threshold passes untouched', async () => {
        const { gate, send } = await loadGate();
        send({ type: 'gate', enabled: true });
        send({ type: 'threshold', value: -45 });
        const out = run(gate, -30, 20);
        expect(rmsDb(out)).toBeCloseTo(-30, 1);
    });

    it('disabled = pass-through, even for sub-threshold noise', async () => {
        const { gate, send } = await loadGate();
        send({ type: 'gate', enabled: false });
        const out = run(gate, -52, BLOCKS_PER_SECOND);
        expect(rmsDb(out)).toBeCloseTo(-52, 1);
    });

    it('reports its OWN detector for the meter: the loudest block of each interval, and whether it is open', async () => {
        const { gate, send } = await loadGate();
        send({ type: 'gate', enabled: true });
        send({ type: 'threshold', value: -45 });
        send({ type: 'report', ms: 50 });                     // ≈ 19 blocks at 48 kHz
        run(gate, -52, 10);
        run(gate, -40, 1);                                    // one loud block inside the interval
        run(gate, -52, 10);
        const levels = gate.port.postMessage.mock.calls.map(c => c[0]).filter((m: { type: string }) => m.type === 'level');
        expect(levels.length).toBeGreaterThanOrEqual(1);
        expect(20 * Math.log10(levels[0].rms)).toBeCloseTo(-40, 1);
        expect(levels[0].open).toBe(true);                    // that block opened it
        // Noise only, past hold + release: reported below threshold AND closed.
        gate.port.postMessage.mockClear();
        run(gate, -52, BLOCKS_PER_SECOND);
        const last = gate.port.postMessage.mock.calls.map(c => c[0]).filter((m: { type: string }) => m.type === 'level').at(-1);
        expect(20 * Math.log10(last.rms)).toBeCloseTo(-52, 1);
        expect(last.open).toBe(false);
    });

    it('reports nothing unless a meter asked (a call pays no extra audio-thread messages)', async () => {
        const { gate, send } = await loadGate();
        send({ type: 'gate', enabled: true });
        run(gate, -30, BLOCKS_PER_SECOND);
        expect(gate.port.postMessage).not.toHaveBeenCalled();
    });
});

// ── 2. The graph the processor builds ──────────────────────────────────────

type Msg = Record<string, unknown>;
interface FakeNode { kind: string; out: FakeNode[]; msgs: Msg[]; connect(n: FakeNode): FakeNode; disconnect(): void; [k: string]: unknown }

const param = () => ({ value: 0, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} });
function node(kind: string): FakeNode {
    const n: FakeNode = {
        kind, out: [], msgs: [],
        connect(t: FakeNode) { n.out.push(t); return t; },
        disconnect() { n.out = []; },
        gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(),
        attack: param(), release: param(), fftSize: 0, smoothingTimeConstant: 0, type: '',
        // The level poll (20 ms) fires while a test awaits; give the analyser fake its reader.
        getFloatTimeDomainData() {},
        port: { postMessage: (m: Msg) => n.msgs.push(m), onmessage: null },
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
function FakeWorkletNode(this: unknown, ctx: FakeCtx, name: string) {
    if (!ctx.registered.has(name)) throw new Error(`${name} not registered`);
    const kind = name === 'gate-worklet' ? 'gate' : name === 'agc-worklet' ? 'agc' : name === 'speex-light-worklet' ? 'speex' : 'rnnoise';
    const n = node(kind);
    workletNodes.push(n);
    return n;
}

const track = () => ({ applyConstraints: async () => {} }) as unknown as MediaStreamTrack;
const SETTINGS = {
    noiseSuppression: false, noiseSuppressionMode: 'strong' as 'strong' | 'light', volumeNormalization: true, voiceGate: true, voiceGateThreshold: -45,
    pushToTalk: false, pushToTalkKey: null, micDeviceId: '', speakerDeviceId: '', cameraDeviceId: '',
    micVolume: 100, speakerVolume: 100, eqEnabled: false, eqBands: [0, 0, 0, 0, 0],
    cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100,
};

/** The chain as wired: kinds from the source to the destination. */
function path(ctx: FakeCtx): string[] {
    const kinds: string[] = [];
    let n: FakeNode | undefined = ctx.source;
    while (n) { kinds.push(n.kind); n = n.out[0]; }
    return kinds;
}
const gateNode = () => workletNodes.find(n => n.kind === 'gate');

beforeEach(() => {
    workletNodes.length = 0;
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('MediaStream', class { tracks: unknown[]; constructor(t: unknown[]) { this.tracks = t; } });
});

async function build(settings: Partial<typeof SETTINGS>, failing: string[] = []) {
    const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
    const ctx = new FakeCtx();
    failing.forEach(f => ctx.failing.add(f));
    const vp = new CipherlineVoiceProcessor({ ...SETTINGS, ...settings } as never);
    await vp.init({ track: track(), audioContext: ctx as unknown as AudioContext });
    return { vp, ctx };
}

describe('voice chain — the gate with noise suppression OFF', () => {
    it('NS off, gate on: the gate is in the chain, enabled, right after the (bypassed) NS stages', async () => {
        const { vp, ctx } = await build({ noiseSuppression: false, voiceGate: true });
        expect(path(ctx)).toEqual([
            'source', 'rnnoise', 'speex', 'gate', 'eq', 'eq', 'eq', 'eq', 'eq', 'agc',
            'compressor', 'gain', 'gain', 'analyser', 'destination',
        ]);
        expect(gateNode()!.msgs).toContainEqual({ type: 'gate', enabled: true });
        expect(gateNode()!.msgs).toContainEqual({ type: 'threshold', value: -45 });
        const rnnoise = workletNodes.find(n => n.kind === 'rnnoise')!;
        expect(rnnoise.msgs).toContainEqual({ type: 'toggle', enabled: false });
        expect(vp.chainPlan).toMatchObject({ ns: false, gate: true });
        await vp.destroy();
    });

    it('NEGATIVE CONTROL: RNNoise cannot load at all → the gate (and AGC) still run', async () => {
        const nsUnavailable = vi.fn();
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const ctx = new FakeCtx();
        ctx.failing.add('rnnoise-inline-worklet');
        ctx.failing.add('rnnoise-worklet');
        const vp = new CipherlineVoiceProcessor({ ...SETTINGS, noiseSuppression: true } as never, { onNsUnavailable: nsUnavailable });
        await vp.init({ track: track(), audioContext: ctx as unknown as AudioContext });
        expect(nsUnavailable).toHaveBeenCalled();
        expect(path(ctx)).toEqual([
            'source', 'speex', 'gate', 'eq', 'eq', 'eq', 'eq', 'eq', 'agc',
            'compressor', 'gain', 'gain', 'analyser', 'destination',
        ]);
        expect(gateNode()!.msgs).toContainEqual({ type: 'gate', enabled: true });
        expect(vp.chainPlan).toMatchObject({ ns: false, gate: true, agc: true });
        await vp.destroy();
    });

    it('a gate that cannot load drops only itself — NS and AGC still run', async () => {
        const { vp, ctx } = await build({ noiseSuppression: true }, ['gate-worklet']);
        expect(path(ctx)).toEqual([
            'source', 'rnnoise', 'speex', 'eq', 'eq', 'eq', 'eq', 'eq', 'agc',
            'compressor', 'gain', 'gain', 'analyser', 'destination',
        ]);
        expect(vp.chainPlan).toMatchObject({ ns: true, gate: false });
        await vp.destroy();
    });

    it('toggling NS and the gate mid-call is a message to the live nodes — the graph is not rebuilt', async () => {
        const { vp, ctx } = await build({ noiseSuppression: false, voiceGate: false });
        const before = path(ctx);
        const gate = gateNode()!;
        const rnnoise = workletNodes.find(n => n.kind === 'rnnoise')!;

        vp.updateSettings({ ...SETTINGS, noiseSuppression: false, voiceGate: true } as never);
        expect(gate.msgs.at(-1)).toEqual({ type: 'gate', enabled: true });
        vp.updateSettings({ ...SETTINGS, noiseSuppression: true, voiceGate: true } as never);
        expect(rnnoise.msgs.at(-1)).toEqual({ type: 'toggle', enabled: true });
        vp.updateSettings({ ...SETTINGS, noiseSuppression: false, voiceGate: true } as never);
        expect(rnnoise.msgs.at(-1)).toEqual({ type: 'toggle', enabled: false });
        // The gate was not touched by the NS toggles.
        expect(gate.msgs.at(-1)).toEqual({ type: 'gate', enabled: true });
        vp.updateSettings({ ...SETTINGS, voiceGate: true, voiceGateThreshold: -38 } as never);
        expect(gate.msgs.at(-1)).toEqual({ type: 'threshold', value: -38 });
        expect(path(ctx)).toEqual(before);
        await vp.destroy();
    });

    it('the Settings meter gets the gate detector only when it asks (gateMeterMs)', async () => {
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const onGateLevel = vi.fn();
        const ctx = new FakeCtx();
        const vp = new CipherlineVoiceProcessor(SETTINGS as never, { onGateLevel }, { gateMeterMs: 50 });
        await vp.init({ track: track(), audioContext: ctx as unknown as AudioContext });
        const gate = gateNode()!;
        expect(gate.msgs).toContainEqual({ type: 'report', ms: 50 });
        (gate.port as { onmessage: (e: { data: unknown }) => void }).onmessage({ data: { type: 'level', rms: lin(-41), open: true } });
        expect(onGateLevel).toHaveBeenCalledWith(expect.closeTo(-41, 3), true);
        await vp.destroy();

        workletNodes.length = 0;
        const call = new CipherlineVoiceProcessor(SETTINGS as never);
        await call.init({ track: track(), audioContext: new FakeCtx() as unknown as AudioContext });
        expect(gateNode()!.msgs.some(m => m.type === 'report')).toBe(false);
        await call.destroy();
    });
});



describe('voice chain — Light (Speex) noise suppression', () => {
    const speexNode = () => workletNodes.find(n => n.kind === 'speex')!;
    const rnnoiseNode = () => workletNodes.find(n => n.kind === 'rnnoise')!;

    it('Strong (default): RNNoise processes, the Light node stays a passthrough and never asks for its WASM', async () => {
        const { vp } = await build({ noiseSuppression: true, noiseSuppressionMode: 'strong' });
        expect(rnnoiseNode().msgs).toContainEqual({ type: 'toggle', enabled: true });
        expect(speexNode().msgs).toContainEqual({ type: 'toggle', enabled: false });
        expect(speexNode().msgs.some(m => m.type === 'init')).toBe(false);
        expect(vp.chainPlan).toMatchObject({ ns: true });
        await vp.destroy();
    });

    it('Light: Speex processes, RNNoise is switched off, and the WASM is sent once', async () => {
        const { vp, ctx } = await build({ noiseSuppression: true, noiseSuppressionMode: 'light' });
        expect(rnnoiseNode().msgs.at(-1)).toEqual({ type: 'toggle', enabled: false });
        expect(speexNode().msgs).toContainEqual({ type: 'toggle', enabled: true });
        await vi.waitFor(() => expect(speexNode().msgs.some(m => m.type === 'init')).toBe(true));
        const init = speexNode().msgs.find(m => m.type === 'init') as unknown as { wasm: ArrayBuffer };
        expect(init.wasm.byteLength).toBeGreaterThan(40000);
        expect(vp.chainPlan).toMatchObject({ ns: true });
        expect(path(ctx)).toContain('speex');
        await vp.destroy();
    });

    it('switching engines mid-call is a message to the live nodes — the graph is not rebuilt, and WASM is requested once', async () => {
        const { vp, ctx } = await build({ noiseSuppression: true, noiseSuppressionMode: 'strong' });
        const before = path(ctx);
        vp.updateSettings({ ...SETTINGS, noiseSuppression: true, noiseSuppressionMode: 'light' } as never);
        expect(rnnoiseNode().msgs.at(-1)).toEqual({ type: 'toggle', enabled: false });
        expect(speexNode().msgs.at(-1)).toEqual({ type: 'toggle', enabled: true });
        vp.updateSettings({ ...SETTINGS, noiseSuppression: true, noiseSuppressionMode: 'strong' } as never);
        expect(rnnoiseNode().msgs.at(-1)).toEqual({ type: 'toggle', enabled: true });
        expect(speexNode().msgs.at(-1)).toEqual({ type: 'toggle', enabled: false });
        vp.updateSettings({ ...SETTINGS, noiseSuppression: true, noiseSuppressionMode: 'light' } as never);
        await vi.waitFor(() => expect(speexNode().msgs.some(m => m.type === 'init')).toBe(true));
        expect(speexNode().msgs.filter(m => m.type === 'init')).toHaveLength(1);
        expect(path(ctx)).toEqual(before);
        await vp.destroy();
    });

    it('turning NS off silences both engines', async () => {
        const { vp } = await build({ noiseSuppression: true, noiseSuppressionMode: 'light' });
        vp.updateSettings({ ...SETTINGS, noiseSuppression: false, noiseSuppressionMode: 'light' } as never);
        expect(rnnoiseNode().msgs.at(-1)).toEqual({ type: 'toggle', enabled: false });
        expect(speexNode().msgs.at(-1)).toEqual({ type: 'toggle', enabled: false });
        await vp.destroy();
    });

    it('NO silent fallback: Light selected but its worklet cannot load -> NS is unavailable (and RNNoise does not quietly take over)', async () => {
        const { vp } = await build({ noiseSuppression: true, noiseSuppressionMode: 'light' }, ['speex-light-worklet']);
        expect(vp.chainPlan).toMatchObject({ ns: false, gate: true });
        expect(rnnoiseNode().msgs.at(-1)).toEqual({ type: 'toggle', enabled: false });
        await vp.destroy();
    });
});

// ── 3. Strong → Light when the render thread falls behind (nsLoadGuard.ts) ──

describe('voice chain — render-thread overload swaps Strong for Light', () => {
    async function buildWithStats(onNsLoadFallback = vi.fn(), onAudioRender = vi.fn()) {
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const ctx = new FakeCtx() as FakeCtx & { playbackStats: { underrunDuration: number; underrunEvents: number; totalDuration: number } };
        ctx.playbackStats = { underrunDuration: 0, underrunEvents: 0, totalDuration: 0 };
        const vp = new CipherlineVoiceProcessor({ ...SETTINGS, noiseSuppression: true, noiseSuppressionMode: 'strong' } as never, { onNsLoadFallback, onAudioRender });
        await vp.init({ track: track(), audioContext: ctx as unknown as AudioContext });
        const second = async (underrunMs: number) => {
            ctx.playbackStats = {
                underrunDuration: ctx.playbackStats.underrunDuration + underrunMs / 1000,
                underrunEvents: ctx.playbackStats.underrunEvents + (underrunMs > 0 ? 5 : 0),
                totalDuration: ctx.playbackStats.totalDuration + 1,
            };
            await vi.advanceTimersByTimeAsync(1000);
        };
        return { vp, second, onNsLoadFallback, onAudioRender };
    }
    const rn = () => workletNodes.find(n => n.kind === 'rnnoise')!;
    const sx = () => workletNodes.find(n => n.kind === 'speex')!;

    it('three bad seconds: RNNoise off, Speex on, callback once; a new mode choice puts Strong back', async () => {
        vi.useFakeTimers();
        try {
            const { vp, second, onNsLoadFallback } = await buildWithStats();
            expect(rn().msgs.at(-1)).toEqual({ type: 'toggle', enabled: true });
            await second(0);              // baseline
            await second(50); await second(0); await second(60);
            expect(onNsLoadFallback).not.toHaveBeenCalled();
            await second(80);
            expect(onNsLoadFallback).toHaveBeenCalledTimes(1);
            expect(onNsLoadFallback).toHaveBeenCalledWith({ underrunMs: 80, underrunEvents: 5 });
            expect(vp.nsLoadFallbackActive).toBe(true);
            expect(rn().msgs.at(-1)).toEqual({ type: 'toggle', enabled: false });
            expect(sx().msgs.filter(m => m.type === 'toggle').at(-1)).toEqual({ type: 'toggle', enabled: true }); // (its WASM 'init' may follow)
            for (let i = 0; i < 5; i++) await second(200);
            expect(onNsLoadFallback).toHaveBeenCalledTimes(1);   // latched: once per call
            vp.updateSettings({ ...SETTINGS, noiseSuppression: true, noiseSuppressionMode: 'strong' } as never); // no change → still Light
            expect(vp.nsLoadFallbackActive).toBe(true);
            vp.updateSettings({ ...SETTINGS, noiseSuppression: true, noiseSuppressionMode: 'light' } as never);
            vp.updateSettings({ ...SETTINGS, noiseSuppression: true, noiseSuppressionMode: 'strong' } as never);
            expect(vp.nsLoadFallbackActive).toBe(false);
            expect(rn().msgs.at(-1)).toEqual({ type: 'toggle', enabled: true });
            await vp.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a healthy render thread changes nothing and reports nothing; underrun windows are reported', async () => {
        vi.useFakeTimers();
        try {
            const { vp, second, onNsLoadFallback, onAudioRender } = await buildWithStats();
            for (let i = 0; i < 25; i++) await second(0);
            expect(onNsLoadFallback).not.toHaveBeenCalled();
            expect(onAudioRender).not.toHaveBeenCalled();
            for (let i = 0; i < 10; i++) await second(i === 4 ? 12 : 0);   // one small hiccup
            expect(onAudioRender).toHaveBeenCalledWith({ underrunMs: 12, underrunEvents: 5, windowS: 10, ns: 'strong' });
            expect(vp.nsLoadFallbackActive).toBe(false);
            await vp.destroy();
        } finally {
            vi.useRealTimers();
        }
    });
});
