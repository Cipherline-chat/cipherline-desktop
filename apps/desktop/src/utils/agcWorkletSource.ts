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

        this.port.onmessage = ({ data }) => {
            if (data.type === 'enabled') {
                this.agc.setEnabled(!!data.value);
            } else if (data.type === 'targetDb') {
                this.agc.targetRms = dbToLinear(data.value);
            }
        };
    }

    process(inputs, outputs) {
        const inp = inputs[0]?.[0];
        const out = outputs[0]?.[0];
        if (!out) return true;

        const result = this.agc.process(inp ?? null, out);

        this.statsQuantaSinceReport++;
        if (this.statsQuantaSinceReport >= this.STATS_INTERVAL_QUANTA) {
            this.statsQuantaSinceReport = 0;
            this.port.postMessage({
                type: 'agcStats',
                gainDb: linearToDb(result.gain),
                voiceActive: result.voiceActive,
            });
        }

        return true;
    }
}
registerProcessor('agc-worklet', AgcWorklet);
`;
