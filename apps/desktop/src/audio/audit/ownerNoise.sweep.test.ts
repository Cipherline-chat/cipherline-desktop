/**
 * Owner report 5ffa77e6 (2026-11-18, laptop, 0.1.1-staging.240): "my background noise got turned wayyy up, it also
 * happened when typing". Replays the owner's logged situation through the real send chain, 240's chain against the
 * current one. Skipped unless AUDIO_AUDIT=1.
 *
 *   AUDIO_AUDIT=1 AUDIO_AUDIT_SPEECH=/path/speech48k.f32 AUDIO_AUDIT_OUT=/dir \
 *   AUDIO_AUDIT_GATE240=/path/gate240.js AUDIO_AUDIT_AGC240=/path/agcKernel240.mjs \
 *     npx vitest run src/audio/audit/ownerNoise.sweep.test.ts --testTimeout=3600000
 *
 * AUDIO_AUDIT_GATE240 = 240's GATE_WORKLET_SOURCE (the automatic gate, its template with agcKernel.js inlined) and
 * AUDIO_AUDIT_AGC240 = 240's agcKernel.js (the stuck look-ahead limiter), both extracted from commit 105af76b; without them
 * only the current chain runs. Results: <OUT>/owner-noise.json, one row per run.
 *
 * The report's numbers it is set up from (mic_level / gate_level windows): speech into the AGC -23 / -35 / -31 dBFS, AGC gain
 * +13 / +26 / +29 dB, Light, gate on at -45 (automatic: thr -44 / -36 / -39, tracked floor -89 / -87 / -90), mic volume
 * 100 %, AGC on, echo cancellation on. The room level itself is not in the report (only that the gate's quietest blocks sat
 * near -89), so rooms are swept. Typing = key clicks (6 ms decaying bursts, ~7/s) in runs filling the pauses.
 */
import { describe, it } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { GATE_WORKLET_SOURCE } from '../../utils/voiceProcessor';
import { SPEEX_LIGHT_WORKLET_SOURCE } from '../../utils/speexLightWorkletSource';
import { RNNOISE_INLINE_WORKLET_SOURCE } from '../../utils/rnnoiseInWorkletSource';
import { speexWasmBytes } from '../../utils/speexWasm';
import { loadGate } from '../../utils/voiceGateHarness';
import { AgcProcessor } from '../agcKernel.js';
import {
    SR, Q, loadModuleWorklet, waitFor, background, scaleTo, labelSpeech, score, measureLag, rng, rmsOf, dbToLin,
    writeWavF32, type NsMode, type ChainTrace, type SpeechLabels, type Proc,
} from './chainHarness';

const ENABLED = !!process.env.AUDIO_AUDIT;
const OUT = process.env.AUDIO_AUDIT_OUT ?? '/tmp/audio-audit';
const WAV = process.env.AUDIO_AUDIT_WAV; // directory for listening samples (contain the speaker's voice: keep out of the repo)
const NS = { light: SPEEX_LIGHT_WORKLET_SOURCE, strong: RNNOISE_INLINE_WORKLET_SOURCE };

/** Typing: runs of key clicks filling the pauses (and, with `underSpeech`, the whole signal). Positions returned. */
function typing(lab: SpeechLabels, n: number, clickDb: number, seed: number, underSpeech: boolean, every = 1): { y: Float32Array; at: number[]; inPause: boolean[] } {
    const r = rng(seed), y = new Float32Array(n), at: number[] = [], inPause: boolean[] = [];
    const cl = Math.round(0.006 * SR);
    const proto = new Float32Array(cl);
    let run = -1, wasPause = false;
    for (let t = 0; t < n - cl; ) {
        t += Math.round(SR * (0.1 + 0.08 * r())); // ~7 keys/s
        const f = Math.floor(t / 240);
        if (f >= lab.frame.length) break;
        const pause = lab.distToSpeech[f] >= 0.3 * SR && lab.distToSpeech[Math.min(lab.frame.length - 1, f + 3)] >= 0.3 * SR;
        if (pause && !wasPause) run++;
        wasPause = pause;
        if (!pause && !underSpeech) continue;
        if (pause && run % every !== 0) continue;
        let s = 0;
        for (let i = 0; i < cl; i++) { proto[i] = (r() * 2 - 1) * Math.exp(-i / (0.0012 * SR)); s += proto[i] * proto[i]; }
        const k = (dbToLin(clickDb) / Math.sqrt(s / cl)) * (0.7 + 0.3 * r());
        for (let i = 0; i < cl && t + i < n; i++) y[t + i] += proto[i] * k;
        at.push(t); inPause.push(pause);
    }
    return { y, at, inPause };
}

