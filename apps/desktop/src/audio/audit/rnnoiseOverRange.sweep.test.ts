/**
 * Does Strong (RNNoise) distort over-range (> 0 dBFS) input the way Light's int16 glue used to? Compares its
 * signal-to-distortion on over-range frames with loud in-range frames (audit 2026-11-17: no, ~14 dB either way,
 * which is RNNoise's ordinary processing). Skipped unless AUDIO_AUDIT=1.
 */
import { it } from 'vitest';
import { readFileSync } from 'fs';
import { RNNOISE_INLINE_WORKLET_SOURCE } from '../../utils/rnnoiseInWorkletSource';
import { loadModuleWorklet, waitFor, scaleTo, background, SR, Q } from './chainHarness';

it.skipIf(!process.env.AUDIO_AUDIT)('RNNoise SDR on loud frames vs over-range frames', async () => {
    const b = readFileSync(process.env.AUDIO_AUDIT_SPEECH!);
    const sp = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    for (const hot of [0, 6, 12, 18]) {
        const clean = scaleTo(sp, -16 + hot);
        const bg = background('hiss', clean.length, -56 + hot, 11);
        const x = clean.map((v, i) => v + bg[i]);
        const p = await loadModuleWorklet(RNNOISE_INLINE_WORKLET_SOURCE, 'rnnoise-inline-worklet');
        await waitFor(() => !!p.rnnoiseReady);
        p.port.onmessage!({ data: { type: 'compGain', value: 1 } });
        p.port.onmessage!({ data: { type: 'toggle', enabled: true } });
        const y = new Float32Array(x.length), o = new Float32Array(Q);
        for (let k = 0; (k + 1) * Q <= x.length; k++) { p.process([[x.subarray(k * Q, (k + 1) * Q)]], [[o]]); y.set(o, k * Q); }
        const lag = 1856;
        const sdr = (lo: number, hi: number) => {
            const v: number[] = [];
            for (let s0 = SR; s0 + 480 < x.length - lag; s0 += 480) {
                let pk = 0; for (let i = s0; i < s0 + 480; i++) pk = Math.max(pk, Math.abs(x[i]));
                if (pk <= lo || pk > hi) continue;
                let xy = 0, xx = 0, yy = 0;
                for (let i = s0; i < s0 + 480; i++) { const a = x[i], c = y[i + lag]; xy += a * c; xx += a * a; yy += c * c; }
                const kk = xy / xx; v.push(10 * Math.log10((kk * kk * xx) / Math.max(yy - 2 * kk * xy + kk * kk * xx, 1e-20)));
            }
            v.sort((a, c) => a - c);
            return { n: v.length, med: +(v[Math.floor(v.length / 2)] ?? NaN).toFixed(1) };
        };
        let ymax = 0; for (const v of y) ymax = Math.max(ymax, Math.abs(v));
        const scale = Math.pow(10, hot / 20);
        console.log(JSON.stringify({ hot, outPeak: +ymax.toFixed(2), loudNotOver: sdr(0.25 * scale, Math.min(1, 1 * scale)), over: sdr(1, 1e9) }));
    }
});
