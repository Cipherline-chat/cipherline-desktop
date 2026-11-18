/**
 * Full send-chain audit sweep (2026-11-17). Skipped unless AUDIO_AUDIT=1.
 *
 *   AUDIO_AUDIT=1 AUDIO_AUDIT_SPEECH=/path/speech48k.f32 AUDIO_AUDIT_OUT=/dir AUDIO_AUDIT_SET=matrix|agc|hot|controls \
 *     npx vitest run src/audio/audit/audioAudit.sweep.test.ts --testTimeout=3600000
 *
 * AUDIO_AUDIT_SPEECH = mono float32 little-endian 48 kHz clean speech (none is in the repo; any real recording works).
 * Without it a synthetic speech-like signal from voiceGateHarness.synth is used.
 * Results: <OUT>/<set>.json (one row per run).
 */
import { describe, it } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { GATE_WORKLET_SOURCE } from '../../utils/voiceProcessor';
import { SPEEX_LIGHT_WORKLET_SOURCE } from '../../utils/speexLightWorkletSource';
import { RNNOISE_INLINE_WORKLET_SOURCE } from '../../utils/rnnoiseInWorkletSource';
import { speexWasmBytes } from '../../utils/speexWasm';
import { synth } from '../../utils/voiceGateHarness';
import { GateCutWatcher, gateCutSecondFrom, GC_BLOCK_SEC } from '../../utils/gateCut';
import { GC_MIN_CALL_SEC } from '../../utils/gateCutPrompt';
import {
    SR, buildChain, background, breath, keyClicks, scaleTo, labelSpeech, score, measureLag, writeWavF32,
    spectralFluctuationDb, rmsOf, linToDb, type ChainConfig, type NoiseKind, type NsMode, type GateMode, type SpeechLabels,
} from './chainHarness';

const ENABLED = !!process.env.AUDIO_AUDIT;
const OUT = process.env.AUDIO_AUDIT_OUT ?? '/tmp/audio-audit';
const SET = process.env.AUDIO_AUDIT_SET ?? 'matrix';
// AUDIO_AUDIT_SPEEX_FRAME patches Light's frame size into the real worklet (before/after comparisons).
const LIGHT_SRC = process.env.AUDIO_AUDIT_SPEEX_FRAME
    ? SPEEX_LIGHT_WORKLET_SOURCE.replace(/const SPEEX_FRAME = \d+;/, `const SPEEX_FRAME = ${process.env.AUDIO_AUDIT_SPEEX_FRAME};`)
    : SPEEX_LIGHT_WORKLET_SOURCE;
const NS = { light: LIGHT_SRC, strong: RNNOISE_INLINE_WORKLET_SOURCE, speexWasm: speexWasmBytes };
// AUDIO_AUDIT_NS restricts the NS modes of the matrix / rescue / hot sets (comma list of off,light,strong).
const NS_MODES: NsMode[] = (process.env.AUDIO_AUDIT_NS ?? 'off,light,strong').split(',') as NsMode[];
const GATE_SRC = process.env.AUDIO_AUDIT_GATE_SRC ? readFileSync(process.env.AUDIO_AUDIT_GATE_SRC, 'utf8') : GATE_WORKLET_SOURCE;

function loadSpeech(): Float32Array {
    const p = process.env.AUDIO_AUDIT_SPEECH;
    if (p && existsSync(p)) {
        const b = readFileSync(p);
        return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    }
    // Synthetic fallback: the gate-data-tune speech model with no noise
    const s = synth({ speechDb: -30, duty: 0.35, floorDb: -140, seconds: 45, seed: 5, events: 'none', sigmaDb: 4.5, phraseSigmaDb: 5 });
    return s.x;
}

export interface Scenario {
    name: string;
    talkerDb: number;
    noise: NoiseKind;
    /** SNR of the steady noise against the active speech level (dB). */
    snrDb: number;
    events: boolean;
    /** Extra input gain applied AFTER mixing (over-range driver input), dB. */
    hotDb?: number;
}

