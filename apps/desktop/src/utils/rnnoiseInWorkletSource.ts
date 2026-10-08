import nsKernelSrc from '../audio/nsKernel.js?raw';
// The package's package.json only exposes the root specifier (no deep
// dist/rnnoise.js subpath in its `exports` map) — `@shiguredo/rnnoise-wasm`
// bare, not a deep path, is the only import specifier Node's/Vite's
// exports-map resolution will actually allow. See rnnoiseVendorExtract.ts's
// header comment for the full "why text concatenation, not a real import"
// rationale, and the "canary" test in rnnoiseVendorExtract.test.ts that
// re-verifies this extraction against the real pinned dependency.
import rnnoiseGlueRaw from '@shiguredo/rnnoise-wasm?raw';
import { extractRnnoiseVendorGlue } from './rnnoiseVendorExtract';

const { body: rnnoiseGlueBody, rnnoiseName, denoiseStateName } = extractRnnoiseVendorGlue(rnnoiseGlueRaw);

/**
 * RNNoise AudioWorklet processor source — Phase 3 (reliability audit),
 * in-worklet SYNCHRONOUS RNNoise. Registers as 'rnnoise-inline-worklet',
 * deliberately a different processor name from 'rnnoise-worklet'
 * (rnnoiseWorkletSource.ts) — that Worker-fed implementation stays in the
 * codebase unchanged as the fallback path (see voiceProcessor.ts /
 * useParticipantAudio.ts) if this one fails to come up, rather than being
 * deleted outright.
 *
 * What changed vs the Worker-fed design, and why:
 *   - RNNoise's WASM runs DIRECTLY inside this AudioWorkletProcessor's own
 *     process() call, on the browser's real-time audio-rendering thread —
 *     no separate Worker, no cross-thread MessageChannel round-trip. The
 *     audio-rendering thread gets elevated OS scheduling priority that a
 *     plain Worker does not; under the exact "CPU-starved by a demanding
 *     game" scenario this whole reliability pass started from, the Worker
 *     thread could get starved by the OS scheduler in a way the audio
 *     thread itself is specifically protected against.
 *   - The tradeoff this accepts: if a single processFrame() call ever
 *     legitimately overruns the ~2.667ms render-quantum budget, THAT
 *     specific quantum has no graceful recovery — the Web Audio spec just
 *     drops it. The old design could always degrade to a raw-passthrough
 *     crossfade instead. See NsOutputRing's underrun/hysteresis logic below
 *     for why this is still a bounded, self-correcting risk: it detects
 *     "can't keep the output ring topped up" from pure sample counting
 *     (works identically whether the producer is a slow Worker or slow
 *     in-thread compute) and trips auto-bypass exactly like it always did.
 *   - MAX_INLINE_FRAMES_PER_QUANTUM (nsKernel.js) bounds how much backlog a
 *     single process() call will try to catch up on, so a burst of
 *     accumulated frames (e.g. right after RNNoise finishes loading) can't
 *     itself become the runaway-quantum failure mode this design is trying
 *     to avoid.
 *
 * The vendored WASM glue (@shiguredo/rnnoise-wasm's dist/rnnoise.js) is
 * concatenated as plain text, wrapped in its own IIFE so its ~4.8MB of
 * minified top-level names can't collide with nsKernel.js or this file's
 * own code, with only the two bindings it actually needs pulled back out
 * under real names. See rnnoiseVendorExtract.ts for the extraction logic
 * and why this is text concatenation rather than a real ES import.
 */
