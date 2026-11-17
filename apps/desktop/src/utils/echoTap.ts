/**
 * The audio-graph half of echo detection: turns "what we are playing" and "what
 * the raw microphone hears" into two 100 Hz LEVEL envelopes for echoDetector.ts.
 *
 *   remote talkers' received tracks --(sum)--> input 0 \
 *                                                        cl-echo-env worklet --> {far, near} RMS per 10 ms
 *   raw microphone track (before our gate / NS / AGC) --> input 1 /
 *
 * Privacy: only loudness numbers leave the worklet (20 hops per message, ~5
 * messages a second); the audio itself is never copied, stored or sent, and the
 * tap's own output is silent and goes nowhere audible (a zero gain into a
 * MediaStream destination nobody reads).
 *
 * Cost: one extra AudioContext with one worklet doing a multiply-add per sample
 * per input (~2 x 48 k per second), and one MediaStreamSource per tapped track.
 * It exists only while echo cancellation is OFF and the call is live.
 *
 * The far signal is tapped from the RECEIVED track, upstream of the playback
 * path (element or Web Audio) and of the user's volume sliders, so the same tap
 * works for every playback path (see useParticipantAudio.getAudibleFarEndTracks).
 */
import { workletModuleUrl, forgetWorkletModuleUrl } from './workletModuleUrl';
import { registerCtxForUnlock } from './audioUnlock';

export const ECHO_WORKLET_NAME = 'cl-echo-env';
/** Hops per message: 20 x 10 ms = 200 ms. */
export const ECHO_BATCH = 20;

/** AudioWorkletGlobalScope source. Kept as a string so it needs no bundler worker support (same as the voice chain's). */
export const ECHO_WORKLET_SOURCE = `
class ClEchoEnv extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hop = Math.max(1, Math.round(sampleRate / 100));
    this.n = 0; this.sf = 0; this.sn = 0; this.k = 0;
    this.bf = new Float32Array(${ECHO_BATCH}); this.bn = new Float32Array(${ECHO_BATCH});
  }
  process(inputs) {
    const f = inputs[0] && inputs[0][0];
    const m = inputs[1] && inputs[1][0];
    const len = (f && f.length) || (m && m.length) || 128;
    for (let i = 0; i < len; i++) {
      const a = f ? f[i] : 0, b = m ? m[i] : 0;
      this.sf += a * a; this.sn += b * b; this.n++;
      if (this.n >= this.hop) {
        this.bf[this.k] = Math.sqrt(this.sf / this.n);
        this.bn[this.k] = Math.sqrt(this.sn / this.n);
        this.k++; this.n = 0; this.sf = 0; this.sn = 0;
        if (this.k === ${ECHO_BATCH}) {
          this.port.postMessage({ far: this.bf, near: this.bn });
          this.bf = new Float32Array(${ECHO_BATCH}); this.bn = new Float32Array(${ECHO_BATCH}); this.k = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${ECHO_WORKLET_NAME}', ClEchoEnv);
`;

export type EchoFramesCallback = (far: Float32Array, near: Float32Array) => void;

export class EchoTap {
    private ctx: AudioContext | null = null;
    private node: AudioWorkletNode | null = null;
    private farBus: GainNode | null = null;
    private nearBus: GainNode | null = null;
    private farSources = new Map<MediaStreamTrack, MediaStreamAudioSourceNode>();
    private nearSource: { track: MediaStreamTrack; node: MediaStreamAudioSourceNode } | null = null;
    private starting: Promise<boolean> | null = null;
    private disposed = false;

    private readonly onFrames: EchoFramesCallback;

    constructor(onFrames: EchoFramesCallback) { this.onFrames = onFrames; }

    /** Build the graph. Resolves false when Web Audio / worklets are unavailable: the caller just never detects. */
    start(): Promise<boolean> {
        if (this.starting) return this.starting;
        this.starting = (async () => {
            try {
                const Ctx = window.AudioContext;
                if (!Ctx || this.disposed) return false;
                const ctx = new Ctx({ latencyHint: 'playback' });
                this.ctx = ctx;
                const url = workletModuleUrl(ECHO_WORKLET_NAME, ECHO_WORKLET_SOURCE);
                await ctx.audioWorklet.addModule(url).catch((err) => { forgetWorkletModuleUrl(ECHO_WORKLET_NAME); throw err; });
                if (this.disposed) { void ctx.close().catch(() => {}); return false; }
                const node = new AudioWorkletNode(ctx, ECHO_WORKLET_NAME, {
                    numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1],
                    channelCount: 1, channelCountMode: 'explicit',
                });
                node.port.onmessage = (e: MessageEvent<{ far: Float32Array; near: Float32Array }>) => {
                    if (e.data?.far && e.data?.near) this.onFrames(e.data.far, e.data.near);
                };
                const farBus = ctx.createGain();
                const nearBus = ctx.createGain();
                farBus.connect(node, 0, 0);
                nearBus.connect(node, 0, 1);
                // The worklet only runs while something pulls on it: a silent sink that goes nowhere audible.
                const sink = ctx.createGain();
                sink.gain.value = 0;
                const dest = ctx.createMediaStreamDestination();
                node.connect(sink);
                sink.connect(dest);
                this.node = node; this.farBus = farBus; this.nearBus = nearBus;
                if (ctx.state === 'suspended') {
                    void ctx.resume().catch(() => {});
                    registerCtxForUnlock(ctx);
                }
                return true;
            } catch {
                return false;
            }
        })();
        return this.starting;
    }

    /** Make the far-end tap hear exactly these tracks. */
    setFarTracks(tracks: readonly MediaStreamTrack[]): void {
        const ctx = this.ctx, bus = this.farBus;
        if (!ctx || !bus) return;
        const want = new Set(tracks);
        for (const [t, src] of this.farSources) {
            if (!want.has(t)) { try { src.disconnect(); } catch { /* already gone */ } this.farSources.delete(t); }
        }
        for (const t of want) {
            if (this.farSources.has(t) || t.readyState !== 'live') continue;
            try {
                const src = ctx.createMediaStreamSource(new MediaStream([t]));
                src.connect(bus);
                this.farSources.set(t, src);
            } catch { /* a track that cannot be tapped is simply not part of the far end */ }
        }
    }

    /** Point the near-end tap at the raw microphone track (null = none). */
    setNearTrack(track: MediaStreamTrack | null): void {
        const ctx = this.ctx, bus = this.nearBus;
        if (!ctx || !bus) return;
        if (this.nearSource && this.nearSource.track === track) return;
        if (this.nearSource) { try { this.nearSource.node.disconnect(); } catch { /* already gone */ } this.nearSource = null; }
        if (!track || track.readyState !== 'live') return;
        try {
            const node = ctx.createMediaStreamSource(new MediaStream([track]));
            node.connect(bus);
            this.nearSource = { track, node };
        } catch { /* ignore: the detector then sees a silent near end and never fires */ }
    }

    dispose(): void {
        this.disposed = true;
        for (const src of this.farSources.values()) { try { src.disconnect(); } catch { /* */ } }
        this.farSources.clear();
        if (this.nearSource) { try { this.nearSource.node.disconnect(); } catch { /* */ } this.nearSource = null; }
        if (this.node) { this.node.port.onmessage = null; try { this.node.disconnect(); } catch { /* */ } }
        const ctx = this.ctx;
        this.ctx = null; this.node = null; this.farBus = null; this.nearBus = null;
        if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    }
}