/** Speech twice (steady state is scored on the second pass) + noise + breaths / key clicks in long pauses. */
function makeInput(speech: Float32Array, sc: Scenario): { x: Float32Array; clean: Float32Array; lab: SpeechLabels } {
    const two = new Float32Array(speech.length * 2);
    two.set(speech, 0); two.set(speech, speech.length);
    const clean = scaleTo(two, sc.talkerDb);
    const lab = labelSpeech(clean);
    const x = new Float32Array(clean.length);
    const bg = background(sc.noise, x.length, sc.talkerDb - sc.snrDb, 11);
    for (let i = 0; i < x.length; i++) x[i] = clean[i] + bg[i];
    if (sc.events) {
        // one event per long pause, alternating breath / keys, >= 400 ms from speech on both sides
        let alt = 0;
        const LFr = 240;
        let runStart = -1;
        for (let f = 0; f < lab.frame.length; f++) {
            const far = lab.distToSpeech[f] >= 0.4 * SR;
            if (far && runStart < 0) runStart = f;
            if ((!far || f === lab.frame.length - 1) && runStart >= 0) {
                const len = (f - runStart) * LFr;
                const ev = alt++ % 2 === 0 ? breath(0.35, sc.talkerDb - 22, 100 + alt) : keyClicks(8, sc.talkerDb - 16, 200 + alt);
                if (len > ev.length) {
                    const at = runStart * LFr + Math.floor((len - ev.length) / 2);
                    for (let i = 0; i < ev.length; i++) x[at + i] += ev[i];
                }
                runStart = -1;
            }
        }
    }
    if (sc.hotDb) {
        const k = Math.pow(10, sc.hotDb / 20);
        for (let i = 0; i < x.length; i++) x[i] *= k;
    }
    return { x, clean, lab };
}

const lagCache = new Map<NsMode, number>();
async function nsLag(ns: NsMode, speech: Float32Array): Promise<number> {
    if (lagCache.has(ns)) return lagCache.get(ns)!;
    const { x } = makeInput(speech, { name: 'lag', talkerDb: -30, noise: 'hiss', snrDb: 40, events: false });
    const c = await buildChain({ ns, gate: 'off', agc: false, gateSource: GATE_SRC }, NS);
    const tr = c.run(x);
    const lag = ns === 'off' ? 0 : measureLag(x, tr.nsOut, SR * 50, SR * 2);
    lagCache.set(ns, lag);
    return lag;
}

type RunCfg = Omit<ChainConfig, 'gateSource'> & { gateSource?: string; label?: string; nsSources?: typeof NS };
async function runOne(speech: Float32Array, sc: Scenario, cfg: RunCfg, wav?: string) {
    const { x, lab } = makeInput(speech, sc);
    const lag = await nsLag(cfg.ns, speech);
    const chain = await buildChain({ ...cfg, gateSource: cfg.gateSource ?? GATE_SRC }, cfg.nsSources ?? NS);
    const tr = chain.run(x);
    const half = speech.length;
    const m = score(x, lab, tr, lag, half);
    // first-pass metrics (join behaviour) on the first 12 s
    const keep = lab.onsets.map((o, i) => (o < 12 * SR ? i : -1)).filter(i => i >= 0);
    const join = score(x.subarray(0, half), { ...lab, onsets: keep.map(i => lab.onsets[i]), audibleAt: keep.map(i => lab.audibleAt[i]), ends: lab.ends.filter(e => e < 12 * SR) },
        { ...tr, out: tr.out.subarray(0, half), nsOut: tr.nsOut.subarray(0, half) }, lag, 0);
    // residual-noise fluctuation in the longest pause of the second pass (NS output, before the gate)
    let best = 0, bs = 0, run = 0, rs = 0;
    for (let f = Math.ceil(half / 240); f < lab.frame.length; f++) {
        if (lab.distToSpeech[f] >= 0.15 * SR) { if (!run) rs = f; run++; if (run > best) { best = run; bs = rs; } } else run = 0;
    }
    const ps = bs * 240 + lag, pe = (bs + best) * 240 + lag;
    const nsFluct = spectralFluctuationDb(tr.nsOut, ps, pe);
    const inFluct = spectralFluctuationDb(x, bs * 240, (bs + best) * 240);
    const nsNoiseDropDb = linToDb(rmsOf(tr.nsOut, ps, pe)) - linToDb(rmsOf(x, bs * 240, (bs + best) * 240));
    if (wav) writeWavF32(wav, tr.out.subarray(half, half + Math.min(half, 30 * SR)));
    return { label: cfg.label ?? '', scenario: sc.name, talkerDb: sc.talkerDb, noise: sc.noise, snrDb: sc.snrDb, hotDb: sc.hotDb ?? 0,
        ns: cfg.ns, gate: cfg.gate, thr: cfg.gateThresholdDb ?? -45, agc: cfg.agc, slider: cfg.slider ?? 100,
        lag, ...m, joinGateOnsetMs: join.gateOnsetMs, joinOnsetsClipped: join.onsetsClipped, joinNucleusCutPct: join.nucleusCutPct,
        joinPauseNoiseDb: join.pauseNoiseDb, nsFluctDb: nsFluct, inFluctDb: inFluct, nsNoiseDropDb, pauseSec: (best * 240) / SR };
}

