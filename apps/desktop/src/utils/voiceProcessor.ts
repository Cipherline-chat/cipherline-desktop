/**
 * Cipherline Voice Processor — LiveKit TrackProcessor implementation.
 *
 * Audio chain (always connected, never torn down after init):
 *   Raw mic track (48 kHz via getUserMedia sampleRate constraint)
 *     → RNNoiseWorkletNode (AudioWorklet ring buffer; RNNoise WASM runs
 *         SYNCHRONOUSLY inside this worklet's own process() call, on the
 *         real-time audio thread — see rnnoiseInWorkletSource.ts. Falls back
 *         to the original Worker-fed design (rnnoiseWorkletSource.ts +
 *         rnnoise.worker.ts) if the in-worklet path fails to come up. The
 *         RNNoise compensation gain, +3.5 dB when a sample was actually
 *         processed, is applied INSIDE this worklet either way — see nsKernel.js)
 *     → GateWorkletNode (RMS gate; pass-through when disabled)
 *     → EQ[80Hz, 250Hz, 1kHz, 4kHz, 12kHz] (5× BiquadFilterNode; gains zeroed when disabled)
 *     → AgcWorkletNode (slow adaptive gain toward a target speech level, with a
 *         built-in fast peak limiter; pass-through at unity gain when the
 *         "Auto gain control" setting is off — see agcKernel.js)
 *     → DynamicsCompressorNode (fast layer for consonant peaks; ratio = 1 when
 *         "Auto gain control" is off = transparent passthrough)
 *     → MicVolumeGain (0–200% boost — post-compression makeup gain)
 *     → AnalyserNode (feeds input level meter so meter reflects final gain)
 *     → MediaStreamAudioDestinationNode
 *     → processedTrack
 *
 * "Auto gain control" is a genuine two-stage AGC now (the libwebrtc AGC2
 * pattern), not just a compressor with a fixed threshold: the AGC worklet is
 * the slow stage (a few dB/s, steering average speech level toward a target
 * so two speakers with very different hardware levels converge to roughly
 * the same loudness on the wire) and the DynamicsCompressorNode downstream
 * is the fast stage (levelling out consonant peaks within one already-
 * normalized speaker's speech). See agcKernel.js for why a fixed-threshold
 * compressor alone couldn't do this: a quiet mic never crossed the old
 * threshold, so it only ever got a flat makeup gain, while a hot mic got
 * compressed — a 30 dB hardware gap came out ~20 dB apart regardless of the
 * setting on either end.
 *
 * Noise suppression architecture (Phase 3, reliability audit):
 *   - Primary: the AudioWorklet accumulates 480-sample frames and runs RNNoise's
 *     WASM directly inline, on the real-time audio-rendering thread — that
 *     thread gets elevated OS scheduling priority a plain Worker doesn't,
 *     which matters specifically under the "CPU-starved by a demanding game"
 *     scenario this whole reliability pass started from. See
 *     rnnoiseInWorkletSource.ts for the full design and the tradeoff it
 *     accepts (no graceful mid-quantum recovery if a single processFrame()
 *     call ever overruns the render-quantum budget — NsOutputRing's
 *     underrun/hysteresis auto-bypass, unchanged, is what bounds that risk).
 *   - Fallback: if the in-worklet path fails to register/construct, this
 *     automatically falls back to the original design — a separate Web
 *     Worker (rnnoise.worker.ts) running the same WASM off the main thread,
 *     talking to the worklet via a direct MessageChannel port. Not deleted;
 *     kept as a proven safety net for whatever environment-specific reason
 *     the inline path might not come up on some machine.
 *   - No MediaStreamTrackGenerator is used → no devicechange events fired →
 *     LiveKit does not restart the mic track when NS is toggled.
 *   - NS toggle: postMessage { type: 'toggle', enabled } — no stream restart,
 *     no graph reconnection, no audio gap. The worklet passes audio through
 *     (raw copy) when disabled (or not yet ready).
 *
 * All parameters are updatable in real-time without tearing down the pipeline.
 */

import RNNoiseWorker from '../workers/rnnoise.worker?worker';
import type { VoiceSettings } from '../hooks/useVoiceSettings';
// The two RNNoise worklet sources are loaded on demand (the inline one is
// ~4.8 MB of vendored WASM glue) — see rnnoiseSources.ts.
import { loadInlineRnnoiseWorkletSource, loadRnnoiseWorkletSource } from './rnnoiseSources';
import { AGC_WORKLET_SOURCE } from './agcWorkletSource';
import { registerCtxForUnlock } from './audioUnlock';
import { workletModuleUrl, forgetWorkletModuleUrl } from './workletModuleUrl';

// ── Compressor preset (applied when volumeNormalization is ON) ──────────────
// Goal: genuine level normalisation — quiet mics come up, loud mics come down.
//
// threshold: -26 dBFS catches typical conversational speech (−20 to −30 dBFS)
//            so the compressor actually fires on most voices. The old −14 value
//            only caught loud peaks and left quiet mics untouched.
// ratio:      4:1 is a levelling compressor (vs 2.5:1 which is more "gentle
//             limiter"). Perceptually this evens out large level differences
//             between speakers without sounding squashed.
// knee:       12 dB wide knee → soft onset, natural-sounding transition into
//             compression. Wider than the old 8 dB — avoids pumping artefacts
//             on speech with sharp consonants.
// attack:     3 ms — fast enough to catch consonant peaks without sounding
//             harsh (same as before).
// release:    200 ms — faster than the old 250 ms for a more responsive,
//             "breathing" feel during pauses.
//
// IMPORTANT: this compressor sits downstream of the AgcWorkletNode (see the
// module doc comment above). AGC does the actual cross-speaker levelling;
// this compressor is the fast layer smoothing peaks WITHIN one already-
// normalized speaker's speech. It no longer carries a makeup gain — see
// COMPRESSOR_MAKEUP_GAIN below.

const COMPRESSOR_PRESET = { threshold: -26, knee: 12, ratio: 4.0, attack: 0.003, release: 0.20 };

