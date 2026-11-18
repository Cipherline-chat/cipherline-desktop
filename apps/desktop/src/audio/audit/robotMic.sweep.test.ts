/**
 * User report bc9aa8dc (2026-11-18, Windows, stable 0.1.1): "Microphone sounds robot to friend", relayed by the owner as
 * "his friend hears a microwave sound all the time". Replays the logged situation through the real send chain, v0.1.1's
 * chain against the current one. Skipped unless AUDIO_AUDIT=1.
 *
 *   AUDIO_AUDIT=1 AUDIO_AUDIT_SPEECH=/path/speech48k.f32 AUDIO_AUDIT_OUT=/dir \
 *   AUDIO_AUDIT_GATE011=/path/gate011.js AUDIO_AUDIT_AGC011=/path/agcKernel011.mjs \
 *     npx vitest run src/audio/audit/robotMic.sweep.test.ts --testTimeout=3600000
 *
 * AUDIO_AUDIT_GATE011 = v0.1.1's GATE_WORKLET_SOURCE (the automatic gate with its pitch rule and 350 ms hold, agcKernel.js
 * inlined) and AUDIO_AUDIT_AGC011 = v0.1.1's agcKernel.js (the stuck look-ahead limiter, the boost between words), both
 * rebuilt from origin/main 92165390 (= v0.1.1's audio code; identical to staging.240's). Without them only the current
 * chain runs. Results: <OUT>/robot-mic<ROBOT_TAG>.json, one row per run.
 *
 * What the report logged (18 mic_level / 17 gate_level windows of 30 s, one call, ~18 min): speech into the AGC
 * -31..-42 dBFS (median -35.7), AGC gain +13..+32 dB (median +23), raw speech -30..-48, NS stage -1.5..-8 dB under its
 * +3.5 dB make-up during speech, limiter held 94-100 % (stuck), gate open 7-52 % (one window 100 %), talk 4-39 %, auto
 * threshold -36..-54 (tracked floor -89..-90), pitch-rule share 0-17 %. Network clean (0 % loss, RTT 32 ms), no
 * e2ee_audio_lag drops, no render underruns. The room itself is not in a 0.1.1 report, so rooms and noise kinds are swept
 * and the app-equivalent numbers (appSpeechDb / appGainDb / nsMinusRawDb / gatePct / talkPct) are printed to match the
 * report against.
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
    SR, Q, loadModuleWorklet, waitFor, background, scaleTo, labelSpeech, score, measureLag, rmsOf,
    spectralFluctuationDb, writeWavF32, type NsMode, type ChainTrace, type Proc, type NoiseKind,
} from './chainHarness';

const ENABLED = !!process.env.AUDIO_AUDIT;
const OUT = process.env.AUDIO_AUDIT_OUT ?? '/tmp/audio-audit';
const WAV = process.env.AUDIO_AUDIT_WAV; // listening samples contain the speaker's voice: keep them out of the repo
const NS_SRC = { light: SPEEX_LIGHT_WORKLET_SOURCE, strong: RNNOISE_INLINE_WORKLET_SOURCE };

type Room = NoiseKind | 'buzz';

/** 'buzz' = a transformer / ground-loop / microwave-like buzz: 120 Hz with harmonics to ~4 kHz (1/k), carrying half the
 *  noise power, over the harness fan. Everything else comes from chainHarness.background. RMS = `db`. */
function room(kind: Room, n: number, db: number, seed: number): Float32Array {
    if (kind !== 'buzz') return background(kind, n, db, seed);
    const f = background('fan', n, 0, seed + 1);
    const y = new Float32Array(n);
    let hp = 0;
    for (let k = 1; k <= 33; k++) hp += 0.5 / (k * k);
    const hn = 1 / Math.sqrt(hp);
    for (let i = 0; i < n; i++) {
        let h = 0; for (let k = 1; k <= 33; k++) h += Math.sin(2 * Math.PI * 120 * k * i / SR + 0.7 * k) / k;
        y[i] = f[i] * 0.707 + h * hn * 0.707;
    }
    return scaleRms(y, db);
}

function scaleRms(y: Float32Array, db: number): Float32Array {
    const r = rmsOf(y);
    const k = Math.pow(10, db / 20) / Math.max(r, 1e-12);
    for (let i = 0; i < y.length; i++) y[i] *= k;
    return y;
}