export const RNNOISE_INLINE_WORKLET_SOURCE = `
${nsKernelSrc}

// -- Vendored RNNoise WASM glue (@shiguredo/rnnoise-wasm, pinned in package.json) --
const __rnnoiseVendor = (function() {
    // Environment shim: an AudioWorkletGlobalScope has neither \`window\` nor
    // \`WorkerGlobalScope\` (worklets are not workers), and the Emscripten
    // glue's detection -
    //   if (!(typeof window == "object" || typeof WorkerGlobalScope < "u")) throw ...
    // - therefore rejected EVERY load in this worklet ("not compiled for this
    // environment"), which is an async failure the fallback path deliberately
    // does not live-swap on, so NS was simply unavailable on all machines.
    // Shadowing the name in this function scope makes \`typeof\` see it.
    // Safe because the glue's ONLY use of either name is that one check
    // (zero window./self/document/importScripts/fetch uses - the WASM is an
    // inline base64 payload), an invariant pinned by the occurrence-count
    // canary in rnnoiseVendorExtract.test.ts.
    const WorkerGlobalScope = function EnvShimForEmscriptenDetection() {};
    void WorkerGlobalScope;
${rnnoiseGlueBody}
    return { Rnnoise: ${rnnoiseName}, DenoiseState: ${denoiseStateName} };
})();
const Rnnoise = __rnnoiseVendor.Rnnoise;

class RNNoiseInlineWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.FRAME = RNNOISE_FRAME;
        // Input accumulation ring - chunks 128-sample render quanta into
        // 480-sample RNNoise frames. Unrelated to output buffering, which is
        // entirely owned by NsOutputRing below (unchanged from the Worker-fed
        // worklet - see nsKernel.js's header comment for why this same state
        // machine applies just as well to a synchronous producer).
        this.inSize = this.FRAME * RING_FRAMES;
        this.inRing = new Float32Array(this.inSize);
        this.inW = 0; this.inR = 0;
        this.enabled = false;
        this.rnnoiseReady = false;
        this.denoiseState = null;

        this.outputRing = new NsOutputRing();
        // Reused every 10 ms frame / every render quantum: nothing on this
        // real-time thread allocates in steady state (an allocation here is
        // a future GC pause on the one thread that must never stall).
        this.frame = new Float32Array(this.FRAME);
        this.ringOpts = { bypassed: false };

        this.statsQuantaSinceReport = 0;
        this.underrunsSinceReport = 0;

        this.port.onmessage = ({ data }) => {
            if (data.type === 'toggle') {
                this.enabled = data.enabled;
                if (!data.enabled) {
                    this.inW = this.inR = 0;
                    this.outputRing.reset();
                } else {
                    // Re-enabling (e.g. user flips NS back on mid-call) re-primes
                    // from scratch rather than resuming with stale ring state.
                    this.outputRing.reset();
                }
            } else if (data.type === 'compGain') {
                this.outputRing.setCompGain(data.value);
            }
        };

        // Kick off WASM loading. Deliberately NOT awaited before returning
        // from the constructor - process() runs (and gracefully bypasses,
        // since rnnoiseReady starts false) while this is in flight, the same
        // "connect the graph immediately, enable NS once actually ready"
        // approach voiceProcessor.ts's init() already uses for the Worker.
        this._initRnnoise();
    }

    async _initRnnoise() {
        try {
            const rnnoise = await Rnnoise.load();
            this.denoiseState = rnnoise.createDenoiseState();
            this.rnnoiseReady = true;
        } catch (err) {
            // Mirrors the Worker-fed worklet's {type:'error'} signal on WASM
            // load failure - voiceProcessor.ts / useParticipantAudio.ts listen
            // for this to fall back to the Worker-based pipeline instead.
            this.port.postMessage({
                type: 'rnnoiseLoadFailed',
                error: String((err && err.message) || err),
            });
        }
    }

    _flush() {
        // Process at most MAX_INLINE_FRAMES_PER_QUANTUM 480-sample frames
        // synchronously, right here on the realtime audio thread. See
        // nsKernel.js's MAX_INLINE_FRAMES_PER_QUANTUM comment for why this is
        // bounded rather than draining an unbounded backlog in one call.
        let framesThisQuantum = 0;
        while ((this.inW - this.inR) >= this.FRAME && framesThisQuantum < MAX_INLINE_FRAMES_PER_QUANTUM) {
            const frame = this.frame;
            for (let i = 0; i < this.FRAME; i++) {
                frame[i] = this.inRing[this.inR % this.inSize];
                this.inR++;
            }
            if (this.rnnoiseReady && this.denoiseState) {
                // RNNoise expects int16-range values (same scaling the old
                // rnnoise.worker.ts used) - AudioWorklet I/O is float [-1, 1].
                for (let i = 0; i < frame.length; i++) frame[i] *= 32768;
                this.denoiseState.processFrame(frame);
                for (let i = 0; i < frame.length; i++) frame[i] /= 32768;
            }
            // If RNNoise isn't ready yet, this pushes the raw frame - harmless:
            // process() passes bypassed:true to outputRing while !rnnoiseReady,
            // so NsOutputRing's raw-passthrough branch never actually reads
            // from the ring in that state; these writes are simply overwritten
            // once the ring wraps.
            for (let i = 0; i < this.FRAME; i++) this.outputRing.push(frame[i]);
            framesThisQuantum++;
        }
    }

    _reportStats(underrun, bypassTripped, bypassRecovered) {
        if (underrun) this.underrunsSinceReport++;
        this.statsQuantaSinceReport++;

        if (bypassTripped) {
            this.port.postMessage({ type: 'nsAutoBypass', active: true });
        }
        if (bypassRecovered) {
            this.port.postMessage({ type: 'nsAutoBypass', active: false });
        }

        if (this.statsQuantaSinceReport >= STATS_INTERVAL_QUANTA) {
            this.port.postMessage({
                type: 'stats',
                underruns: this.underrunsSinceReport,
                state: this.outputRing.state,
                bufferedSamples: this.outputRing.available(),
            });
            this.statsQuantaSinceReport = 0;
            this.underrunsSinceReport = 0;
        }
    }

    process(inputs, outputs) {
        const inp = inputs[0]?.[0];
        const out = outputs[0]?.[0];
        if (!out) return true;

        if (inp) {
            for (let i = 0; i < inp.length; i++) {
                this.inRing[this.inW % this.inSize] = inp[i];
                this.inW++;
            }
            this._flush();
        }

        this.ringOpts.bypassed = !this.enabled || !this.rnnoiseReady;
        const result = this.outputRing.process(inp, out, this.ringOpts);
        this._reportStats(result.underrun, result.bypassTripped, result.bypassRecovered);

        return true;
    }
}
registerProcessor('rnnoise-inline-worklet', RNNoiseInlineWorklet);
`;