// ── Compressor makeup gain ────────────────────────────────────────────────────
// Was a dedicated GainNode placed between the compressor and MicVolumeGain,
// lifting the compressed output (+5 dB, later +3 dB) so normalization raised
// average loudness instead of just limiting peaks.
//
// Removed to 0 dB / unity as part of the "people in calls are too loud" fix
// (2026-09-27): with the AGC worklet upstream already steering everyone's
// speech RMS to a fixed target (see DEFAULT_TARGET_DB in agcKernel.js), any
// flat makeup gain here just re-adds loudness AGC had already normalized
// away — the two stages' gain compounded instead of one levelling (AGC) and
// one smoothing (compressor). The GainNode stays wired in the graph (kept
// for structural symmetry / a future per-user tuning knob) but is pinned to
// unity in both the on and off states below.
const COMPRESSOR_MAKEUP_GAIN = 1.0; // unity — was 1.413 (≈ +3 dB), before that ≈ +5 dB

// Settings mic-volume slider is 0..200 (% of unity). Convert to a linear
// gain multiplier with a perceptual power curve so the slider feels uniform.
// At slider=100 we still hit gain=1.0 exactly (no surprise change for users
// who never touched the slider). exponent 1.25 is gentler than the per-user
// playback curve (1.5) because outgoing voice goes through the compressor,
// which already nonlinearizes things.
const MIC_GAIN_EXPONENT = 1.25;
const micSliderToGain = (slider: number): number =>
    Math.pow(Math.max(0, slider) / 100, MIC_GAIN_EXPONENT);

// ── Compressor bypass values (transparent passthrough when OFF) ──────────────
// ratio = 1 means 1:1 compression = no gain reduction regardless of input level.

const COMPRESSOR_BYPASS = { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 };

// ── 5-band EQ frequencies ─────────────────────────────────────────────────────
const EQ_FREQS = [80, 250, 1000, 4000, 12000] as const;
const EQ_Q = 1.4;

// ── RNNoise compensation gain ─────────────────────────────────────────────────
// RNNoise is a deep-learning suppressor and, by design, attenuates the full
// signal (noise + voice) rather than surgically removing only the noise
// component. In practice this produces a 2–4 dB drop in perceived loudness
// compared to the same mic with NS off, which is especially noticeable for
// users whose hardware level is already on the quiet side.
//
// This gain is applied INSIDE the RNNoise AudioWorklet (NsOutputRing in
// nsKernel.js), not via a separate GainNode here, and ONLY to samples that
// were actually produced by RNNoise. That distinction matters: the previous
// implementation lived in a GainNode gated on the `noiseSuppression` SETTING,
// so any quantum where the worklet fell back to raw passthrough (an underrun
// under CPU load, or simply before the Worker finished loading) still got
// the +3.5 dB boost applied to unprocessed audio — a real, audible level
// jump on top of the processed/raw discontinuity. Applying it inside the
// ring, keyed to whether THIS sample was processed, means raw passthrough is
// always unity gain and only genuinely-denoised audio ever gets boosted.
// Exported so useParticipantAudio.ts's remote per-participant NS chain (which
// shares this same rnnoise-worklet source) applies the identical compensation
// instead of the two paths drifting apart — see the comment at its call site.
export const RNNOISE_COMP_GAIN = 1.496; // ≈ +3.5 dB

// ── RNNoise sample rate — NOT negotiable ──────────────────────────────────────
// RNNoise is trained and hard-wired for 48 kHz: its 480-sample frame IS 10 ms,
// and its band energies / pitch analysis assume that. The AudioWorklet
// accumulates exactly 480 samples per frame with no resampling, so if the
// AudioContext runs at any other rate we hand RNNoise the wrong duration of
// audio and it produces garbage — which presents as "noise suppression doesn't
// do anything" (or makes voices sound robotic), NOT as an error.
//
// This is a real hazard rather than a theoretical one, because LiveKit hands us
// its own AudioContext and creates it WITHOUT a sample rate:
//
//     // livekit-client, getNewAudioContext()
//     const audioContext = new AudioContext({ latencyHint: 'interactive' });
//
// which means it inherits the hardware default — commonly 44100 Hz on Windows
// (the Sound control panel "Default Format"), and 96/192 kHz on some DACs and
// gaming headsets. LocalParticipant.createTracks() then does
// `track.setAudioContext(this.audioContext)`, and LocalTrack.setProcessor()
// passes it straight into init() below. So on those machines NS was silently
// broken while working fine on any machine that happened to default to 48 kHz —
// the "noise suppression doesn't work on some people's systems" report, and the
// reason changing a Windows audio device setting (which can move the shared-mode
// mix format) appeared to fix it.
//
// We therefore refuse a host context at the wrong rate and run our own.
export const RNNOISE_SAMPLE_RATE = 48000;

/**
 * Whether an AudioContext at `sampleRate` can host the RNNoise worklet.
 *
 * Deliberately an exact-equality check with no tolerance: "close to 48 kHz" is
 * still wrong, because the worklet slices fixed 480-sample frames and never
 * resamples. Exported so the requirement is pinned by a test rather than living
 * only in a comment someone could optimise away.
 */
export function isUsableRnnoiseContext(sampleRate: number | undefined): boolean {
    return sampleRate === RNNOISE_SAMPLE_RATE;
}

/** Just enough of an AudioContext to make the choice below — so the decision is
 *  testable in vitest's `node` environment, where WebAudio does not exist. */
export interface ContextCandidate {
    sampleRate: number;
    state: AudioContextState;
}

/**
 * Which AudioContext should `init()` build the graph on?
 *
 * This exists as a separate, exported function because the mic-device-switch
 * bug lived entirely in this decision, and it is the only part of `init()` that
 * can be exercised without a real WebAudio graph.
 *
 * `provided` is `opts.audioContext`. `retained` is the host context this
 * processor adopted on a PREVIOUS init and kept a reference to — the thing that
 * makes a restart land back where it started:
 *
 *   livekit-client's `LocalTrack.setProcessor()` calls
 *   `processor.init({ ..., audioContext: this.audioContext })`, but the restart
 *   path — `setMediaStreamTrack()`, which every `switchActiveDevice('audioinput')`
 *   goes through — calls `processor.restart({ track, kind, element, localTrack })`
 *   with **no** `audioContext` at all (livekit-client@2.18.8,
 *   LocalTrack.ts:193-198 vs :554-561). Without `retained`, every mic device
 *   switch therefore dropped the host's context and silently constructed a
 *   brand-new one.
 *
 * A 'closed' context is unusable and a wrong-rate one runs RNNoise on
 * wrongly-sized frames (see RNNOISE_SAMPLE_RATE), so either falls through to
 * the next candidate rather than being adopted.
 */