interface Cfg {
    label: string;
    ns: NsMode;
    gate: 'off' | 'fixed' | 'auto240';
    thr?: number;
    agc: boolean;
    /** 240's chain: its gate source and its AgcProcessor (stuck limiter). */
    old?: boolean;
    /** Pin 240's automatic gate's tracked floor (the report's -89 dBFS). */
    pinFloorDb?: number;
    /** A different gate worklet source (a proposed change, measured against the current one). */
    gateSrc?: string;
    /** AgcProcessor options (e.g. speechOnlyBoost: false = the boost applied between words, as before 2026-11-18). */
    agcOpts?: Record<string, unknown>;
}

let gate240Src: string | null = null;
let Agc240: typeof AgcProcessor | null = null;

async function chain(cfg: Cfg) {
    let ns: Proc | null = null;
    if (cfg.ns === 'light') {
        ns = await loadModuleWorklet(NS.light, 'speex-light-worklet');
        ns.port.onmessage!({ data: { type: 'init', wasm: speexWasmBytes() } });
        await waitFor(() => !!ns!.ready);
        ns.port.onmessage!({ data: { type: 'toggle', enabled: true } });
    } else if (cfg.ns === 'strong') {
        ns = await loadModuleWorklet(NS.strong, 'rnnoise-inline-worklet');
        await waitFor(() => !!ns!.rnnoiseReady);
        ns.port.onmessage!({ data: { type: 'compGain', value: 1.496 } });
        ns.port.onmessage!({ data: { type: 'toggle', enabled: true } });
    }
    let src = cfg.gateSrc ?? (cfg.old ? gate240Src! : GATE_WORKLET_SOURCE);
    if (cfg.pinFloorDb != null) {
        const pinned = src.replace('this.floorDb = Math.min(-35, Math.max(-90, this.floorDb));', `this.floorDb = ${cfg.pinFloorDb};`);
        if (pinned === src) throw new Error('floor pin did not apply');
        src = pinned;
    }
    const msgs: Array<Record<string, unknown>> = [
        { type: 'gate', enabled: cfg.gate !== 'off' },
        { type: 'threshold', value: cfg.thr ?? -45 },
        { type: 'hold', ms: 150 },
    ];
    if (cfg.gate === 'auto240') msgs.push({ type: 'auto', value: true });
    const loaded = loadGate(src, msgs);
    const gate = loaded.node;
    const agc = new ((cfg.old ? Agc240 : AgcProcessor) ?? AgcProcessor)({ sampleRate: SR, enabled: cfg.agc, ...(cfg.agcOpts ?? {}) });
    agc.setMicGainDb(0);
    return (x: Float32Array) => {
        const blocks = Math.floor(x.length / Q), n = blocks * Q;
        const tr: ChainTrace & { thr: Float32Array; agcInMs: Float32Array } = {
            out: new Float32Array(n), nsOut: new Float32Array(n), gateGain: new Float32Array(blocks), gateOpen: new Uint8Array(blocks),
            gateThrDb: new Float32Array(blocks), agcGainDb: new Float32Array(blocks), agcVoice: new Uint8Array(blocks),
            agcLimHeld: new Uint8Array(blocks), thr: new Float32Array(blocks), agcInMs: new Float32Array(blocks),
        };
        const a = new Float32Array(Q), b = new Float32Array(Q), c = new Float32Array(Q);
        for (let k = 0; k < blocks; k++) {
            const inp = x.subarray(k * Q, (k + 1) * Q);
            if (ns) ns.process([[inp]], [[a]]); else a.set(inp);
            tr.nsOut.set(a, k * Q);
            gate.process([[a]], [[b]]);
            tr.gateGain[k] = gate.gain as number;
            tr.gateOpen[k] = (gate.holdLeft as number) > 0 ? 1 : 0;
            tr.gateThrDb[k] = cfg.gate === 'auto240' ? (gate.effDb as number) : cfg.gate === 'fixed' ? (cfg.thr ?? -45) : NaN;
            let ms = 0; for (let i = 0; i < Q; i++) ms += b[i] * b[i];
            tr.agcInMs[k] = ms / Q;
            const r = agc.process(b, c);
            tr.agcGainDb[k] = r.gainDb;
            tr.agcVoice[k] = r.voiceActive ? 1 : 0;
            tr.agcLimHeld[k] = (agc.limiterGain < 0.891 || agc.compReductionDb < -1) ? 1 : 0;
            tr.out.set(c, k * Q);
        }
        return { ...tr, posted: loaded.posted };
    };
}