interface Cfg {
    label: string;
    ns: NsMode;
    gate: 'off' | 'fixed' | 'auto011';
    thr?: number;
    old?: boolean;
    pinFloorDb?: number;
}

let gate011Src: string | null = null;
let Agc011: typeof AgcProcessor | null = null;

async function nsStage(mode: NsMode): Promise<Proc | null> {
    if (mode === 'light') {
        const ns = await loadModuleWorklet(NS_SRC.light, 'speex-light-worklet');
        ns.port.onmessage!({ data: { type: 'init', wasm: speexWasmBytes() } });
        await waitFor(() => !!ns.ready);
        ns.port.onmessage!({ data: { type: 'toggle', enabled: true } });
        return ns;
    }
    if (mode === 'strong') {
        const ns = await loadModuleWorklet(NS_SRC.strong, 'rnnoise-inline-worklet');
        await waitFor(() => !!ns.rnnoiseReady);
        ns.port.onmessage!({ data: { type: 'compGain', value: 1.496 } });
        ns.port.onmessage!({ data: { type: 'toggle', enabled: true } });
        return ns;
    }
    return null;
}

async function chain(cfg: Cfg) {
    const ns = await nsStage(cfg.ns);
    let src = cfg.old ? gate011Src! : GATE_WORKLET_SOURCE;
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
    if (cfg.gate === 'auto011') msgs.push({ type: 'auto', value: true });
    const loaded = loadGate(src, msgs);
    const gate = loaded.node;
    const agc = new ((cfg.old ? Agc011 : AgcProcessor) ?? AgcProcessor)({ sampleRate: SR, enabled: true });
    agc.setMicGainDb(0); // the report's mic_gain_db: 0 (slider 100 % during the call)
    return (x: Float32Array) => {
        const blocks = Math.floor(x.length / Q), n = blocks * Q;
        const tr: ChainTrace & { agcInMs: Float32Array; rawMs: Float32Array; nsMs: Float32Array } = {
            out: new Float32Array(n), nsOut: new Float32Array(n), gateGain: new Float32Array(blocks), gateOpen: new Uint8Array(blocks),
            gateThrDb: new Float32Array(blocks), agcGainDb: new Float32Array(blocks), agcVoice: new Uint8Array(blocks),
            agcLimHeld: new Uint8Array(blocks), agcInMs: new Float32Array(blocks), rawMs: new Float32Array(blocks), nsMs: new Float32Array(blocks),
        };
        const a = new Float32Array(Q), b = new Float32Array(Q), c = new Float32Array(Q);
        for (let k = 0; k < blocks; k++) {
            const inp = x.subarray(k * Q, (k + 1) * Q);
            if (ns) ns.process([[inp]], [[a]]); else a.set(inp);
            tr.nsOut.set(a, k * Q);
            let r0 = 0, n0 = 0; for (let i = 0; i < Q; i++) { r0 += inp[i] * inp[i]; n0 += a[i] * a[i]; }
            tr.rawMs[k] = r0 / Q; tr.nsMs[k] = n0 / Q;
            gate.process([[a]], [[b]]);
            tr.gateGain[k] = gate.gain as number;
            tr.gateOpen[k] = (gate.holdLeft as number) > 0 ? 1 : 0;
            tr.gateThrDb[k] = cfg.gate === 'auto011' ? (gate.effDb as number) : cfg.gate === 'fixed' ? (cfg.thr ?? -45) : NaN;
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

const pw = (a: number[]) => 10 * Math.log10(Math.max(a.reduce((p, q) => p + q, 0) / Math.max(1, a.length), 1e-24));
const avg = (a: number[]) => a.reduce((p, q) => p + q, 0) / Math.max(1, a.length);
const sd = (a: number[]) => { const m = avg(a); return Math.sqrt(avg(a.map(v => (v - m) ** 2))); };

describe.skipIf(!ENABLED)('robot mic report bc9aa8dc', () => {
    it.skipIf(!!process.env.ROBOT_NSONLY)('v0.1.1 vs candidate, reported settings', async () => {
        mkdirSync(OUT, { recursive: true });
        if (process.env.AUDIO_AUDIT_GATE011 && existsSync(process.env.AUDIO_AUDIT_GATE011)) gate011Src = readFileSync(process.env.AUDIO_AUDIT_GATE011, 'utf8');
        if (process.env.AUDIO_AUDIT_AGC011 && existsSync(process.env.AUDIO_AUDIT_AGC011)) {
            Agc011 = (await import(/* @vite-ignore */ pathToFileURL(process.env.AUDIO_AUDIT_AGC011).href)).AgcProcessor;
        }
        const b = readFileSync(process.env.AUDIO_AUDIT_SPEECH!);
        const speech = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        const warm = 15 * SR;
        const two = new Float32Array(warm + speech.length);
        two.set(speech.subarray(speech.length - warm), 0); two.set(speech, warm);

        const talkers = (process.env.ROBOT_TALKERS ?? '-36').split(',').map(Number);
        const rooms = (process.env.ROBOT_ROOMS ?? '-60,-52,-46').split(',').map(Number);
        const kinds = (process.env.ROBOT_KINDS ?? 'fan,buzz').split(',') as Room[];
        const nsModes = (process.env.ROBOT_NS ?? 'light').split(',') as NsMode[];
        const cfgSet = (process.env.ROBOT_CFGS ?? 'old,cand,candoff').split(',');
        const rows: Record<string, unknown>[] = [];
        const nsNoiseCache = new Map<string, { resDb: number; fluct: number; rawFluct: number }>();
        const lagCache = new Map<NsMode, number>();
        for (const T of talkers) {
            const clean = scaleTo(two, T);
            const lab = labelSpeech(clean);
            for (const kind of kinds) {
                for (const R of rooms) {
                    const bg = room(kind, clean.length, R, 11);
                    const x = new Float32Array(clean.length);
                    for (let i = 0; i < x.length; i++) x[i] = clean[i] + bg[i];
                    for (const ns of nsModes) {
                        if (!lagCache.has(ns)) {
                            const lr = await chain({ label: 'lag', ns, gate: 'off' });
                            lagCache.set(ns, measureLag(x, lr(x).out, SR * 20, SR * 2));
                        }
                        const lag = lagCache.get(ns)!;
                        // What the NS stage leaves of the room on its own (noise-only input): level and musical-noise
                        // fluctuation (300 Hz-6 kHz bin-level sd; Gaussian noise ~5.6 dB, bubbling higher).
                        const nk = `${ns}|${kind}|${R}`;
                        if (!nsNoiseCache.has(nk)) {
                            const st = await nsStage(ns);
                            const y = new Float32Array(Math.floor(bg.length / Q) * Q), a = new Float32Array(Q);
                            for (let k = 0; k < y.length / Q; k++) {
                                const inp = bg.subarray(k * Q, (k + 1) * Q);
                                if (st) st.process([[inp]], [[a]]); else a.set(inp);
                                y.set(a, k * Q);
                            }
                            nsNoiseCache.set(nk, {
                                resDb: 20 * Math.log10(Math.max(rmsOf(y, warm, y.length), 1e-12)),
                                fluct: spectralFluctuationDb(y, warm, warm + 20 * SR),
                                rawFluct: spectralFluctuationDb(bg, warm, warm + 20 * SR),
                            });
                        }
                        const nsNoise = nsNoiseCache.get(nk)!;
                        const cfgs: Cfg[] = [];
                        if (gate011Src && Agc011) {
                            if (cfgSet.includes('old')) cfgs.push({ label: 'v0.1.1 auto gate', ns, gate: 'auto011', old: true });
                            if (cfgSet.includes('oldpin')) cfgs.push({ label: 'v0.1.1 auto gate, floor pinned -89.7 (as logged)', ns, gate: 'auto011', old: true, pinFloorDb: -89.7 });
                        }
                        if (cfgSet.includes('cand')) cfgs.push({ label: 'candidate fixed -45', ns, gate: 'fixed', thr: -45 });
                        if (cfgSet.includes('candoff')) cfgs.push({ label: 'candidate gate off', ns, gate: 'off' });
                        // ROBOT_THRS = other fixed thresholds to compare (e.g. what the gate-cut prompt would suggest)
                        for (const thr of (process.env.ROBOT_THRS ?? '').split(',').filter(Boolean).map(Number)) {
                            cfgs.push({ label: `candidate fixed ${thr}`, ns, gate: 'fixed', thr });
                        }
                        for (const cfg of cfgs) {
                            const run = await chain(cfg);
                            const tr = run(x);
                            const m = score(x, lab, tr, lag, warm);
                            const b0 = Math.floor(warm / Q);
                            // app-equivalent mic_level numbers over the AGC's voiced blocks
                            const vIn: number[] = [], vG: number[] = [], vRaw: number[] = [], vNs: number[] = [];
                            let voiced = 0, tot = 0, open = 0, trans = 0;
                            for (let k = b0; k < tr.agcVoice.length; k++) {
                                tot++;
                                if (tr.gateGain[k] >= 0.5) open++;
                                if (k > 0 && tr.gateGain[k - 1] >= 0.5 && tr.gateGain[k] < 0.5) trans++;
                                if (!tr.agcVoice[k]) continue;
                                voiced++;
                                vIn.push(tr.agcInMs[k]); vG.push(tr.agcGainDb[k]); vRaw.push(tr.rawMs[k]); vNs.push(tr.nsMs[k]);
                            }
                            const minutes = (tot * Q) / SR / 60;
                            // speech-block AGC gain (what the room UNDER the voice is lifted by)
                            const sp: number[] = [];
                            for (let k = b0; k < tr.agcGainDb.length; k++) {
                                const f = Math.floor((k * Q - lag) / 240);
                                if (f >= 0 && f < lab.frame.length && lab.frame[f] === 2) sp.push(tr.agcGainDb[k]);
                            }
                            const gSpeech = avg(sp);
                            // level stability: output speech level per 5 s window
                            const win: number[] = [];
                            for (let s = warm; s + 5 * SR <= x.length; s += 5 * SR) {
                                const ps: number[] = [];
                                for (let f = Math.floor(s / 240); f < Math.floor((s + 5 * SR) / 240) && f < lab.frame.length; f++) {
                                    if (lab.frame[f] > 0) ps.push(rmsOf(tr.out, f * 240 + lag, (f + 1) * 240 + lag) ** 2);
                                }
                                if (ps.length > 50) win.push(pw(ps));
                            }
                            const row: Record<string, unknown> = {
                                talkerDb: T, kind, roomDb: R, ns, cfg: cfg.label,
                                appSpeechDb: pw(vIn), appGainDb: avg(vG), appRawDb: pw(vRaw), nsMinusRawDb: pw(vNs) - pw(vRaw),
                                talkPct: (100 * voiced) / Math.max(1, tot), gatePct: (100 * open) / Math.max(1, tot),
                                thrMeanDb: m.thrMedianDb, limPct: m.limPct,
                                outSpeechDb: m.outSpeechDb, pauseNoiseDb: m.pauseNoiseDb, tailNoiseDb: m.tailNoiseDb,
                                gateClosesPerMin: trans / Math.max(1e-9, minutes), midCloses: m.midPhraseClosesPerMin, pauseOpensPerSec: m.pauseOpensPerSec,
                                pauseLevelSdDb: m.pauseLevelSdDb,
                                // the room under the voice on the wire: NS residual lifted by the speech-time AGC gain
                                roomUnderVoiceDb: nsNoise.resDb + gSpeech, roomUnderVoiceRelDb: nsNoise.resDb + gSpeech - m.outSpeechDb,
                                nsResidualFluctDb: nsNoise.fluct, rawRoomFluctDb: nsNoise.rawFluct,
                                gainSdDb: m.gainSdDb, gainSpreadDb: m.gainSpreadDb, out5sSdDb: sd(win),
                                nucleusCutPct: m.nucleusCutPct, onsetsClipped: m.onsetsClipped,
                            };
                            rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v])));
                            console.log(JSON.stringify(rows[rows.length - 1]));
                            if (WAV) {
                                const name = `${cfg.label.replace(/[^a-z0-9]+/gi, '_')}_${ns}_t${T}_${kind}${R}.wav`;
                                writeWavF32(join(WAV, name), tr.out.subarray(warm, warm + 20 * SR));
                            }
                        }
                    }
                }
            }
        }
        writeFileSync(join(OUT, `robot-mic${process.env.ROBOT_TAG ?? ''}.json`), JSON.stringify(rows, null, 1));
    });
    // The NS stage alone on speech: how much of the voice it removes and how clean what it keeps is, by talker level.
    // ROBOT_NSONLY=1. removal = speech-frame power in vs out (dB, make-up excluded); sdrDb = the output against the best
    // scaled copy of the CLEAN speech on speech frames (distortion + leftover room); gainFlickerDb = sd of the stage's
    // 10 ms gain (out/in, dB) across voiced frames - the "warble" a listener calls robotic.
    it.runIf(!!process.env.ROBOT_NSONLY)('NS stage on quiet speech', async () => {
        mkdirSync(OUT, { recursive: true });
        const b = readFileSync(process.env.AUDIO_AUDIT_SPEECH!);
        const speech = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        const warm = 15 * SR;
        const two = new Float32Array(warm + speech.length);
        two.set(speech.subarray(speech.length - warm), 0); two.set(speech, warm);
        const talkers = (process.env.ROBOT_TALKERS ?? '-30,-38,-44,-50').split(',').map(Number);
        const rooms = (process.env.ROBOT_ROOMS ?? 'none,-62,-55').split(',');
        const nsModes = (process.env.ROBOT_NS ?? 'light,strong').split(',') as NsMode[];
        const rows: Record<string, unknown>[] = [];
        for (const T of talkers) {
            const clean = scaleTo(two, T);
            const lab = labelSpeech(clean);
            for (const Rs of rooms) {
                const bg = Rs === 'none' ? new Float32Array(clean.length) : room('fan', clean.length, Number(Rs), 11);
                const x = new Float32Array(clean.length);
                for (let i = 0; i < x.length; i++) x[i] = clean[i] + bg[i];
                for (const ns of nsModes) {
                    const st = await nsStage(ns);
                    const y = new Float32Array(Math.floor(x.length / Q) * Q), a = new Float32Array(Q);
                    for (let k = 0; k < y.length / Q; k++) { st!.process([[x.subarray(k * Q, (k + 1) * Q)]], [[a]]); y.set(a, k * Q); }
                    const lag = measureLag(x, y, SR * 20, SR * 2);
                    const mk = ns === 'strong' ? 1.496 : 1;
                    let pin = 0, pout = 0, xy = 0, xx = 0, yy = 0;
                    const gf: number[] = [];
                    for (let f = Math.ceil(warm / 480); (f + 1) * 480 + lag <= y.length && (f + 1) * 480 <= x.length; f++) {
                        const s0 = f * 480;
                        const l0 = Math.floor(s0 / 240);
                        if (l0 + 1 >= lab.frame.length || lab.frame[l0] !== 2 || lab.frame[l0 + 1] !== 2) continue;
                        let fi = 0, fo = 0;
                        for (let i = s0; i < s0 + 480; i++) {
                            const c = clean[i], o = y[i + lag] / mk;
                            fi += x[i] * x[i]; fo += o * o; xy += c * o; xx += c * c; yy += o * o;
                        }
                        pin += fi; pout += fo;
                        gf.push(10 * Math.log10(Math.max(fo, 1e-20) / Math.max(fi, 1e-20)));
                    }
                    const k = xy / Math.max(xx, 1e-20), err = Math.max(yy - 2 * k * xy + k * k * xx, 1e-20);
                    const row = {
                        talkerDb: T, roomDb: Rs, ns,
                        removalDb: 10 * Math.log10(Math.max(pin, 1e-20) / Math.max(pout, 1e-20)),
                        nsMinusRawDb: 10 * Math.log10(Math.max(pout * mk * mk, 1e-20) / Math.max(pin, 1e-20)),
                        sdrDb: 10 * Math.log10((k * k * xx) / err),
                        gainFlickerDb: sd(gf),
                    };
                    rows.push(Object.fromEntries(Object.entries(row).map(([kk, v]) => [kk, typeof v === 'number' ? Math.round(v * 10) / 10 : v])));
                }
            }
        }
        writeFileSync(join(OUT, `robot-mic-nsonly${process.env.ROBOT_TAG ?? ''}.json`), JSON.stringify(rows, null, 1));
    });
});