export function pickProcessorContext(
    provided: ContextCandidate | undefined,
    retained: ContextCandidate | undefined,
): 'provided' | 'retained' | 'own' {
    if (provided && provided.state !== 'closed' && isUsableRnnoiseContext(provided.sampleRate)) {
        return 'provided';
    }
    if (retained && retained.state !== 'closed' && isUsableRnnoiseContext(retained.sampleRate)) {
        return 'retained';
    }
    return 'own';
}

// ── Smooth ramp time constant (seconds) for bypass transitions ──────────────
const RAMP_TC = 0.02;

/** Worklet processors already registered per AudioContext (see init()'s
 *  addWorkletModule). Weak: a closed context's entry goes with it. */
const registeredWorkletProcessors = new WeakMap<BaseAudioContext, Set<string>>();

// ── Gate AudioWorklet source (inlined as Blob URL) ───────────────────────────
// Runs entirely on the audio rendering thread — no JS timer jitter, no postMessage
// round-trip. Detection + gain are updated every 128-sample quantum (~2.67ms at
// 48 kHz), so the attack latency is imperceptible (vs 20ms with a setInterval gate).
//
// Algorithm per quantum:
//   1. Compute RMS of the input block.
//   2. If RMS >= threshold → reset hold counter, ramp gate open (fast attack).
//   3. If in hold period → keep gate open, decrement hold counter.
//   4. Otherwise → ramp gate closed (slow release so words don't get cut).
const GATE_WORKLET_SOURCE = `
class GateWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        // Default: disabled (pass-through)
        this.enabled   = false;
        this.threshold = Math.pow(10, -45 / 20); // linear, -45 dBFS default
        // Hold: how many samples to stay open after level drops below threshold.
        // 150 ms × 48000 = 7200 samples.
        this.holdTotal  = Math.round(0.150 * sampleRate);
        this.holdLeft   = 0;
        this.gain       = 1; // current gate gain (0..1)
        // Per-sample rates — calculated at construction so sampleRate is available.
        // Attack: open over ~0.67 ms (32 samples at 48 kHz).
        this.attackRate  = 1 / 32;
        // Release: close over ~50 ms (2400 samples at 48 kHz).
        this.releaseRate = 1 / 2400;

        this.port.onmessage = ({ data }) => {
            if (data.type === 'gate') {
                this.enabled = data.enabled;
                if (!data.enabled) {
                    this.gain    = 1; // immediately pass-through when gate is off
                    this.holdLeft = 0;
                }
            } else if (data.type === 'threshold') {
                // Receive threshold in dBFS, store as linear amplitude
                this.threshold = Math.pow(10, data.value / 20);
            } else if (data.type === 'hold') {
                this.holdTotal = Math.round((data.ms / 1000) * sampleRate);
            }
        };
    }

    process(inputs, outputs) {
        const inp = inputs[0]?.[0];
        const out = outputs[0]?.[0];
        if (!out) return true;

        if (!this.enabled) {
            if (inp) out.set(inp); else out.fill(0);
            return true;
        }

        if (!inp) { out.fill(0); return true; }

        // RMS for this 128-sample quantum
        let sum = 0;
        for (let i = 0; i < inp.length; i++) sum += inp[i] * inp[i];
        const rms = Math.sqrt(sum / inp.length);

        if (rms >= this.threshold) {
            this.holdLeft = this.holdTotal; // voice detected — reset hold timer
        } else if (this.holdLeft > 0) {
            this.holdLeft -= inp.length;    // still in hold period
        }

        const gateOpen = this.holdLeft > 0;

        for (let i = 0; i < inp.length; i++) {
            if (gateOpen) {
                // Fast attack: ramp up so we don't click on open
                this.gain = Math.min(1, this.gain + this.attackRate);
            } else {
                // Slow release: ramp down so trailing words aren't chopped
                this.gain = Math.max(0, this.gain - this.releaseRate);
            }
            out[i] = inp[i] * this.gain;
        }
        return true;
    }
}
registerProcessor('gate-worklet', GateWorklet);
`;

// RNNOISE_WORKLET_SOURCE lives in rnnoiseWorkletSource.ts (loaded via rnnoiseSources.ts)

// ── Processor ─────────────────────────────────────────────────────────────────

export interface VoiceProcessorCallbacks {
    onVadProbability?: (prob: number) => void;
    onInputLevel?: (dbfs: number) => void;
    /** Fires when the load-adaptive auto-bypass trips (NS paused because the
     *  RNNoise Worker can't keep up with real-time — sustained CPU load) or
     *  recovers. Intended to drive a small user-visible notice; see
     *  NsOutputRing's hysteresis logic in nsKernel.js. */
    onNsAutoBypass?: (active: boolean) => void;
    /** Throttled (~1/s) health stats forwarded from the RNNoise worklet. */
    onNsStats?: (stats: { underruns: number; state: string; bufferedSamples: number }) => void;
    /** Throttled (~1/s) health stats forwarded from the AGC worklet — the
     *  currently-applied gain in dB and whether it currently considers the
     *  input to be speech (see agcKernel.js's floor-based voice detection). */
    onAgcStats?: (stats: { gainDb: number; voiceActive: boolean }) => void;
    /** Fires once if the worklet pipeline (gate + RNNoise) failed to come up
     *  at all — a CSP block, a torn-down context, or WASM failing to load —
     *  and the processor fell back to a chain with no NS/gate. EQ, the
     *  compressor, and mic volume still work; this call never had a raw-mic
     *  fallback, since the processor is always attached now (see
     *  voiceProcessorManager.ts). Distinct from onNsAutoBypass, which is a
     *  temporary load-driven pause that recovers on its own. */
    onNsUnavailable?: () => void;
}

export class CipherlineVoiceProcessor {
    // LiveKit TrackProcessor interface
    readonly name = 'cipherline-voice-processor';
    processedTrack?: MediaStreamTrack;

