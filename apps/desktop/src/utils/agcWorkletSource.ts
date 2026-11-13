import agcKernelSrc from '../audio/agcKernel.js?raw';

/**
 * AGC AudioWorklet processor source — the real "Auto gain control" stage.
 * Inlined as a Blob-URL module, same pattern as the gate and RNNoise
 * worklets (see voiceProcessor.ts and rnnoiseWorkletSource.ts).
 *
 * The actual gain-estimation/slew/limiter math lives in agcKernel.js
 * (AgcProcessor) — imported here as raw text so the worklet and the Vitest
 * suite (agcKernel.test.ts) run the exact same code, the same pattern
 * rnnoiseWorkletSource.ts uses for nsKernel.js.
 */
export const AGC_WORKLET_SOURCE = `
${agcKernelSrc}

class AgcWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.agc = new AgcProcessor({ sampleRate });
        this.statsQuantaSinceReport = 0;
        this.STATS_INTERVAL_QUANTA = Math.round(1000 / (128 / sampleRate * 1000)); // ~1/s
        // (The mic-volume stage now sits BEFORE this one, 2026-11-11: the AGC sees and levels
        // the boosted signal and its limiter ceiling stays at -1 dBFS ON THE WIRE.)
        this.resetWindow();

        this.port.onmessage = ({ data }) => {
            if (data.type === 'enabled') {
                this.agc.setEnabled(!!data.value);
            } else if (data.type === 'micGainDb') {
                // The mic-volume slider (in front of this stage): moves the target, never the ceiling.
                this.agc.setMicGainDb(data.value);
            } else if (data.type === 'targetDb') {
                this.agc.targetRms = dbToLinear(data.value);
            }
        };
    }

    resetWindow() {
        this.wBlocks = 0;      // quanta in this report window
        this.wVoiced = 0;      // ... of which the AGC heard voiced speech
        this.wInMs = 0;        // sum of input mean-square over voiced quanta
        this.wOutMs = 0;       // sum of output mean-square over voiced quanta
        this.wPeak = 0;        // loudest |output sample| (before the mic-volume stage)
        this.wHeld = 0;        // voiced quanta the compressor or limiter held down by >= 1 dB
        this.wClip = 0;        // output samples that the mic-volume stage pushes to full scale
    }

    process(inputs, outputs) {
        const inp = inputs[0]?.[0];
        const out = outputs[0]?.[0];
        if (!out) return true;

        const result = this.agc.process(inp ?? null, out);

        let inSq = 0, outSq = 0, peak = 0, clip = 0;
        for (let i = 0; i < out.length; i++) {
            const o = out[i] < 0 ? -out[i] : out[i];
            outSq += o * o;
            if (o > peak) peak = o;
            if (o >= 0.999) clip++;
            if (inp) inSq += inp[i] * inp[i];
        }
        this.wBlocks++;
        if (peak > this.wPeak) this.wPeak = peak;
        this.wClip += clip;
        if (result.voiceActive) {
            this.wVoiced++;
            this.wInMs += inSq / out.length;
            this.wOutMs += outSq / out.length;
            if (this.agc.limiterGain < 0.891 || this.agc.compReductionDb < -1) this.wHeld++;
        }

        this.statsQuantaSinceReport++;
        if (this.statsQuantaSinceReport >= this.STATS_INTERVAL_QUANTA) {
            this.statsQuantaSinceReport = 0;
            this.port.postMessage({
                type: 'agcStats',
                gainDb: linearToDb(result.gain),
                voiceActive: result.voiceActive,
                // Mic speech level going into the AGC, dBFS. A number, never audio.
                speechDb: this.agc.levelEstimate > 0 ? linearToDb(this.agc.levelEstimate) : null,
                // The window since the last report (see resetWindow).
                blocks: this.wBlocks, voiced: this.wVoiced, inMs: this.wInMs, outMs: this.wOutMs,
                peak: this.wPeak, held: this.wHeld, clip: this.wClip,
            });
            this.resetWindow();
        }

        return true;
    }
}
registerProcessor('agc-worklet', AgcWorklet);
`;