const fmt = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v]));

function scenarios(): Scenario[] {
    const s: Scenario[] = [];
    for (const t of [-45, -30, -16]) {
        s.push({ name: `t${t}_quietroom`, talkerDb: t, noise: 'hiss', snrDb: t + 78, events: true });
        s.push({ name: `t${t}_hiss20`, talkerDb: t, noise: 'hiss', snrDb: 20, events: true });
        s.push({ name: `t${t}_fan20`, talkerDb: t, noise: 'fan', snrDb: 20, events: true });
        s.push({ name: `t${t}_fan10`, talkerDb: t, noise: 'fan', snrDb: 10, events: true });
        s.push({ name: `t${t}_hum20`, talkerDb: t, noise: 'hum', snrDb: 20, events: true });
    }
    return s;
}

describe.skipIf(!ENABLED)('audio audit sweep', () => {
    it(`set ${SET}`, async () => {
        mkdirSync(OUT, { recursive: true });
        const speech = loadSpeech();
        const rows: Record<string, unknown>[] = [];
        const push = (r: Record<string, unknown>) => { rows.push(fmt(r)); console.log(JSON.stringify(fmt(r))); };
        const only = process.env.AUDIO_AUDIT_ONLY;
        if (SET === 'matrix') {
            const gates: Array<[GateMode, number]> = [['off', -45], ['manual', -45], ['manual', -60]];
            for (const sc of scenarios()) {
                if (only && !sc.name.includes(only)) continue;
                for (const ns of NS_MODES) {
                    for (const [gate, thr] of gates) push(await runOne(speech, sc, { ns, gate, gateThresholdDb: thr, agc: true }));
                }
            }
        }
        if (SET === 'agc') {
            for (const sc of scenarios().filter(s => s.noise !== 'fan' || s.snrDb === 20)) {
                for (const ns of ['off', 'light', 'strong'] as NsMode[]) {
                    for (const agc of [true, false]) for (const slider of [100, 200]) {
                        push(await runOne(speech, sc, { ns, gate: 'manual', gateThresholdDb: -45, agc, slider }));
                    }
                }
            }
        }
        if (SET === 'gatecut') {
            // The "voice gate may be cutting you off" detector on the real chain: per run, the meter's totals and what the
            // decision (utils/gateCut.ts) says, second by second as in a call (from GC_MIN_CALL_SEC on).
            const thrs = (process.env.AUDIO_AUDIT_GATE_THRS ?? '-45,-60').split(',').map(Number);
            const rooms = scenarios();
            // nobody talking: the same rooms with the speech removed (breaths and key clicks stay)
            const silent = (sc: Scenario): Scenario => ({ ...sc, name: `${sc.name}-NOTALK` });
            for (const sc of [...rooms, ...rooms.filter(r => r.talkerDb === -30).map(silent)]) {
                if (only && !sc.name.includes(only)) continue;
                for (const ns of NS_MODES) {
                    for (const thr of thrs) {
                        const talk = !sc.name.endsWith('-NOTALK');
                        let input = makeInput(speech, sc).x;
                        if (!talk) {
                            // the same room, breaths and key clicks as for the -30 talker, minus the talker
                            const ref = makeInput(speech, { ...sc, events: false, noise: 'none' }).x;
                            for (let i = 0; i < input.length; i++) input[i] -= ref[i];
                        }
                        const c = await buildChain({ ns, gate: 'manual', gateThresholdDb: thr, agc: true, gateSource: GATE_SRC }, NS);
                        c.run(input);
                        const allSecs = c.gatePosted.filter(m => m.type === 'gateStats').map(m => gateCutSecondFrom(m as never)).filter(Boolean) as NonNullable<ReturnType<typeof gateCutSecondFrom>>[];
                        const w = new GateCutWatcher();
                        let first = -1, hits = 0, judged = 0;
                        let last: ReturnType<GateCutWatcher['decide']> = null;
                        allSecs.forEach((s1, i) => {
                            if (s1.voiced > 0) w.push(s1); // as voiceProcessor publishes them
                            if (i + 1 < GC_MIN_CALL_SEC) return;
                            const d = w.decide(thr);
                            judged++;
                            if (d) { hits++; last = d; if (first < 0) first = i + 1; }
                        });
                        const tot = allSecs.reduce((a, b) => ({ voiced: a.voiced + b.voiced, gated: a.gated + b.gated, vms: a.vms + b.vms, starts: a.starts + b.starts, clipped: a.clipped + b.clipped, closes: a.closes + b.closes }), { voiced: 0, gated: 0, vms: 0, starts: 0, clipped: 0, closes: 0 });
                        const L = last as ReturnType<GateCutWatcher['decide']>;
                        push({ scenario: sc.name, talkerDb: talk ? sc.talkerDb : null, noise: sc.noise, ns, thr,
                            voicedSec: tot.voiced * GC_BLOCK_SEC, gatedPct: tot.voiced ? (100 * tot.gated) / tot.voiced : 0,
                            starts: tot.starts, clippedPct: tot.starts ? (100 * tot.clipped) / tot.starts : 0,
                            closesPerMin: tot.voiced ? tot.closes / (tot.voiced * GC_BLOCK_SEC / 60) : 0,
                            voiceDb: tot.voiced ? 10 * Math.log10(tot.vms / tot.voiced) : null,
                            firstTriggerSec: first, triggeredPct: judged ? (100 * hits) / judged : 0, suggestDb: L ? L.suggestDb : null });
                    }
                }
            }
        }
        if (SET === 'controls') {
            // Each metric shown to fire on a deliberately broken configuration, next to the shipped one.
            const t30: Scenario = { name: 't-30_fan20', talkerDb: -30, noise: 'fan', snrDb: 20, events: true };
            push(await runOne(speech, t30, { label: 'shipped (fixed -45 gate)', ns: 'off', gate: 'manual', gateThresholdDb: -45, agc: true }));
            push(await runOne(speech, t30, { label: 'CONTROL gate -20 (chops speech)', ns: 'off', gate: 'manual', gateThresholdDb: -20, agc: true }));
            push(await runOne(speech, t30, { label: 'CONTROL gate at the noise, no hold, instant release (chatter)', ns: 'off', gate: 'manual', gateThresholdDb: -51, agc: true, gateOverrides: { holdTotal: 1, releaseRate: 1, attackRate: 1 } }));
            push(await runOne(speech, t30, { label: 'CONTROL AGC guard 6 dB under target, 5 ms release (pumping)', ns: 'off', gate: 'manual', gateThresholdDb: -45, agc: true, agcOpts: { fastMarginDb: -6, fastReleaseSec: 0.005 } }));
            const hot: Scenario = { name: 'hot+12', talkerDb: -16, noise: 'hiss', snrDb: 40, events: false, hotDb: 12 };
            push(await runOne(speech, hot, { label: 'shipped Light, +12 dB over-range', ns: 'light', gate: 'manual', gateThresholdDb: -45, agc: true }));
            const noLim = { ...NS, light: NS.light.replace(/const SPEEX_IN_CEIL = [\d.]+;/, 'const SPEEX_IN_CEIL = 1e9;') };
            if (noLim.light === NS.light) throw new Error('limiter patch did not apply');
            push(await runOne(speech, hot, { label: 'CONTROL Light without its input limiter (int16 wrap)', ns: 'light', gate: 'manual', gateThresholdDb: -45, agc: true, nsSources: noLim }));
            push(await runOne(speech, hot, { label: 'shipped Off, +12 dB over-range', ns: 'off', gate: 'manual', gateThresholdDb: -45, agc: true }));
            push(await runOne(speech, hot, { label: 'shipped Strong, +12 dB over-range', ns: 'strong', gate: 'manual', gateThresholdDb: -45, agc: true }));
        }
        if (SET === 'hot') {
            for (const hot of [6, 12, 18]) {
                const sc: Scenario = { name: `hot+${hot}`, talkerDb: -16, noise: 'hiss', snrDb: 40, events: false, hotDb: hot };
                for (const ns of NS_MODES) push(await runOne(speech, sc, { ns, gate: 'manual', gateThresholdDb: -45, agc: true }));
            }
        }
        const fr = process.env.AUDIO_AUDIT_SPEEX_FRAME ? `-F${process.env.AUDIO_AUDIT_SPEEX_FRAME}` : '';
        writeFileSync(join(OUT, `${SET}${only ? '-' + only : ''}${fr}.json`), JSON.stringify(rows, null, 1));
    });
});