const lagCache = new Map<NsMode, number>();
async function outLag(ns: NsMode, x: Float32Array): Promise<number> {
    if (lagCache.has(ns)) return lagCache.get(ns)!;
    const run = await chain({ label: 'lag', ns, gate: 'off', agc: false });
    const tr = run(x);
    const lag = measureLag(x, tr.out, SR * 20, SR * 2);
    lagCache.set(ns, lag);
    return lag;
}

/**
 * Measurement-only variant of the gate (OWNER_CLICKGATE="blocks:releaseMs,..."): an opening needs `blocks` quanta in a row
 * over the threshold before the 150 ms hold is granted; a shorter burst (a key click) opens the gate only while it lasts and
 * is released in `releaseMs`. Same threshold, attack and hold for anything sustained.
 */
function clickGateSource(blocks: number, releaseMs: number): string {
    let src = GATE_WORKLET_SOURCE;
    const rep = (a: string, b: string) => { if (!src.includes(a)) throw new Error(`clickGate patch: ${a}`); src = src.replace(a, b); };
    rep('this.holdLeft   = 0;', `this.holdLeft   = 0; this.overRun = 0; this.sustained = false; this.SUSTAIN_BLOCKS = ${blocks}; this.clickReleaseRate = 1 / Math.round(${releaseMs / 1000} * sampleRate);`);
    rep(`        if (rms >= this.threshold) {
            this.holdLeft = this.holdTotal; // voice detected — reset hold timer
        } else if (this.holdLeft > 0) {
            this.holdLeft -= inp.length;    // still in hold period
        }`, `        if (rms >= this.threshold) {
            this.overRun++;
            if (this.overRun >= this.SUSTAIN_BLOCKS) { this.holdLeft = this.holdTotal; this.sustained = true; }
            else this.holdLeft = Math.max(this.holdLeft, inp.length);
        } else {
            this.overRun = 0;
            if (this.holdLeft > 0) this.holdLeft -= inp.length;
        }`);
    rep('this.gain = Math.max(0, this.gain - this.releaseRate);', 'this.gain = Math.max(0, this.gain - (this.sustained ? this.releaseRate : this.clickReleaseRate)); if (this.gain === 0) this.sustained = false;');
    return src;
}

/** Mean (dB) over phrase onsets of the output-vs-input level in the first `sec` from the audible point, relative to the
 *  median phrase-core transmission: what a word start loses to the gate AND the AGC (score()'s onsetLossDb is 80 ms). */
function onsetLoss(x: Float32Array, lab: SpeechLabels, out: Float32Array, lag: number, from: number, sec: number): number {
    const core: number[] = [];
    for (let f = Math.ceil(from / 240); f < lab.frame.length; f++) {
        if (lab.frame[f] === 2 && lab.distToSpeech[f] === 0) {
            const a = f * 240;
            core.push(20 * Math.log10(Math.max(rmsOf(out, a + lag, a + 240 + lag), 1e-12) / Math.max(rmsOf(x, a, a + 240), 1e-12)));
        }
    }
    core.sort((p, q) => p - q);
    const ref = core[Math.floor(core.length / 2)] ?? 0;
    const l: number[] = [];
    lab.onsets.forEach((on, i) => {
        const a = lab.audibleAt[i];
        if (on < from || a < 0) return;
        const e = a + Math.round(sec * SR);
        l.push(20 * Math.log10(Math.max(rmsOf(out, a + lag, e + lag), 1e-12) / Math.max(rmsOf(x, a, e), 1e-12)) - ref);
    });
    return l.reduce((p, q) => p + q, 0) / Math.max(1, l.length);
}