    // Audio graph nodes (connected once in init, never disconnected until destroy)
    private ctx?: AudioContext;
    private _ownCtx = false; // true when ctx was created here, not passed via opts
    /** The host-owned AudioContext we adopted on a previous init, kept so a
     *  `restart()` — which livekit-client calls WITHOUT one — can land back on
     *  it instead of constructing a fresh context. See pickProcessorContext. */
    private _hostCtx?: AudioContext;
    /** False when we could not get a 48 kHz context — NS stays in passthrough
     *  rather than running RNNoise on wrongly-sized frames. See
     *  RNNOISE_SAMPLE_RATE. */
    private _nsSupported = true;
    private source?: MediaStreamAudioSourceNode;
    private rnnoiseWorkletNode?: AudioWorkletNode;
    /** The slow-stage AGC — see the module doc comment. Pass-through at unity
     *  gain when "Auto gain control" is off. */
    private agcWorkletNode?: AudioWorkletNode;
    /** Makeup gain after the compressor: pinned to unity (1.0) regardless of
     *  volumeNormalization — see COMPRESSOR_MAKEUP_GAIN's comment. Kept as a
     *  GainNode in the graph for structural symmetry / a future tuning knob,
     *  not because it currently does anything. */
    private compressorMakeupGain?: GainNode;
    private micVolumeGain?: GainNode;
    private analyser?: AnalyserNode;
    private gateWorkletNode?: AudioWorkletNode; // gate runs in audio thread — no JS timer jitter
    private eqFilters: BiquadFilterNode[] = [];
    private compressor?: DynamicsCompressorNode;
    private destination?: MediaStreamAudioDestinationNode;

    // RNNoise Worker (runs WASM off main thread)
    private rnnoiseWorker?: Worker;
    // MessageChannel: port1 → Worker, port2 → AudioWorklet
    private workerChannel?: MessageChannel;

    // Settings (mutable in real-time)
    private _settings: VoiceSettings;
    private _callbacks: VoiceProcessorCallbacks;

    // Level poll timer (UI meter only — gate logic lives in GateWorklet now)
    private levelPollTimer: ReturnType<typeof setInterval> | null = null;

    /** How often onInputLevel fires. 20 ms suits a visible meter (Settings'
     *  mic test); a call's only reader is the ~1 Hz silence watchdog, so the
     *  call processor polls at 100 ms — 40 fewer main-thread wakeups a second
     *  for the whole call, same latest-value semantics for the watchdog. */
    private readonly levelPollMs: number;

    constructor(settings: VoiceSettings, callbacks: VoiceProcessorCallbacks = {}, opts: { levelPollMs?: number } = {}) {
        this._settings = { ...settings };
        this._callbacks = callbacks;
        this.levelPollMs = opts.levelPollMs ?? 20;
    }

    /**
     * Whether RNNoise should actually be running: the user asked for it AND we
     * have a context it can legitimately run in. Every enable/disable path goes
     * through this so an unsupported sample rate can't be overridden by a
     * settings toggle. See RNNOISE_SAMPLE_RATE.
     */
    private nsActive(): boolean {
        return this._nsSupported && this._settings.noiseSuppression;
    }

    // ── Output node — connect this to a destination for monitoring ───────
    // Must be the last node before the MediaStreamDestination so "Listen to
    // mic" playback reflects the full chain including MicVolumeGain.
    // The analyser passes audio through transparently; connecting it to an
    // additional destination just forks the signal — the MediaStream chain
    // is unaffected.
    get outputNode(): AudioNode | undefined {
        return this.analyser ?? undefined;
    }

    // ── LiveKit TrackProcessor interface ──────────────────────────────────

