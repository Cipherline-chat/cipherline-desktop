/**
 * Offline export of the CURRENT mic chain for external scoring (2026-11-19). Skipped unless AUDIO_RIG=1.
 *
 *   AUDIO_RIG=1 AUDIO_RIG_IN=/dir/with/f32 AUDIO_RIG_OUT=/dir/out [AUDIO_RIG_SHARD=i/n] [AUDIO_RIG_CONFIGS=a,b] \
 *     npx vitest run src/audio/audit/rigExport.sweep.test.ts --testTimeout=7200000
 *
 * Reads every *.f32 (mono float32 LE 48 kHz) in AUDIO_RIG_IN, runs each through the real chain (chainHarness) for each
 * configuration, writes <OUT>/<config>/<name>.f32 (same length as the input, NOT delay-compensated) and <name>.json
 * (nominal NS lag in samples, AGC gain stats). AUDIO_RIG_SHARD=i/n processes files i, i+n, ... (parallel processes).
 * Recordings are private voice data: keep inputs and outputs outside the repo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GATE_WORKLET_SOURCE } from '../../utils/voiceProcessor';
import { SPEEX_LIGHT_WORKLET_SOURCE } from '../../utils/speexLightWorkletSource';
import { RNNOISE_INLINE_WORKLET_SOURCE } from '../../utils/rnnoiseInWorkletSource';
import { speexWasmBytes } from '../../utils/speexWasm';
import { CL_AUDIO_WORKLET_SOURCE } from '../../utils/clAudioWorkletSource';
import { clAudioWasmBytes } from '../../utils/clAudioWasm';
import { CL_AUDIO_LATENCY_SAMPLES } from '../../utils/clAudioLatency';
import { SR, Q, buildChain, measureLag, type ChainConfig } from './chainHarness';

const ENABLED = !!process.env.AUDIO_RIG;
const NS = { light: SPEEX_LIGHT_WORKLET_SOURCE, strong: RNNOISE_INLINE_WORKLET_SOURCE, speexWasm: speexWasmBytes, clAudio: { source: CL_AUDIO_WORKLET_SOURCE, wasm: clAudioWasmBytes() } };

// Defaults per hooks/useVoiceSettings.ts DEFAULT_VOICE_SETTINGS: noiseSuppressionMode 'light', voiceGate true at -45,
// volumeNormalization (AGC) true, micVolume 100, eqEnabled false (EQ is not modelled by the harness; flat = identity).
type Cfg = Omit<ChainConfig, 'gateSource'>;
export const RIG_CONFIGS: Record<string, Cfg> = {
    cur_default:       { ns: 'light',  gate: 'manual', gateThresholdDb: -45, agc: true,  slider: 100 },
    cur_strong:        { ns: 'strong', gate: 'manual', gateThresholdDb: -45, agc: true,  slider: 100 },
    cur_strong_nogate: { ns: 'strong', gate: 'off',                          agc: true,  slider: 100 },
    cur_light_nogate:  { ns: 'light',  gate: 'off',                          agc: true,  slider: 100 },
    cur_off_nogate:    { ns: 'off',    gate: 'off',                          agc: true,  slider: 100 },
    cur_strong_noagc:  { ns: 'strong', gate: 'off',                          agc: false, slider: 100 },
    // The new audio engine (cl-audio-worklet): one stage, no gate. Light = RNNoise + leveller + AGC2/limiter; Off = leveller only.
    v2_light:          { engine: 'v2', profile: 'light', ns: 'off', gate: 'off', agc: true, slider: 100 },
    v2_off:            { engine: 'v2', profile: 'off',   ns: 'off', gate: 'off', agc: true, slider: 100 },
};

describe.skipIf(!ENABLED)('rig export of the current mic chain', () => {
    it('runs every input through every config', async () => {
        const IN = process.env.AUDIO_RIG_IN!, OUT = process.env.AUDIO_RIG_OUT!;
        expect(IN && OUT).toBeTruthy();
        const [si, sn] = (process.env.AUDIO_RIG_SHARD ?? '0/1').split('/').map(Number);
        const only = process.env.AUDIO_RIG_CONFIGS?.split(',');
        const names = readdirSync(IN).filter(f => f.endsWith('.f32')).sort().filter((_, i) => i % sn === si);
        let audioSec = 0; const t0 = Date.now();
        for (const [cname, cfg] of Object.entries(RIG_CONFIGS)) {
            if (only && !only.includes(cname)) continue;
            mkdirSync(join(OUT, cname), { recursive: true });
            for (const f of names) {
                const name = f.replace(/\.f32$/, '');
                const b = readFileSync(join(IN, f));
                const x = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 4)));
                const padded = new Float32Array(Math.ceil(x.length / Q) * Q); // whole 128-sample render quanta, zero tail
                padded.set(x);
                const chain = await buildChain({ ...cfg, gateSource: GATE_WORKLET_SOURCE }, NS);
                const tr = chain.run(padded);
                const out = tr.out.subarray(0, x.length); // same length as input; not delay-compensated
                let bad = 0; for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) bad++;
                expect(bad).toBe(0);
                // nominal NS lag (samples), measured on the NS stage like audioAudit.sweep does; 0 when NS is off
                const a = Math.min(SR * 5, Math.max(0, x.length - SR * 3));
                const lag = cfg.engine === 'v2' ? CL_AUDIO_LATENCY_SAMPLES[cfg.profile === 'off' ? 'off' : 'light'] : cfg.ns === 'off' ? 0 : measureLag(padded, tr.nsOut, a, Math.min(SR * 2, x.length - a - 3001));
                const g = Array.from(tr.agcGainDb).filter(Number.isFinite).sort((p, q) => p - q);
                writeFileSync(join(OUT, cname, `${name}.f32`), Buffer.from(out.buffer, out.byteOffset, out.byteLength));
                writeFileSync(join(OUT, cname, `${name}.json`), JSON.stringify({
                    config: cname, name, samples: x.length, sampleRate: SR, ...cfg, nsLagSamples: lag,
                    agcFinalGainDb: tr.agcGainDb[tr.agcGainDb.length - 1],
                    agcGainDbMedian: g[Math.floor(g.length / 2)], agcGainDbP5: g[Math.floor(g.length * 0.05)], agcGainDbP95: g[Math.floor(g.length * 0.95)],
                    gateOpenPct: cfg.gate === 'off' || cfg.engine === 'v2' ? null : (100 * tr.gateOpen.reduce((s, v) => s + v, 0)) / tr.gateOpen.length,
                }, null, 1));
                audioSec += x.length / SR;
                console.log(`rig ${cname}/${name} ${(x.length / SR).toFixed(1)}s lag=${lag} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
            }
        }
        console.log(`rig shard ${si}/${sn}: ${audioSec.toFixed(0)} audio-s in ${((Date.now() - t0) / 1000).toFixed(0)} s = ${(audioSec / ((Date.now() - t0) / 1000)).toFixed(1)}x`);
    }, 7_200_000);
});
