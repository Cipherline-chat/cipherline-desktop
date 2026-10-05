import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Worklet registration cost on the mic processor:
 *  - a mic device switch (restart() on the SAME retained context) must not
 *    re-register the three processors: re-evaluating the RNNoise module on the
 *    real-time audio thread is an audible hitch on every switch.
 */

// The real module is ~4.8 MB of vendored WASM glue; a stub keeps this fast.
vi.mock('./rnnoiseInWorkletSource', () => ({ RNNOISE_INLINE_WORKLET_SOURCE: 'registerProcessor("rnnoise-inline-worklet", class {})' }));

const param = () => ({ value: 0, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} });
const node = () => ({ connect() {}, disconnect() {}, gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), fftSize: 0, smoothingTimeConstant: 0, type: '' });

class FakeCtx {
    sampleRate = 48000;
    state: AudioContextState = 'running';
    currentTime = 0; baseLatency = 0.01; outputLatency = 0;
    registered = new Set<string>();
    addModule = vi.fn(async () => {
        // Every module registers the processor its test case asks for.
        for (const n of ['gate-worklet', 'rnnoise-inline-worklet', 'agc-worklet']) if (!this.registered.has(n)) { this.registered.add(n); return; }
    });
    audioWorklet = { addModule: this.addModule };
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return node(); }
    createGain() { return node(); }
    createAnalyser() { return node(); }
    createBiquadFilter() { return node(); }
    createDynamicsCompressor() { return node(); }
    createMediaStreamDestination() { return { ...node(), stream: { getAudioTracks: () => [{ id: 'processed' }] } }; }
}

class FakeWorkletNode {
    port = { postMessage() {}, onmessage: null as unknown };
    constructor(ctx: FakeCtx, name: string) { if (!ctx.registered.has(name)) throw new Error(`${name} not registered`); }
    connect() {} disconnect() {}
}

const track = () => ({ applyConstraints: async () => {} }) as unknown as MediaStreamTrack;
const settings = {
    noiseSuppression: true, volumeNormalization: true, voiceGate: false, voiceGateThreshold: -50,
    pushToTalk: false, pushToTalkKey: '', micDeviceId: '', speakerDeviceId: '', cameraDeviceId: '',
    micVolume: 100, speakerVolume: 100, eqEnabled: false, eqBands: [0, 0, 0, 0, 0],
    cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100,
} as never;

beforeEach(() => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('MediaStream', class { tracks: unknown[]; constructor(t: unknown[]) { this.tracks = t; } });
});

describe('CipherlineVoiceProcessor worklet registration', () => {
    it('registers all three processors on first init', async () => {
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const ctx = new FakeCtx();
        const vp = new CipherlineVoiceProcessor(settings);
        await vp.init({ track: track(), audioContext: ctx as unknown as AudioContext });
        expect(ctx.addModule).toHaveBeenCalledTimes(3);
        expect(vp.processedTrack).toBeTruthy();
        await vp.destroy();
    });

    it('a device switch on the retained context re-registers nothing', async () => {
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const ctx = new FakeCtx();
        const vp = new CipherlineVoiceProcessor(settings);
        await vp.init({ track: track(), audioContext: ctx as unknown as AudioContext });
        // livekit-client calls restart() with NO audioContext on switchActiveDevice.
        await vp.restart({ track: track() });
        await vp.restart({ track: track() });
        expect(ctx.addModule).toHaveBeenCalledTimes(3);
        expect(vp.processedTrack).toBeTruthy();
        await vp.destroy();
    });

    it('a different context still gets its own registration', async () => {
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const a = new FakeCtx();
        const b = new FakeCtx();
        const vp = new CipherlineVoiceProcessor(settings);
        await vp.init({ track: track(), audioContext: a as unknown as AudioContext });
        await vp.destroy();
        await vp.init({ track: track(), audioContext: b as unknown as AudioContext });
        expect(a.addModule).toHaveBeenCalledTimes(3);
        expect(b.addModule).toHaveBeenCalledTimes(3);
        await vp.destroy();
    });
});

describe('CipherlineVoiceProcessor level poll cadence', () => {
    const pollPeriods = async (opts?: { levelPollMs?: number }) => {
        const { CipherlineVoiceProcessor } = await import('./voiceProcessor');
        const spy = vi.spyOn(globalThis, 'setInterval');
        const vp = new CipherlineVoiceProcessor(settings, {}, opts);
        await vp.init({ track: track(), audioContext: new FakeCtx() as unknown as AudioContext });
        const periods = spy.mock.calls.map(c => c[1]);
        spy.mockRestore();
        await vp.destroy();
        return periods;
    };

    it('defaults to 20 ms (a visible meter: Settings mic test)', async () => {
        expect(await pollPeriods()).toContain(20);
    });

    it('the call processor polls at 100 ms — its only reader is the 1 Hz silence watchdog', async () => {
        const mgr = await import('./voiceProcessorManager');
        expect(mgr.CALL_LEVEL_POLL_MS).toBe(100);
        const spy = vi.spyOn(globalThis, 'setInterval');
        const vp = mgr.getOrCreate('call-1', settings);
        await vp.init({ track: track(), audioContext: new FakeCtx() as unknown as AudioContext });
        const periods = spy.mock.calls.map(c => c[1]);
        spy.mockRestore();
        await mgr.destroyForCall('call-1');
        expect(periods).toContain(100);
        expect(periods).not.toContain(20);
    });
});