const pw = (a: number[]) => 10 * Math.log10(Math.max(a.reduce((p, q) => p + q, 0) / Math.max(1, a.length), 1e-24));

describe.skipIf(!ENABLED)('owner noise report 5ffa77e6', () => {
    it('240 vs candidate, owner settings', async () => {
        mkdirSync(OUT, { recursive: true });
        if (process.env.AUDIO_AUDIT_GATE240 && existsSync(process.env.AUDIO_AUDIT_GATE240)) gate240Src = readFileSync(process.env.AUDIO_AUDIT_GATE240, 'utf8');
        if (process.env.AUDIO_AUDIT_AGC240 && existsSync(process.env.AUDIO_AUDIT_AGC240)) {
            Agc240 = (await import(/* @vite-ignore */ pathToFileURL(process.env.AUDIO_AUDIT_AGC240).href)).AgcProcessor;
        }
        const b = readFileSync(process.env.AUDIO_AUDIT_SPEECH!);
        const speech = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        // 15 s warm-up (the end of the recording) + the whole recording, scored after the warm-up.
        const warm = 15 * SR;
        const two = new Float32Array(warm + speech.length);
        two.set(speech.subarray(speech.length - warm), 0); two.set(speech, warm);

        const talkers = (process.env.OWNER_TALKERS ?? '-33').split(',').map(Number);
        const rooms = (process.env.OWNER_ROOMS ?? '-62,-56,-50').split(',').map(Number);
        const clicksRel = (process.env.OWNER_CLICKS ?? 'none,-10,0').split(',');
        const nsModes = (process.env.OWNER_NS ?? 'light').split(',') as NsMode[];
        const cfgSet = (process.env.OWNER_CFGS ?? 'old,oldpin,cand,candoff,candnoagc').split(',');
        const under = !!process.env.OWNER_UNDER_SPEECH;
        const rows: Record<string, unknown>[] = [];
        for (const T of talkers) {
            const clean = scaleTo(two, T);
            const lab = labelSpeech(clean);
            for (const R of rooms) {
                const bg = background('fan', clean.length, R, 11);
                for (const cr of clicksRel) {
                    const ty = cr === 'none' ? null : typing(lab, clean.length, T + Number(cr), 77, under, Number(process.env.OWNER_TYPING_EVERY ?? 1));
                    const x = new Float32Array(clean.length);
                    for (let i = 0; i < x.length; i++) x[i] = clean[i] + bg[i] + (ty ? ty.y[i] : 0);
                    for (const ns of nsModes) {
                        const lag = await outLag(ns, x);
                        const cfgs: Cfg[] = [];
                        if (gate240Src && Agc240) {
                            if (cfgSet.includes('old')) cfgs.push({ label: '240 auto gate', ns, gate: 'auto240', agc: true, old: true });
                            if (cfgSet.includes('oldpin')) cfgs.push({ label: '240 auto gate, floor pinned -89 (as logged)', ns, gate: 'auto240', agc: true, old: true, pinFloorDb: -89.2 });
                        }
                        if (cfgSet.includes('candold')) cfgs.push({ label: 'candidate a644315 (boost between words)', ns, gate: 'fixed', thr: -45, agc: true, agcOpts: { speechOnlyBoost: false } });
                        if (cfgSet.includes('cand')) cfgs.push({ label: 'candidate fixed -45', ns, gate: 'fixed', thr: -45, agc: true });
                        // OWNER_AGC_VARIANTS = ';'-separated JSON AgcProcessor options, each run like the candidate
                        for (const v of (process.env.OWNER_AGC_VARIANTS ?? '').split(';').filter(Boolean)) {
                            cfgs.push({ label: `agc ${v}`, ns, gate: 'fixed', thr: -45, agc: true, agcOpts: JSON.parse(v) });
                            if (process.env.OWNER_VARIANTS_GATE_OFF) cfgs.push({ label: `agc off ${v}`, ns, gate: 'off', agc: true, agcOpts: JSON.parse(v) });
                        }
                        if (cfgSet.includes('candoff')) cfgs.push({ label: 'candidate gate off', ns, gate: 'off', agc: true });
                        if (cfgSet.includes('candoffold')) cfgs.push({ label: 'candidate gate off, boost between words', ns, gate: 'off', agc: true, agcOpts: { speechOnlyBoost: false } });
                        // OWNER_ALT = comma list of gate worklet source files (proposals), each run like the candidate
                        for (const f of (process.env.OWNER_ALT ?? '').split(',').filter(Boolean)) {
                            cfgs.push({ label: `alt ${f.split('/').pop()}`, ns, gate: 'fixed', thr: -45, agc: true, gateSrc: readFileSync(f, 'utf8') });
                        }
                        for (const v of (process.env.OWNER_CLICKGATE ?? '').split(',').filter(Boolean)) {
                            const [bl, rel] = v.split(':').map(Number);
                            cfgs.push({ label: `clickgate ${bl}blk ${rel}ms`, ns, gate: 'fixed', thr: -45, agc: true, gateSrc: clickGateSource(bl, rel) });
                        }
                        if (cfgSet.includes('candnoagc')) cfgs.push({ label: 'candidate fixed -45, AGC off', ns, gate: 'fixed', thr: -45, agc: false });
                        for (const thr of (process.env.OWNER_EXTRA_THRS ?? '').split(',').filter(Boolean).map(Number)) {
                            cfgs.push({ label: `candidate fixed ${thr}`, ns, gate: 'fixed', thr, agc: true });
                        }
                        for (const cfg of cfgs) {
                            const run = await chain(cfg);
                            const tr = run(x);
                            // lagIn for score(): the harness aligns everything with one lag; ours includes the limiter's 1 ms.
                            const m = score(x, lab, tr, lag, warm);
                            const row: Record<string, unknown> = {
                                talkerDb: T, roomDb: R, clicks: cr === 'none' ? null : T + Number(cr), ns, cfg: cfg.label,
                                outSpeechDb: m.outSpeechDb, pauseNoiseDb: m.pauseNoiseDb, tailNoiseDb: m.tailNoiseDb,
                                gateOpenPct: m.gateOpenPct, nucleusCutPct: m.nucleusCutPct, onsetsClipped: m.onsetsClipped, limPct: m.limPct,
                                onsetLossDb: m.onsetLossDb, tailLossDb: m.tailLossDb, speechCutPct: m.speechCutPct, midCloses: m.midPhraseClosesPerMin,
                                gainSpreadDb: m.gainSpreadDb, gainSdDb: m.gainSdDb, onset20LossDb: onsetLoss(x, lab, tr.out, lag, warm, 0.02),
                            };
                            const sp: number[] = [], thr: number[] = [];
                            for (let k = Math.floor(warm / Q); k < tr.agcGainDb.length; k++) {
                                const f = Math.floor((k * Q - lag) / 240);
                                if (f >= 0 && f < lab.frame.length && lab.frame[f] === 2) sp.push(tr.agcGainDb[k]);
                                if (Number.isFinite(tr.gateThrDb[k])) thr.push(tr.gateThrDb[k]);
                            }
                            row.agcGainSpeechDb = sp.reduce((p, q) => p + q, 0) / Math.max(1, sp.length);
                            // what the app's mic_level would log: speech_db = AGC input power over the AGC's voiced blocks,
                            // gain_db = AGC gain over its voiced blocks
                            const vIn: number[] = [], vG: number[] = [];
                            for (let k = Math.floor(warm / Q); k < tr.agcVoice.length; k++) if (tr.agcVoice[k]) { vIn.push(tr.agcInMs[k]); vG.push(tr.agcGainDb[k]); }
                            row.appSpeechDb = pw(vIn);
                            row.appGainDb = vG.reduce((p, q) => p + q, 0) / Math.max(1, vG.length);
                            if (thr.length) row.thrMeanDb = thr.reduce((p, q) => p + q, 0) / thr.length;
                            // pause blocks with the gate open
                            let pb = 0, po = 0;
                            for (let k = Math.floor(warm / Q); k < tr.gateGain.length; k++) {
                                const f = Math.floor((k * Q - lag) / 240);
                                if (f < 0 || f >= lab.frame.length || lab.distToSpeech[f] < 0.3 * SR) continue;
                                pb++; if (tr.gateGain[k] >= 0.5) po++;
                            }
                            row.pauseOpenPct = (100 * po) / Math.max(1, pb);
                            // GateCutMeter's passed-noise count (seconds of non-voice the gate let through), whole run and the
                            // worst 25 s window (the background-noise prompt's window)
                            const ns1 = tr.posted.filter(p => p.type === 'gateStats').map(p => {
                                const c = p.cut as { noise?: number; blocks?: number } | undefined;
                                return c && c.noise != null ? (c.noise * Q) / SR : null;
                            });
                            if (ns1.some(v => v != null)) {
                                const v = ns1.map(x => x ?? 0);
                                let worst = 0;
                                for (let i = 0; i + 25 <= v.length; i++) worst = Math.max(worst, v.slice(i, i + 25).reduce((p, q) => p + q, 0));
                                row.noisePassedSec = v.reduce((p, q) => p + q, 0);
                                row.noiseWorst25s = worst;
                                row.runSec = v.length;
                                const bu = tr.posted.filter(p => p.type === 'gateStats').map(p => ((p.cut as { bursts?: number } | undefined)?.bursts ?? 0));
                                let wb = 0;
                                for (let i = 0; i + 25 <= bu.length; i++) wb = Math.max(wb, bu.slice(i, i + 25).reduce((p, q) => p + q, 0));
                                row.bursts = bu.reduce((p, q) => p + q, 0);
                                row.burstsWorst25s = wb;
                            }
                            if (ty) {
                                // each click: 8 ms window on the wire vs at the mic
                                const wire: number[] = [], mic: number[] = [], wireAll: number[] = [];
                                const cl = Math.round(0.008 * SR);
                                ty.at.forEach((t, i) => {
                                    if (t < warm) return;
                                    const o = rmsOf(tr.out, t + lag, t + lag + cl) ** 2;
                                    wireAll.push(o);
                                    if (!ty.inPause[i]) return;
                                    wire.push(o); mic.push(rmsOf(ty.y, t, t + cl) ** 2);
                                });
                                row.clickMicDb = pw(mic);
                                row.clickWireDb = pw(wire);
                                row.clickLiftDb = pw(wire) - pw(mic);
                                row.clickVsVoiceDb = pw(wire) - m.outSpeechDb;
                                // the room the gate let through BETWEEN keys (pauses, outside 40 ms after each click: its decay)
                                const near = new Uint8Array(Math.ceil(x.length / 240));
                                ty.at.forEach(t => { for (let f = Math.floor(t / 240); f <= Math.floor((t + 0.04 * SR) / 240) && f < near.length; f++) near[f] = 1; });
                                const rb: number[] = [];
                                for (let f = Math.ceil(warm / 240); f < lab.frame.length; f++) {
                                    if (lab.distToSpeech[f] < 0.3 * SR || near[f]) continue;
                                    rb.push(rmsOf(tr.out, f * 240 + lag, (f + 1) * 240 + lag) ** 2);
                                }
                                row.roomBetweenKeysDb = pw(rb);
                                if (under) row.clickWireAllDb = pw(wireAll);
                                // clicks passed at >= -6 dB of the voice on the wire
                                row.clicksNearVoicePct = (100 * wire.filter(o => 10 * Math.log10(Math.max(o, 1e-24)) >= m.outSpeechDb - 6).length) / Math.max(1, wire.length);
                            }
                            rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v])));
                            console.log(JSON.stringify(rows[rows.length - 1]));
                            if (WAV) {
                                const name = `${cfg.label.replace(/[^a-z0-9]+/gi, '_')}_${ns}_t${T}_room${R}_clicks${cr}.wav`;
                                writeWavF32(join(WAV, name), tr.out.subarray(warm, warm + 20 * SR));
                            }
                        }
                    }
                }
            }
        }
        writeFileSync(join(OUT, `owner-noise${process.env.OWNER_TAG ?? ''}.json`), JSON.stringify(rows, null, 1));
    });
});
