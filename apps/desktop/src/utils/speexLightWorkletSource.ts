/**
 * "Light" noise suppression: SpeexDSP's preprocessor denoiser, run inside an
 * AudioWorkletProcessor on the real-time audio thread.
 *
 * WHY it exists: RNNoise ("Strong") is a speech-trained network - it removes
 * whistling and whispering along with the noise, and it buffers ~40 ms. Speex
 * estimates the steady background floor and takes it down, whatever the
 * sound is, and it is small and quick. Measured on synthetic signals over a
 * -55 dBFS floor: whistles and whisper-like sounds pass at -0.1..-0.9 dB (RNNoise:
 * -10 dB and ~-50..-65 dB), the steady floor drops ~7 dB at this frame size.
 * Pair it with the voice gate to silence the gaps.
 *
 * LATENCY: Speex delays its output by exactly one frame. At 128 samples (one
 * render quantum) the frame is processed inside the same process() call that
 * received it, so the whole cost is that one frame: 128 / 48000 = 2.67 ms.
 * Larger frames cut more noise but also have to be accumulated first
 * (cost = 2 * FRAME - 128), so this is deliberately the smallest frame. See
 * nsLatency.ts, which turns these constants into the numbers the UI shows and
 * is checked against the real processors by noiseSuppressionWorklets.test.ts.
 *
 * No ring buffer / priming / auto-bypass machinery (unlike rnnoiseInWorkletSource):
 * a 128-sample Speex frame costs well under the render budget, so there is no
 * backlog to jitter-buffer. Enabling and disabling crossfade over one quantum,
 * and while disabled the processor does NO work (a plain copy).
 *
 * The WASM is not embedded: the main thread sends the bytes once, the first time
 * Light is switched on ({type:'init', wasm}), so Strong-only users never
 * instantiate it. Built from the vendored dist/index.js exactly like the
 * RNNoise worklet (text concatenation into a Blob-URL module).
 *
 * KEEP THE TEMPLATE BELOW PURE ASCII (asciiJsSource.test.ts) - the assembled
 * source is held in memory one byte per character only if it is.
 */
import speexGlueRaw from '@sapphi-red/speex-preprocess-wasm?raw';
import { extractSpeexVendorGlue } from './speexVendorExtract';
import { SPEEX_FRAME, SPEEX_NOISE_SUPPRESS_DB } from './nsLatency';

// Tuning lives in nsLatency.ts (boot-safe, shared with the Settings UI).

const { body: speexGlueBody, preprocessorName, loadModuleName } = extractSpeexVendorGlue(speexGlueRaw);

