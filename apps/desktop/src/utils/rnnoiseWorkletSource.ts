import nsKernelSrc from '../audio/nsKernel.js?raw';

/**
 * RNNoise AudioWorklet processor source — inlined as a string so it can be
 * registered via a Blob URL in any AudioContext without an external file.
 *
 * Shared between:
 *   - voiceProcessor.ts (local mic chain)
 *   - useParticipantAudio.ts (remote participant NS)
 *
 * Ring-buffer design: the worklet accumulates 480-sample frames and forwards
 * them to a dedicated RNNoise Worker via a direct MessageChannel port.
 * No main-thread involvement in the audio path.
 *
 * The actual jitter-buffer / priming / crossfade / auto-bypass logic lives in
 * nsKernel.js (NsOutputRing) — imported here as raw text and concatenated
 * into this module string, so the AudioWorklet and the Vitest suite
 * (nsKernel.test.ts) run the exact same code. See nsKernel.js for why the
 * old "raw passthrough + discard everything buffered" underrun behavior
 * caused constant artifacting under CPU load.
 */
export const RNNOISE_WORKLET_SOURCE = `
${nsKernelSrc}

class RNNoiseWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.FRAME = RNNOISE_FRAME;
        // Input accumulation ring - unchanged from before: just chunks the
        // 128-sample render quanta into 480-sample frames for the Worker.
        this.inSize = this.FRAME * RING_FRAMES;
        this.inRing = new Float32Array(this.inSize);
        this.inW = 0; this.inR = 0;
        this.inflight = 0;
        this.enabled = false;
        this.workerPort = null;

        // Output side is entirely owned by NsOutputRing.
        this.outputRing = new NsOutputRing();

        // Throttled health stats up to the main thread (~1/s) so
        // voiceProcessor.ts / useParticipantAudio.ts can surface underrun
        // counts and auto-bypass state without polling every quantum.
        this.statsQuantaSinceReport = 0;
        this.underrunsSinceReport = 0;

        this.port.onmessage = ({ data, ports }) => {
            if (data.type === 'workerPort') {
                this.workerPort = data.port || (ports && ports[0]);
                if (this.workerPort) {
                    this.workerPort.onmessage = ({ data: d }) => {
                        if (d.type !== 'processed') return;
                        const f = new Float32Array(d.buffer);
                        for (let i = 0; i < f.length; i++) this.outputRing.push(f[i]);
                        this.inflight--;
                        this._flush();
                    };
                    this.workerPort.start();
                }
            } else if (data.type === 'toggle') {
                this.enabled = data.enabled;
                if (!data.enabled) {
                    this.inW = this.inR = 0;
                    this.inflight = 0;
                    this.outputRing.reset();
                } else {
                    // Re-enabling (e.g. user flips NS back on mid-call) should
                    // re-prime from scratch rather than trying to resume with
                    // whatever stale state the ring was left in.
                    this.outputRing.reset();
                }
            } else if (data.type === 'compGain') {
                this.outputRing.setCompGain(data.value);
            }
        };
    }

    _flush() {
        while ((this.inW - this.inR) >= this.FRAME && this.inflight < 3 && this.workerPort) {
            const f = new Float32Array(this.FRAME);
            for (let i = 0; i < this.FRAME; i++) {
                f[i] = this.inRing[this.inR % this.inSize];
                this.inR++;
            }
            this.workerPort.postMessage({ type: 'process', buffer: f.buffer }, [f.buffer]);
            this.inflight++;
        }
    }

    _reportStats(underrun, bypassTripped, bypassRecovered) {
        if (underrun) this.underrunsSinceReport++;
        this.statsQuantaSinceReport++;

        // Bypass transitions are reported immediately - that's a UI-visible
        // "noise suppression paused" state change, not a metric to batch.
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

        const bypassed = !this.enabled || !this.workerPort;
        const result = this.outputRing.process(inp, out, { bypassed });
        this._reportStats(result.underrun, result.bypassTripped, result.bypassRecovered);

        return true;
    }
}
registerProcessor('rnnoise-worklet', RNNoiseWorklet);
`;
