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
    const kind = name === 'gate-worklet' ? 'gate' : name === 'agc-worklet' ? 'agc' : 'rnnoise';
    const n = node(kind);
    workletNodes.push(n);
    return n;
}

const track = () => ({ applyConstraints: async () => {} }) as unknown as MediaStreamTrack;
const SETTINGS = {
    noiseSuppression: false, volumeNormalization: true, voiceGate: true, voiceGateThreshold: -45,
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
    it('NS off, gate on: the gate is in the chain, enabled, right after the (bypassed) RNNoise stage', async () => {
        const { vp, ctx } = await build({ noiseSuppression: false, voiceGate: true });
        expect(path(ctx)).toEqual([
            'source', 'rnnoise', 'gate', 'eq', 'eq', 'eq', 'eq', 'eq', 'agc',
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
            'source', 'gate', 'eq', 'eq', 'eq', 'eq', 'eq', 'agc',
            'compressor', 'gain', 'gain', 'analyser', 'destination',
        ]);
        expect(gateNode()!.msgs).toContainEqual({ type: 'gate', enabled: true });
        expect(vp.chainPlan).toMatchObject({ ns: false, gate: true, agc: true });
        await vp.destroy();
    });

    it('a gate that cannot load drops only itself — NS and AGC still run', async () => {
        const { vp, ctx } = await build({ noiseSuppression: true }, ['gate-worklet']);
        expect(path(ctx)).toEqual([
            'source', 'rnnoise', 'eq', 'eq', 'eq', 'eq', 'eq', 'agc',
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