export const SPEEX_LIGHT_WORKLET_SOURCE = `
// -- Vendored SpeexDSP preprocess WASM glue (@sapphi-red/speex-preprocess-wasm, pinned in package.json) --
const __speexVendor = (function() {
    // Environment shim (see rnnoiseInWorkletSource.ts): an AudioWorkletGlobalScope has
    // neither window nor WorkerGlobalScope. Harmless here - the glue only uses them for
    // environment detection and we hand it the wasm bytes directly (no fetch).
    const WorkerGlobalScope = function EnvShimForEmscriptenDetection() {};
    void WorkerGlobalScope;
${speexGlueBody}
    return { SpeexPreprocessor: ${preprocessorName}, loadSpeexModule: ${loadModuleName} };
})();
const SpeexPreprocessor = __speexVendor.SpeexPreprocessor;
const loadSpeexModule = __speexVendor.loadSpeexModule;

const SPEEX_FRAME = ${SPEEX_FRAME};
const SPEEX_NOISE_SUPPRESS_DB = ${SPEEX_NOISE_SUPPRESS_DB};
// Enable/disable crossfade length in samples (one render quantum).
const MIX_SAMPLES = 128;

class SpeexLightWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.F = SPEEX_FRAME;
        this.enabled = false;
        this.ready = false;
        this.initStarted = false;
        this.sp = null;
        // Input accumulator (a no-op for F == 128: it fills and flushes every call).
        this.acc = new Float32Array(this.F);
        this.accN = 0;
        // FIFO of processed samples, power-of-two-free modulo indexing.
        this.qSize = this.F * 4;
        this.q = new Float32Array(this.qSize);
        this.qr = 0;
        this.qw = 0;
        // 0 = raw, 1 = processed.
        this.mix = 0;

        this.port.onmessage = ({ data }) => {
            if (data.type === 'toggle') {
                this._setEnabled(!!data.enabled);
            } else if (data.type === 'init') {
                this._init(data.wasm);
            }
        };
    }

    _resetQueues() {
        this.accN = 0;
        this.qr = 0;
        this.qw = 0;
    }

    _setEnabled(on) {
        if (on && !this.enabled) this._resetQueues();
        this.enabled = on;
    }

    async _init(wasmBytes) {
        if (this.initStarted || !wasmBytes) return;
        this.initStarted = true;
        try {
            // Reject corrupt bytes up front: handed to the Emscripten glue they trigger its
            // abort(), which also rejects an internal promise nobody can catch.
            if (typeof WebAssembly === 'undefined' || !WebAssembly.validate(wasmBytes)) {
                throw new Error('speex.wasm failed validation');
            }
            // print/printErr: Speex logs a harmless "VAD replaced by a hack" warning at
            // state creation; keep it out of the console.
            // locateFile: without it the glue's findWasmBinary() runs
            // new URL('speex.wasm', import.meta.url), and an AudioWorkletGlobalScope
            // has no URL constructor -> "URL is not defined" -> Light never started
            // in the real app (staging.174 report). The bytes are passed directly,
            // so the name is never fetched.
            const mod = await loadSpeexModule({ wasmBinary: wasmBytes, locateFile: (p) => p, print: () => {}, printErr: () => {} });
            const sp = new SpeexPreprocessor(mod, this.F, sampleRate);
            sp.denoise = true;
            sp.agc = false;
            sp.vad = false;
            sp.noiseSuppress = SPEEX_NOISE_SUPPRESS_DB;
            this.sp = sp;
            this.ready = true;
            this.port.postMessage({ type: 'ready' });
        } catch (err) {
            this.initStarted = false;
            this.port.postMessage({ type: 'loadFailed', error: String((err && err.message) || err) });
        }
    }

    process(inputs, outputs) {
        const inp = inputs[0] && inputs[0][0];
        const out = outputs[0] && outputs[0][0];
        if (!out) return true;
        if (!inp) {
            out.fill(0);
            return true;
        }

        const target = (this.enabled && this.ready) ? 1 : 0;

        // Fully off: a plain copy, no Speex work, nothing buffered.
        if (target === 0 && this.mix === 0) {
            out.set(inp);
            if (this.accN !== 0 || this.qw !== this.qr) this._resetQueues();
            return true;
        }

        const n = out.length;
        const sp = this.sp;
        const F = this.F;
        const qs = this.qSize;

        // 1. Feed input; every full frame is denoised in place and queued.
        for (let i = 0; i < n; i++) {
            this.acc[this.accN++] = inp[i];
            if (this.accN === F) {
                sp.process(this.acc);
                for (let j = 0; j < F; j++) {
                    this.q[this.qw % qs] = this.acc[j];
                    this.qw++;
                }
                this.accN = 0;
            }
        }

        // 2. Emit, crossfading toward the target so toggling never clicks.
        const step = 1 / MIX_SAMPLES;
        let mix = this.mix;
        for (let i = 0; i < n; i++) {
            if (mix < target) mix = Math.min(target, mix + step);
            else if (mix > target) mix = Math.max(target, mix - step);
            // Underrun (only possible while a frame larger than a quantum is still
            // filling at start-up): fall back to the live input for that sample.
            let proc = inp[i];
            if (this.qw - this.qr > 0) {
                proc = this.q[this.qr % qs];
                this.qr++;
            }
            out[i] = inp[i] * (1 - mix) + proc * mix;
        }
        this.mix = mix;
        return true;
    }
}
registerProcessor('speex-light-worklet', SpeexLightWorklet);
`;