    async init(opts: { track: MediaStreamTrack; audioContext?: AudioContext; kind?: string }) {
        // latencyHint: 'interactive' forces Chromium's smallest audio buffer size.
        // Without it, Chromium is free to choose a larger buffer under load, which
        // compounds with the 10 ms RNNoise frame period and can push total input→
        // processed latency from ~15 ms into the 30–60 ms range in packaged builds.
        // Explicit is safer.
        // Only adopt the host's AudioContext if it is already at RNNoise's
        // required rate; otherwise run our own. See RNNOISE_SAMPLE_RATE for why
        // this is the difference between working and silently-broken NS.
        const choice = pickProcessorContext(opts.audioContext, this._hostCtx);
        if (opts.audioContext && choice !== 'provided') {
            console.warn(
                `[VoiceProcessor] Host AudioContext is ${opts.audioContext.sampleRate} Hz ` +
                `(state ${opts.audioContext.state}); RNNoise needs ${RNNOISE_SAMPLE_RATE} Hz. ` +
                `Using a ${choice === 'retained' ? 'retained' : 'dedicated'} context instead.`
            );
        }
        const hostCtx =
            choice === 'provided' ? opts.audioContext
            : choice === 'retained' ? this._hostCtx
            : undefined;
        const ctx = hostCtx ?? new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE, latencyHint: 'interactive' });
        this._ownCtx = !hostCtx;
        // Remember a host context so the next restart can find it again. Only a
        // host one: a context we made ourselves is closed by destroy(), so
        // retaining it would hand the next init a closed context.
        this._hostCtx = hostCtx;
        this.ctx = ctx;

        // NEVER await resume() here. Chromium/Electron only resolve it once a
        // genuine user gesture has occurred, and on a cold launch that auto-joins
        // a call, no gesture has happened yet — the await used to hang forever,
        // and because setProcessor() holds LiveKit's trackChangeLock for the
        // duration of init(), that also silently wedged mute and device-switch
        // for the rest of the call. This was the root cause of "no noise
        // suppression until I leave and rejoin" — leaving was incidentally the
        // first click, i.e. the first gesture. Fire the resume without blocking
        // and register the context so a LATER gesture (of any kind, anywhere in
        // the app) resumes it — see audioUnlock.ts for why that has to be a
        // persistent registry rather than a one-shot listener.
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => { /* retried by the gesture-unlock registry */ });
            registerCtxForUnlock(ctx);
        }

        // Everything below — addModule, node construction, connecting the graph —
        // works on a still-suspended context; only rendering (i.e. audio actually
        // flowing) waits on resume(). So the whole chain is built and the
        // processedTrack exists immediately, exactly as before; the only change
        // is that we no longer block on the resume settling.

        // Belt and braces: a UA is permitted to ignore the requested rate. If we
        // still aren't at 48 kHz, run everything else (gate, EQ, compressor,
        // gain — all of which are rate-agnostic) but leave RNNoise in
        // passthrough. Honestly-absent NS beats NS that mangles the signal.
        this._nsSupported = isUsableRnnoiseContext(ctx.sampleRate);
        if (!this._nsSupported) {
            console.error(
                `[VoiceProcessor] AudioContext locked at ${ctx.sampleRate} Hz — noise suppression ` +
                `disabled (RNNoise requires ${RNNOISE_SAMPLE_RATE} Hz).`
            );
        }
        // One-time diagnostic so we can compare dev vs prod numbers.
        // baseLatency = audio graph internal buffering; outputLatency = graph→speaker.
        // For a MediaStream destination we only care about baseLatency.
        console.log(
            `[VoiceProcessor] AudioContext: sampleRate=${ctx.sampleRate}Hz ` +
            `baseLatency=${(ctx.baseLatency * 1000).toFixed(2)}ms ` +
            `outputLatency=${((ctx.outputLatency ?? 0) * 1000).toFixed(2)}ms ` +
            `state=${ctx.state}`
        );

        // Disable browser NS — the Worker+Worklet pipeline handles it.
        opts.track.applyConstraints({ noiseSuppression: false }).catch(() => {});

        // ── Worklet + RNNoise pipeline (wrapped: must never fail the whole init) ──
        // The processor is now attached PRE-PUBLISH (see voiceProcessorManager.ts) —
        // LiveKit's createLocalTracks() awaits init() and calling code no longer has
        // a "just don't attach it" fallback the way the old post-publish setProcessor
        // effect did. If addModule/AudioWorkletNode construction throws here and we
        // let it propagate, the entire call join fails, not just noise suppression.
        // That's strictly worse than a call with degraded audio processing. So:
        // catch failures in this block and fall back to a chain with NO gate/NS
        // worklets (source connects straight into the EQ/compressor chain below,
        // which are plain nodes and can't fail this way) — everything downstream
        // still works, and `_workletsSupported=false` drives a visible "noise
        // suppression unavailable" notice via onNsUnavailable.
        let workletsOk = true;
        try {
            // LiveKit can reuse the same AudioContext across restart() calls, in
            // which case addModule() throws because the processor name is already
            // registered — that specific failure is harmless, the class is still
            // available. Anything else (CSP block, revoked blob URL, torn-down
            // context) is a REAL failure. Distinguish the two by probing: if a
            // node can actually be constructed after the "failure", registration
            // really did succeed; if the probe ALSO throws, re-throw so the outer
            // catch below falls back to the no-worklet chain.
            const addWorkletModule = async (source: string, processorName: string) => {
                // A device switch restarts the processor on the SAME retained
                // context (see restart()); its processors are still registered
                // there, so skip the reload — for RNNoise that is a ~4.8 MB
                // module re-evaluated on the real-time audio thread, i.e. an
                // audible hitch on every mic switch.
                const known = registeredWorkletProcessors.get(ctx);
                if (known?.has(processorName)) return;
                // One Blob URL per source for the session — see workletModuleUrl.ts
                // (wrapping the 4.8 MB RNNoise source used to cost ~120 ms of
                // main thread per context, twice per join).
                const url = workletModuleUrl(processorName, source);
                try {
                    await ctx.audioWorklet.addModule(url);
                } catch (err) {
                    try {
                        const probe = new AudioWorkletNode(ctx, processorName);
                        probe.disconnect();
                    } catch {
                        forgetWorkletModuleUrl(processorName);
                        throw err;
                    }
                }
                if (known) known.add(processorName);
                else registeredWorkletProcessors.set(ctx, new Set([processorName]));
            };
            await addWorkletModule(GATE_WORKLET_SOURCE, 'gate-worklet');

            // ── RNNoise worklet: in-worklet synchronous (Phase 3), else the
            // Worker-fed design as an automatic fallback ──────────────────────
            // Try the inline path first: RNNoise's WASM runs directly inside this
            // AudioWorkletProcessor on the real-time audio thread — see
            // rnnoiseInWorkletSource.ts's header comment for the full rationale
            // and the tradeoff it accepts. If registering/constructing THAT
            // specific worklet fails for any reason (this addModule/construct
            // pair is wrapped in its OWN try, separate from the outer one), fall
            // back to the original Worker-fed 'rnnoise-worklet' — proven, still
            // fully present in the codebase, not deleted. Only if BOTH fail does
            // this propagate to the outer catch below (which disables gate/AGC
            // too, on the theory that two independent worklet failures in the
            // same AudioContext point at something systemic like a CSP block).
            try {
                await addWorkletModule(await loadInlineRnnoiseWorkletSource(), 'rnnoise-inline-worklet');
                this.rnnoiseWorkletNode = new AudioWorkletNode(ctx, 'rnnoise-inline-worklet', {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [1],
                });
                this.rnnoiseWorkletNode.port.postMessage({ type: 'compGain', value: RNNOISE_COMP_GAIN });
                this.rnnoiseWorkletNode.port.onmessage = ({ data }: MessageEvent) => {
                    if (data.type === 'nsAutoBypass') {
                        this._callbacks.onNsAutoBypass?.(data.active);
                    } else if (data.type === 'stats') {
                        this._callbacks.onNsStats?.(data);
                    } else if (data.type === 'rnnoiseLoadFailed') {
                        // Async failure AFTER the worklet is already registered and
                        // (likely) already wired into the graph — no live-swap to
                        // the Worker-fed path attempted here (real graph-splice
                        // risk for a rare failure mode). The inline worklet's own
                        // outputRing simply stays permanently bypassed (raw
                        // passthrough), same end state as the Worker-fed design's
                        // equivalent async failure.
                        console.warn('[VoiceProcessor] In-worklet RNNoise WASM load failed — NS unavailable:', data.error);
                        this._callbacks.onNsUnavailable?.();
                    }
                };
                this.rnnoiseWorkletNode.port.postMessage({ type: 'toggle', enabled: this.nsActive() });
                console.log('[VoiceProcessor] In-worklet synchronous RNNoise registered');
            } catch (inlineErr) {
                console.warn(
                    '[VoiceProcessor] In-worklet RNNoise unavailable, falling back to the ' +
                    'Worker-fed design:', inlineErr
                );
                try { this.rnnoiseWorkletNode?.disconnect(); } catch {}
                this.rnnoiseWorkletNode = undefined;

                await addWorkletModule(await loadRnnoiseWorkletSource(), 'rnnoise-worklet');
                this.rnnoiseWorkletNode = new AudioWorkletNode(ctx, 'rnnoise-worklet', {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [1],
                });
                // Worklet starts with enabled=false (passthrough) until the Worker is ready.
                // Set the compensation gain up front — NsOutputRing applies it only to
                // samples it actually processed, so this is safe to set unconditionally
                // rather than tracking nsActive() state (see RNNOISE_COMP_GAIN comment).
                this.rnnoiseWorkletNode.port.postMessage({ type: 'compGain', value: RNNOISE_COMP_GAIN });
                this.rnnoiseWorkletNode.port.onmessage = ({ data }: MessageEvent) => {
                    if (data.type === 'nsAutoBypass') {
                        this._callbacks.onNsAutoBypass?.(data.active);
                    } else if (data.type === 'stats') {
                        this._callbacks.onNsStats?.(data);
                    }
                };

                // ── RNNoise Worker (loads WASM off main thread — do NOT await) ──
                // Starting the Worker is async (~1–3 s for WASM to load). We connect the
                // audio graph immediately so LiveKit has a processedTrack right away, then
                // enable NS in the worklet as soon as the Worker signals ready. This
                // prevents the "NS inactive on join" bug caused by a multi-second
                // blocking init().
                this.rnnoiseWorker  = new RNNoiseWorker();
                this.workerChannel  = new MessageChannel();

                this.rnnoiseWorker.onmessage = ({ data }: MessageEvent) => {
                    // P2-REND-12: Worker sends {type:'error'} on WASM load failure.
                    // Previously this fell through the 'ready' guard and was silently
                    // dropped — leaving the Worker alive with no NS active and no signal
                    // to the user. The worklet's ring never receives a workerPort in this
                    // case, so process() stays on its `bypassed` (raw passthrough) path
                    // permanently — correctly at unity gain, since compGain now only
                    // ever applies to ring (processed) samples.
                    if (data.type === 'error') {
                        console.warn('[VoiceProcessor] RNNoise WASM load failed — NS unavailable:', data.error);
                        if (this.rnnoiseWorker) {
                            this.rnnoiseWorker.onmessage = null;
                            const w = this.rnnoiseWorker;
                            setTimeout(() => { try { w.terminate(); } catch {} }, 100);
                            this.rnnoiseWorker = undefined;
                        }
                        this.workerChannel = undefined;
                        this._callbacks.onNsUnavailable?.();
                        return;
                    }
                    if (data.type !== 'ready') return;
                    this.rnnoiseWorker!.onmessage = null; // one-shot

                    // Hand port2 directly to the AudioWorklet (Worker already has port1).
                    if (this.rnnoiseWorkletNode && this.workerChannel) {
                        this.rnnoiseWorkletNode.port.postMessage(
                            { type: 'workerPort', port: this.workerChannel.port2 },
                            [this.workerChannel.port2]
                        );
                        // Apply the current NS preference (may have changed while WASM was loading).
                        this.rnnoiseWorkletNode.port.postMessage({
                            type: 'toggle',
                            enabled: this.nsActive(),
                        });
                        console.log('[VoiceProcessor] RNNoise Worker ready, NS toggled to', this.nsActive());
                    }
                };

                this.rnnoiseWorker.onerror = (err) => {
                    console.warn('[VoiceProcessor] RNNoise Worker error, NS will be unavailable:', err);
                    this.rnnoiseWorker = undefined;
                    this.workerChannel = undefined;
                    this._callbacks.onNsUnavailable?.();
                    // Worklet falls back to raw passthrough at unity gain automatically
                    // (no workerPort ⇒ bypassed ⇒ no compGain applied) — nothing else to do.
                };

                // Kick off WASM loading in the Worker (fire-and-forget).
                this.rnnoiseWorker.postMessage({ type: 'init' }, [this.workerChannel.port1]);
            }

            await addWorkletModule(AGC_WORKLET_SOURCE, 'agc-worklet');

            // Gate worklet — runs in the audio rendering thread every 128 samples
            // (~2.67ms). Detection latency is imperceptible; no JS setInterval jitter.
            this.gateWorkletNode = new AudioWorkletNode(ctx, 'gate-worklet', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
            });
            this.gateWorkletNode.port.postMessage({ type: 'gate',      enabled: this._settings.voiceGate });
            this.gateWorkletNode.port.postMessage({ type: 'threshold', value: this._settings.voiceGateThreshold });
            this.gateWorkletNode.port.postMessage({ type: 'hold',      ms: 150 });

            // AGC worklet — the slow adaptive-gain stage (see module doc comment
            // and agcKernel.js). "Auto gain control" in Settings maps to
            // `volumeNormalization` here, same setting that used to drive only
            // the compressor.
            this.agcWorkletNode = new AudioWorkletNode(ctx, 'agc-worklet', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
            });
            this.agcWorkletNode.port.postMessage({ type: 'enabled', value: this._settings.volumeNormalization });
            this.agcWorkletNode.port.onmessage = ({ data }: MessageEvent) => {
                if (data.type === 'agcStats') {
                    this._callbacks.onAgcStats?.(data);
                }
            };
        } catch (err) {
            console.error(
                '[VoiceProcessor] Worklet pipeline unavailable — falling back to a ' +
                'passthrough chain with no noise suppression, voice gate, or AGC ' +
                '(EQ/compressor/mic-volume still work):', err
            );
            workletsOk = false;
            try { this.rnnoiseWorkletNode?.disconnect(); } catch {}
            this.rnnoiseWorkletNode = undefined;
            try { this.gateWorkletNode?.disconnect(); } catch {}
            this.gateWorkletNode = undefined;
            try { this.agcWorkletNode?.disconnect(); } catch {}
            this.agcWorkletNode = undefined;
            this._callbacks.onNsUnavailable?.();
        }

        // ── Audio graph nodes ──
        this.source = ctx.createMediaStreamSource(new MediaStream([opts.track]));

        this.micVolumeGain = ctx.createGain();
        // Perceptual curve: linear `slider/100` makes the 0-200 slider feel
        // very uneven (most change near the bottom, almost none up top).
        // x^1.25 keeps unity at 100%, modest boost at 200% (≈+7.5 dB), and
        // a smooth ramp through the middle.
        this.micVolumeGain.gain.value = micSliderToGain(this._settings.micVolume);

        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.3;

        this.eqFilters = EQ_FREQS.map((freq, i) => {
            const filter = ctx.createBiquadFilter();
            filter.type = 'peaking';
            filter.frequency.value = freq;
            filter.Q.value = EQ_Q;
            filter.gain.value = this._settings.eqEnabled ? (this._settings.eqBands[i] ?? 0) : 0;
            return filter;
        });

        this.compressor = ctx.createDynamicsCompressor();
        const preset = this._settings.volumeNormalization ? COMPRESSOR_PRESET : COMPRESSOR_BYPASS;
        this.compressor.threshold.value = preset.threshold;
        this.compressor.knee.value      = preset.knee;
        this.compressor.ratio.value     = preset.ratio;
        this.compressor.attack.value    = preset.attack;
        this.compressor.release.value   = preset.release;

        // Makeup gain paired with the compressor — boosts the compressed output
        // so the net effect is level normalisation (quiet up, loud down) rather
        // than mere peak limiting. Unity when normalization is off.
        this.compressorMakeupGain = ctx.createGain();
        this.compressorMakeupGain.gain.value = this._settings.volumeNormalization ? COMPRESSOR_MAKEUP_GAIN : 1.0;

        this.destination = ctx.createMediaStreamDestination();

        // ── Connect the full chain ──
        // Source → RNNoiseWorklet → GateWorklet → EQ[0..4] → AgcWorklet
        //        → Compressor → CompressorMakeupGain → MicVolumeGain → Analyser → Dest
        //
        // The RNNoise compensation gain (+3.5 dB when a sample was actually
        // processed, unity when it's raw passthrough) is applied INSIDE the
        // worklet now (NsOutputRing in nsKernel.js) rather than by a separate
        // GainNode here — see the RNNOISE_COMP_GAIN comment for why.
        //
        // AgcWorkletNode is the slow cross-speaker levelling stage; the
        // compressor downstream is the fast within-speaker peak-smoothing
        // stage. CompressorMakeupGain is pinned to unity regardless of the
        // normalization setting — see that constant's comment for why the
        // makeup gain was removed entirely rather than merely reduced again.
        //
        // MicVolumeGain sits AFTER the makeup gain as the user-controlled
        // boost (0–300%). Analyser follows so the level meter reflects
        // the final gain the user has dialed in.
        //
        // If the worklet pipeline failed to come up (workletsOk === false),
        // rnnoiseWorkletNode/gateWorkletNode/agcWorkletNode don't exist —
        // connect straight from source into the EQ/compressor chain instead.
        // Everything past that point is plain WebAudio nodes that can't fail
        // the way worklet registration can, so mic volume, EQ, and the
        // (unchanged) compressor still work even with no noise suppression,
        // voice gate, or AGC.
        let current: AudioNode = this.source;
        if (workletsOk && this.rnnoiseWorkletNode && this.gateWorkletNode) {
            this.source.connect(this.rnnoiseWorkletNode);
            this.rnnoiseWorkletNode.connect(this.gateWorkletNode);
            current = this.gateWorkletNode;
        }
        for (const filter of this.eqFilters) {
            current.connect(filter);
            current = filter;
        }
        if (workletsOk && this.agcWorkletNode) {
            current.connect(this.agcWorkletNode);
            current = this.agcWorkletNode;
        }
        current.connect(this.compressor);
        this.compressor.connect(this.compressorMakeupGain!);
        this.compressorMakeupGain!.connect(this.micVolumeGain!);
        this.micVolumeGain.connect(this.analyser);
        this.analyser.connect(this.destination);

        this.processedTrack = this.destination.stream.getAudioTracks()[0];
        this.startLevelPolling();

        console.log('[VoiceProcessor] Initialized (Worker+Worklet NS, 48 kHz)');
    }

    /**
     * Called by livekit-client whenever the underlying capture track is
     * replaced — which is what `room.switchActiveDevice('audioinput', ...)`
     * ultimately does (LocalTrack.restart -> setMediaStreamTrack -> here).
     *
     * `opts` deliberately arrives WITHOUT an `audioContext`: the library passes
     * one on `setProcessor` and not on this path. `init()` therefore falls back
     * to the host context retained from the previous init — see
     * pickProcessorContext. Do not "simplify" that away: building a fresh
     * AudioContext here is a mid-call context with no transient user
     * activation behind it, so it can come up suspended, and a suspended
     * context's MediaStreamDestination emits silence — which `replaceTrack`
     * then hands to the SFU as the user's microphone.
     */
    async restart(opts: { track: MediaStreamTrack; audioContext?: AudioContext; kind?: string }) {
        await this.destroy();
        await this.init(opts);
    }

    async destroy() {
        this.stopLevelPolling();

        // Terminate the RNNoise Worker
        if (this.rnnoiseWorker) {
            this.rnnoiseWorker.onmessage = null; // prevent late 'ready' handler from firing
            this.rnnoiseWorker.onerror   = null;
            this.rnnoiseWorker.postMessage({ type: 'destroy' });
            const workerToTerminate = this.rnnoiseWorker; // capture specific ref before nulling
            setTimeout(() => workerToTerminate.terminate(), 100);
            this.rnnoiseWorker = undefined;
        }
        this.workerChannel = undefined;

        if (this.rnnoiseWorkletNode) {
            this.rnnoiseWorkletNode.port.onmessage = null;
            try { this.rnnoiseWorkletNode.disconnect(); } catch {}
            this.rnnoiseWorkletNode = undefined;
        }

        try { this.source?.disconnect(); } catch {}
        try { this.compressorMakeupGain?.disconnect(); } catch {}
        this.compressorMakeupGain = undefined;
        try { this.micVolumeGain?.disconnect(); } catch {}
        try { this.analyser?.disconnect(); } catch {}
        if (this.gateWorkletNode) {
            this.gateWorkletNode.port.onmessage = null;
            try { this.gateWorkletNode.disconnect(); } catch {}
            this.gateWorkletNode = undefined;
        }
        if (this.agcWorkletNode) {
            this.agcWorkletNode.port.onmessage = null;
            try { this.agcWorkletNode.disconnect(); } catch {}
            this.agcWorkletNode = undefined;
        }
        this.eqFilters.forEach(f => { try { f.disconnect(); } catch {} });
        this.eqFilters = [];
        try { this.compressor?.disconnect(); } catch {}
        try { this.destination?.disconnect(); } catch {}
        this.processedTrack = undefined;

        // P2-REND-11: close the AudioContext only if this instance created it;
        // if the caller passed one in via opts.audioContext it owns the lifetime.
        if (this._ownCtx && this.ctx) {
            try { this.ctx.close(); } catch {}
            this.ctx = undefined;
            this._ownCtx = false;
        }

        console.log('[VoiceProcessor] Destroyed');
    }

    // ── Settings updates (call any time, no restart needed) ──────────────

    updateSettings(settings: VoiceSettings) {
        const prev = this._settings;
        this._settings = { ...settings };

        if (!this.ctx) return;
        const t = this.ctx.currentTime;

        // ── Noise suppression — toggle via postMessage to worklet ──
        // No stream restart, no graph change, no audio gap. If the Worker hasn't
        // finished loading yet, the worklet ignores this (workerPort is null so
        // process() passes through anyway). The Worker's 'ready' handler will apply
        // the current this._settings.noiseSuppression when it fires.
        if (prev.noiseSuppression !== settings.noiseSuppression && this.rnnoiseWorkletNode) {
            // nsActive() — not settings.noiseSuppression — so a context stuck at
            // the wrong sample rate keeps the worklet in passthrough no matter
            // what the toggle says. The compensation gain needs no separate
            // ramp here: it's applied inside the worklet only to samples that
            // are actually processed, so raw passthrough after a toggle-off is
            // automatically unity gain with no GainNode to keep in sync.
            this.rnnoiseWorkletNode.port.postMessage({
                type: 'toggle',
                enabled: this.nsActive(),
            });
        }

        // ── Mic volume ──
        if (prev.micVolume !== settings.micVolume && this.micVolumeGain) {
            const p = this.micVolumeGain.gain;
            const cv = p.value;
            p.cancelScheduledValues(t);
            p.setValueAtTime(cv, t);
            p.setTargetAtTime(micSliderToGain(settings.micVolume), t, 0.01);
        }

        // ── EQ bands ──
        this.eqFilters.forEach((filter, i) => {
            const targetGain = settings.eqEnabled ? (settings.eqBands[i] ?? 0) : 0;
            const prevGain = prev.eqEnabled ? (prev.eqBands[i] ?? 0) : 0;
            if (targetGain !== prevGain || prev.eqEnabled !== settings.eqEnabled) {
                const p = filter.gain;
                const cv = p.value;
                p.cancelScheduledValues(t);
                p.setValueAtTime(cv, t);
                p.setTargetAtTime(targetGain, t, RAMP_TC);
            }
        });

        // ── Compressor (volume normalization) ──
        if (prev.volumeNormalization !== settings.volumeNormalization && this.compressor) {
            const preset = settings.volumeNormalization ? COMPRESSOR_PRESET : COMPRESSOR_BYPASS;
            for (const [param, val] of [
                [this.compressor.threshold, preset.threshold],
                [this.compressor.knee,      preset.knee],
                [this.compressor.ratio,     preset.ratio],
            ] as [AudioParam, number][]) {
                const cv = param.value;
                param.cancelScheduledValues(t);
                param.setValueAtTime(cv, t);
                param.setTargetAtTime(val, t, RAMP_TC);
            }
            // Ramp the paired makeup gain in sync — enabling normalization
            // should immediately start lifting the signal, not just compressing it.
            if (this.compressorMakeupGain) {
                const p = this.compressorMakeupGain.gain;
                p.cancelScheduledValues(t);
                p.setValueAtTime(p.value, t);
                p.setTargetAtTime(settings.volumeNormalization ? COMPRESSOR_MAKEUP_GAIN : 1.0, t, RAMP_TC);
            }
            // Toggle the AGC worklet's slow stage in lockstep — "Auto gain
            // control" now drives both. setEnabled(false) inside the worklet
            // snaps its gain back to unity rather than leaving a stale
            // boost/cut baked in (see agcKernel.js).
            if (this.agcWorkletNode) {
                this.agcWorkletNode.port.postMessage({
                    type: 'enabled',
                    value: settings.volumeNormalization,
                });
            }
        }

        // ── Voice Gate ──
        if (this.gateWorkletNode) {
            if (prev.voiceGate !== settings.voiceGate) {
                this.gateWorkletNode.port.postMessage({ type: 'gate', enabled: settings.voiceGate });
            }
            if (prev.voiceGateThreshold !== settings.voiceGateThreshold) {
                this.gateWorkletNode.port.postMessage({ type: 'threshold', value: settings.voiceGateThreshold });
            }
        }
    }

    // ── Level metering (UI only — gate logic lives in GateWorklet) ───────

    private startLevelPolling() {
        this.stopLevelPolling();
        const analyserData = new Float32Array(this.analyser?.fftSize ?? 256);

        // 20ms poll is fine for the UI meter — the gate itself reacts every 128
        // samples (~2.67ms) inside the audio thread, so there's no coupling here.
        // (Calls poll slower — see levelPollMs.)
        this.levelPollTimer = setInterval(() => {
            if (!this.analyser) return;
            this.analyser.getFloatTimeDomainData(analyserData);

            let sum = 0;
            for (let i = 0; i < analyserData.length; i++) sum += analyserData[i] * analyserData[i];
            const rms = Math.sqrt(sum / analyserData.length);
            const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
            this._callbacks.onInputLevel?.(dbfs);
        }, this.levelPollMs);
    }

    private stopLevelPolling() {
        if (this.levelPollTimer) {
            clearInterval(this.levelPollTimer);
            this.levelPollTimer = null;
        }
    }
}
