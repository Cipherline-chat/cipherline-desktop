/**
 * Light (Speex) frame size: steady-noise removal, residual fluctuation (musical noise / "bubbling"), what it does to
 * real speech, a quiet talker and a whisper, its delay, and whether the worklet's FIFO ever runs dry (audit 2026-11-17).
 * The frame is patched into the REAL worklet source. Skipped unless AUDIO_AUDIT=1; AUDIO_AUDIT_SPEECH = clean speech,
 * f32le 48 kHz; AUDIO_AUDIT_FRAMES = comma list (default 128,256,384,512,768).
 */
import { it } from 'vitest';
import { readFileSync } from 'fs';
import { SPEEX_LIGHT_WORKLET_SOURCE } from '../../utils/speexLightWorkletSource';
import { speexWasmBytes } from '../../utils/speexWasm';
import { loadModuleWorklet, waitFor, background, scaleTo, labelSpeech, rmsOf, linToDb, spectralFluctuationDb, measureLag, whisperize, SR, Q, LF } from './chainHarness';

async function runSpeex(F: number, x: Float32Array): Promise<{ y: Float32Array; underruns: number }> {
    const src = SPEEX_LIGHT_WORKLET_SOURCE.replace(/const SPEEX_FRAME = \d+;/, `const SPEEX_FRAME = ${F};`);
    const p = await loadModuleWorklet(src, 'speex-light-worklet');
    p.port.onmessage!({ data: { type: 'init', wasm: speexWasmBytes() } });
    await waitFor(() => !!p.ready);
    p.port.onmessage!({ data: { type: 'toggle', enabled: true } });
    const y = new Float32Array(x.length), o = new Float32Array(Q);
    for (let b = 0; (b + 1) * Q <= x.length; b++) { p.process([[x.subarray(b * Q, (b + 1) * Q)]], [[o]]); y.set(o, b * Q); }
    return { y, underruns: p.underruns as number };
}

it.skipIf(!process.env.AUDIO_AUDIT)('Speex frame size sweep', async () => {
    const b = readFileSync(process.env.AUDIO_AUDIT_SPEECH!);
    const sp = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const frames = (process.env.AUDIO_AUDIT_FRAMES ?? '128,256,384,512,768').split(',').map(Number);
    const clean30 = scaleTo(sp, -30), lab = labelSpeech(clean30);
    // longest pause
    let best = 0, bs = 0, run = 0, rs = 0;
    for (let f = 0; f < lab.frame.length; f++) { if (lab.distToSpeech[f] >= 0.15 * SR) { if (!run) rs = f; run++; if (run > best) { best = run; bs = rs; } } else run = 0; }
    const ps = bs * LF, pe = (bs + best) * LF;
    // level change over speech frames (nucleus + softer), output aligned by the measured lag
    const keep = (x: Float32Array, y: Float32Array, lag: number, cls: number) => {
        let si = 0, so = 0;
        for (let f = 0; f < lab.frame.length; f++) if (lab.frame[f] >= cls) { const s = f * LF; si += rmsOf(x, s, s + LF) ** 2; so += rmsOf(y, s + lag, s + lag + LF) ** 2; }
        return 10 * Math.log10(so / si);
    };
    const whisper = whisperize(clean30);
    for (const F of frames) {
        const row: Record<string, number> = { F };
        for (const kind of ['fan', 'hiss'] as const) {
            const bgk = background(kind, clean30.length, -52, 11);
            const x = clean30.map((v, i) => v + bgk[i]);
            const { y, underruns } = await runSpeex(F, x);
            const lag = measureLag(x, y, SR * 20, SR * 2, 4000);
            row.lagSamples = lag; row.latencyMs = +(lag / 48).toFixed(1); row.underruns = (row.underruns ?? 0) + underruns;
            row[`${kind}DropDb`] = +(linToDb(rmsOf(y, ps + lag, pe + lag)) - linToDb(rmsOf(x, ps, pe))).toFixed(1);
            row[`${kind}FluctDb`] = +spectralFluctuationDb(y, ps + lag, pe + lag).toFixed(2);
            row[`speechOver${kind}Db`] = +keep(x, y, lag, 2).toFixed(2);
        }
        // quiet talker (-45) and whispers (-45 / -38 active level) in a quiet room (-75 hiss): never pre-scaled before Speex
        for (const [name, sig, lvl] of [['quietTalker45', clean30, -45], ['whisper45', whisper, -45], ['whisper38', whisper, -38]] as const) {
            const k = Math.pow(10, (lvl - -30) / 20);
            const bg = background('hiss', clean30.length, -75, 13);
            const x = new Float32Array(clean30.length);
            for (let i = 0; i < x.length; i++) x[i] = sig[i] * k + bg[i];
            const { y, underruns } = await runSpeex(F, x);
            row.underruns += underruns;
            row[`${name}Db`] = +keep(x, y, row.lagSamples, 1).toFixed(2);
        }
        console.log(JSON.stringify(row));
    }
});
