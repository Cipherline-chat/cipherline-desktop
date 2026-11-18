/**
 * Call audio END-TO-END sweep (2026-11-17). Skipped unless AUDIO_E2E=1.
 *
 * Two headless Chromium pages in a real LiveKit room with the app's E2EE: the talker publishes through the app's send
 * chain (voiceProcessorManager + CipherlineVoiceProcessor + its worklets), the listener records the decoded track and
 * runs the app's receive leveler (harness/call-audio-e2e/main.ts). The same input goes through the offline chain
 * (chainHarness.buildChain, as audioAudit.sweep.test.ts), and both are scored by the same code (e2eAnalysis.ts), so each
 * row answers "does the real round trip add anything bad?".
 *
 * Needs a THROWAWAY LiveKit (never the dev stack's, never prod / staging), e.g.:
 *   docker network create clae2e-net
 *   docker run -d --name clae2e-lk --network clae2e-net livekit/livekit-server:v1.9.12 --dev --bind 0.0.0.0
 *   # optional, for the impaired-network rows: tc in the SFU's netns
 *   docker run -d --name clae2e-tc --net container:clae2e-lk --cap-add NET_ADMIN alpine:latest sleep infinity
 *   docker exec clae2e-tc apk add --no-cache iproute2-tc
 * then (from apps/desktop):
 *   AUDIO_E2E=1 LK_URL=ws://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' clae2e-lk):7880 \
 *     [TC_SIDECAR=clae2e-tc] AUDIO_AUDIT_SPEECH=/path/speech48k.f32 AUDIO_E2E_OUT=/scratch/dir [AUDIO_E2E_SET=all|matrix|special|<names>] \
 *     [AUDIO_E2E_WAVS=/dir/outside/the/repo] [AUDIO_E2E_REUSE=1 (re-analyse existing recordings)] \
 *     npx vitest run src/audio/audit/callAudioE2E.sweep.test.ts --testTimeout=7200000
 *   docker rm -f clae2e-tc clae2e-lk; docker network rm clae2e-net
 *
 * AUDIO_AUDIT_SPEECH = mono float32 LE 48 kHz clean speech (none is in the repo: it is a person's voice; listening WAVs
 * written with AUDIO_E2E_WAVS contain it too and must never be committed). Results: <OUT>/results.json, results.md.
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { GATE_WORKLET_SOURCE } from '../../utils/voiceProcessor';
import { SPEEX_LIGHT_WORKLET_SOURCE } from '../../utils/speexLightWorkletSource';
import { RNNOISE_INLINE_WORKLET_SOURCE } from '../../utils/rnnoiseInWorkletSource';
import { speexWasmBytes } from '../../utils/speexWasm';
import { synth } from '../../utils/voiceGateHarness';
import { ReceiveLeveler } from '../receiveLeveler.js';
import {
    SR, buildChain, background, breath, keyClicks, scaleTo, labelSpeech, score, rmsOf, linToDb, spectralFluctuationDb,
    type NoiseKind, type NsMode, type SpeechLabels, type Metrics,
} from './chainHarness';
import { GateCutWatcher, gateCutSecondFrom, GC_BLOCK_SEC, type GateCutSecond, type GateCutDetection } from '../../utils/gateCut';
import { GC_MIN_CALL_SEC } from '../../utils/gateCutPrompt';
import { findLag, trackLag, alignByTrack, scoreAligned, roundTrip, longestZeroRunMs, maxStepDb, spanLevelDb, type LagTrack } from './e2eAnalysis';

const ENABLED = !!process.env.AUDIO_E2E;
const OUT = resolve(process.env.AUDIO_E2E_OUT ?? '/tmp/audio-e2e');
const SET = process.env.AUDIO_E2E_SET ?? 'all';
const REUSE = !!process.env.AUDIO_E2E_REUSE;
const WAVS = process.env.AUDIO_E2E_WAVS;
const APP = resolve(__dirname, '..', '..', '..');
const NS_SRC = { light: SPEEX_LIGHT_WORKLET_SOURCE, strong: RNNOISE_INLINE_WORKLET_SOURCE, speexWasm: speexWasmBytes };

function loadSpeech(): Float32Array {
    const p = process.env.AUDIO_AUDIT_SPEECH;
    if (p && existsSync(p)) { const b = readFileSync(p); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
    return synth({ speechDb: -30, duty: 0.35, floorDb: -140, seconds: 45, seed: 5, events: 'none', sigmaDb: 4.5, phraseSigmaDb: 5 }).x;
}

type Action = { t: number; kind: 'mute' | 'unmute' | 'ns' | 'gate' | 'stall'; mode?: NsMode; on?: boolean; ms?: number };
interface Sc {
    name: string; talkerDb: number; noise: NoiseKind; snrDb: number; events: boolean;
    passes: 1 | 2; ns: NsMode; gate: boolean;
    /** Seconds of room-only input before the speech. */
    preS?: number;
    /** +dB applied to [s, e) of the clean speech before mixing (a shout). */
    loud?: { s: number; e: number; db: number };
    actions?: Action[];
    /** Offline equivalent of the actions: spans fed as exact zeros (a disabled track). null = no offline run. */
    muted?: Array<[number, number]> | null;
    source?: 'webaudio' | 'gum'; echoCancellation?: boolean;
    netem?: string;
    /** Diagnostics: run without E2EE (the page's ProbeOpts). */
    probe?: { e2ee?: boolean };
    /** A capture-stall experiment: scored only for audio lost at the listener (the stall breaks sample alignment). */
    stall?: boolean;
    /** ptt press offsets (s, before each pressed phrase's onset), for the per-offset onset table. */
    ptt?: Array<{ onset: number; lead: number }>;
}

function makeInput(speech: Float32Array, sc: Sc): { x: Float32Array; lab: SpeechLabels } {
    const pre = Math.round((sc.preS ?? 0) * SR);
    const clean0 = new Float32Array(pre + speech.length * sc.passes);
    for (let p = 0; p < sc.passes; p++) clean0.set(speech, pre + p * speech.length);
    const clean = scaleTo(clean0, sc.talkerDb);
    if (sc.loud) { const k = Math.pow(10, sc.loud.db / 20); for (let i = Math.round(sc.loud.s * SR); i < Math.round(sc.loud.e * SR); i++) clean[i] *= k; }
    const lab = labelSpeech(clean);
    const x = new Float32Array(clean.length);
    const bg = background(sc.noise, x.length, sc.talkerDb - sc.snrDb, 11);
    for (let i = 0; i < x.length; i++) x[i] = clean[i] + bg[i];
    if (sc.events) {
        // audioAudit.sweep.test.ts makeInput: one event per long pause, alternating breath / keys
        let alt = 0, runStart = -1;
        for (let f = 0; f < lab.frame.length; f++) {
            const far = lab.distToSpeech[f] >= 0.4 * SR;
            if (far && runStart < 0) runStart = f;
            if ((!far || f === lab.frame.length - 1) && runStart >= 0) {
                const len = (f - runStart) * 240;
                const ev = alt++ % 2 === 0 ? breath(0.35, sc.talkerDb - 22, 100 + alt) : keyClicks(8, sc.talkerDb - 16, 200 + alt);
                if (len > ev.length) { const at = runStart * 240 + Math.floor((len - ev.length) / 2); for (let i = 0; i < ev.length; i++) x[at + i] += ev[i]; }
                runStart = -1;
            }
        }
    }
    return { x, lab };
}

function scenarios(speech: Speech): Sc[] {
    const s: Sc[] = [];
    for (const t of [-45, -30]) for (const ns of ['off', 'light', 'strong'] as NsMode[]) for (const gate of [true, false]) {
        s.push({ name: `m_${ns}_${gate ? 'gate' : 'nogate'}_t${-t}`, talkerDb: t, noise: 'fan', snrDb: 20, events: true, passes: 2, ns, gate, muted: [] });
    }
    // the codec alone: no NS, no gate, a silent room (AGC on, as always)
    s.push({ name: 'b_codec_t30_quiet', talkerDb: -30, noise: 'hiss', snrDb: 108, events: false, passes: 2, ns: 'off', gate: false, muted: [] });
    const base = { talkerDb: -30, noise: 'fan' as NoiseKind, snrDb: 20, events: true, passes: 1 as const, ns: 'light' as NsMode, gate: true };
    // muted 60 s in a call, unmute, speech starts 4 s later
    s.push({ ...base, name: 's_unmute60', preS: 64, actions: [{ t: -1, kind: 'mute' }, { t: 60, kind: 'unmute' }], muted: [[0, 60]] });
    // one shout (+20 dB, over full scale) at 6-7 s, then normal speech
    s.push({ ...base, name: 's_loud', loud: { s: 6, e: 7, db: 20 }, muted: [] });
    // push-to-talk: mic off between presses; press 300 / 150 / 0 ms before a phrase onset, release 300 ms after it ends
    {
        const lab = labelSpeech(scaleTo(speech.x, -30));
        const acts: Action[] = [{ t: -1, kind: 'mute' }];
        const muted: Array<[number, number]> = [];
        const ptt: Sc['ptt'] = [];
        const leads = [0.3, 0.15, 0];
        let lastOff = 0, k = 0;
        lab.onsets.forEach((on, i) => {
            const onS = on / SR, end = (lab.ends.find(e => e > on) ?? on) / SR;
            const lead = leads[k % 3];
            const press = onS - lead;
            if (press < lastOff + 0.25 || onS < 2) return; // presses need a gap from the last release
            muted.push([lastOff, press]);
            acts.push({ t: press, kind: 'unmute' }, { t: end + 0.3, kind: 'mute' });
            ptt.push({ onset: i, lead });
            lastOff = end + 0.3; k++;
        });
        muted.push([lastOff, 1e9]);
        s.push({ ...base, name: 's_ptt', actions: acts, muted, ptt });
    }
    // switching NS mode mid-call: Light -> Strong at 12 s -> Off at 24 s -> Light at 34 s (no offline equivalent)
    {
        // each switch lands 100 ms into a phrase that runs >= 500 ms (any gap / click is then the switch, not a pause)
        const lab = labelSpeech(scaleTo(speech.x, -30));
        const midPhrase = (t: number) => {
            for (let f = Math.ceil((t * SR) / 240); f + 100 < lab.frame.length; f++) {
                let ok = true; for (let j = 0; j < 100; j++) if (lab.frame[f + j] === 0) { ok = false; break; }
                if (ok) return (f * 240) / SR + 0.1;
            }
            return t;
        };
        s.push({ ...base, name: 's_nsswitch', actions: [{ t: midPhrase(12), kind: 'ns', mode: 'strong' }, { t: midPhrase(24), kind: 'ns', mode: 'off' }, { t: midPhrase(34), kind: 'ns', mode: 'light' }], muted: null });
    }
    // the capture path itself: Chromium's fake mic device playing the same input, the app's capture constraints
    s.push({ ...base, name: 's_gum_ec', source: 'gum', echoCancellation: true, muted: [] });
    s.push({ ...base, name: 's_gum_noec', source: 'gum', echoCancellation: false, muted: [] });
    // capture stalls (the context feeding the published track stops for `ms`) with and without E2EE: does the
    // E2EE audio-lag cap (e2eeAudioLag.ts) turn a stall into lost speech? NS off, gate off, fan room: the decoded
    // track is never silent unless audio is lost.
    for (const [ms, e2ee] of [[600, true], [600, false], [1500, true], [1500, false]] as Array<[number, boolean]>) {
        s.push({ name: `x_stall${ms}_${e2ee ? 'e2ee' : 'plain'}`, talkerDb: -30, noise: 'fan', snrDb: 20, events: false, passes: 1, ns: 'off', gate: false,
            actions: [{ t: 10, kind: 'stall', ms }], muted: null, stall: true, probe: e2ee ? undefined : { e2ee: false } });
    }
    // impaired downlink (netem on the SFU's egress), Light + gate, normal talker
    if (process.env.TC_SIDECAR) {
        s.push({ ...base, name: 'i_loss3_jitter', netem: 'delay 20ms 10ms distribution normal loss 3%', muted: [] });
        s.push({ ...base, name: 'i_burst', netem: 'delay 20ms 5ms loss gemodel 1% 25%', muted: [] });
    }
    return s;
}

interface Speech { x: Float32Array }

function pick(all: Sc[]): Sc[] {
    if (SET === 'all') return all;
    if (SET === 'matrix') return all.filter(s => s.name.startsWith('m_') || s.name.startsWith('b_'));
    if (SET === 'special') return all.filter(s => !s.name.startsWith('m_') && !s.name.startsWith('b_') && !s.name.startsWith('x_'));
    if (SET === 'stall') return all.filter(s => s.name.startsWith('x_'));
    const names = new Set(SET.split(','));
    return all.filter(s => names.has(s.name));
}

function readF32(p: string): Float32Array {
    const b = readFileSync(p); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
function writeWav16(path: string, x: Float32Array) {
    const d = Buffer.alloc(x.length * 2);
    for (let i = 0; i < x.length; i++) d.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(d.length, 40);
    writeFileSync(path, Buffer.concat([h, d]));
}

const r2 = (v: unknown) => (typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 100) / 100 : null) : v);
const pickM = (m: Metrics | null) => m && {
    speechDb: r2(m.outSpeechDb), pauseDb: r2(m.pauseNoiseDb), tailDb: r2(m.tailNoiseDb), onsetLossDb: r2(m.onsetLossDb), tailLossDb: r2(m.tailLossDb),
    cutOnsetMs: r2(m.gateOnsetMs), clipped: m.onsetsClipped, onsets: m.onsets, nucleusCutPct: r2(m.nucleusCutPct), speechCutPct: r2(m.speechCutPct),
    midClosesPerMin: r2(m.midPhraseClosesPerMin), pauseSdDb: r2(m.pauseLevelSdDb),
};

/** What the receive leveler would do if it got an RTP level per 20 ms packet (the level of the sent signal), polled every 50 ms. */
function intendedLeveler(sent: Float32Array, from: number): { gainDb: number; levelDb: number; tailRangeDb: number } {
    const lv = new ReceiveLeveler();
    const P = 960, POLL = 2400;
    const tail: number[] = [];
    for (let s = 0; s + POLL <= sent.length; s += POLL) {
        const pk = s + POLL - P;
        const rms = rmsOf(sent, pk, pk + P);
        // RFC 6464 carries -dBov in whole dB, 127 = silence
        const dbov = Math.min(127, Math.round(-linToDb(rms)));
        lv.pushLinear(Math.pow(10, -dbov / 20), POLL / SR);
        if (s >= sent.length - 20 * SR) tail.push(lv.gainDb);
        void from;
    }
    return { gainDb: lv.gainDb, levelDb: lv.levelDb, tailRangeDb: tail.length ? Math.max(...tail) - Math.min(...tail) : NaN };
}

/**
 * The live leveler (harness listener = useParticipantAudio's loop) against the intended one. `levelDb` is the leveler's
 * estimate of the talker's active-speech level: live (fed by whatever source the app used: RTP header or getStats
 * energy, rxStatsLevel.ts) minus intended (fed the RTP level of the sent signal) is the source's calibration error.
 * Gain range over the last 20 s: pumping shows up as a wide range on a talker whose level does not change.
 */
function levelerSummary(lm: Record<string, any>, intended: { gainDb: number; levelDb: number; tailRangeDb: number }): Record<string, unknown> {
    const gains: Array<[number, number, number]> = lm.gains ?? [];
    const readings: Array<[number, number, number, number, number]> = lm.readings ?? [];
    const last = readings.length ? readings[readings.length - 1] : null;
    const endFrame = gains.length ? gains[gains.length - 1][0] : 0;
    const tail = gains.filter(g => g[0] >= endFrame - 20 * SR).map(g => g[1]);
    return {
        readings: readings.length, statsReadings: readings.filter(r => r[3] === 1).length,
        appliedDb: r2(gains.length ? gains[gains.length - 1][1] : -3), intendedDb: r2(intended.gainDb),
        levelDb: r2(last ? last[4] : null), intendedLevelDb: r2(intended.levelDb),
        calErrDb: r2(last && Number.isFinite(last[4]) ? last[4] - intended.levelDb : null),
        firstMoveS: (() => { const mv = gains.find(g => Math.abs(g[1] - gains[0][1]) >= 0.5); return mv ? r2(mv[0] / SR) : null; })(),
        tailRangeDb: tail.length ? r2(Math.max(...tail) - Math.min(...tail)) : null, intendedTailRangeDb: r2(intended.tailRangeDb),
        ssrcHasAudioLevel: (lm.ssrcSample ?? []).some((s: Record<string, unknown>) => typeof s.audioLevel === 'number'),
    };
}

describe.skipIf(!ENABLED)('call audio end-to-end (real LiveKit round trip, E2EE)', () => {
    it('runs the matrix and the special cases and compares them with the offline chain', async () => {
        mkdirSync(OUT, { recursive: true });
        const speech = { x: loadSpeech() };
        const scs = pick(scenarios(speech));
        const inputs = new Map<string, { x: Float32Array; lab: SpeechLabels }>();
        mkdirSync(join(OUT, 'inputs'), { recursive: true });
        let gumWav: string | undefined;
        for (const sc of scs) {
            const inp = makeInput(speech.x, sc);
            inputs.set(sc.name, inp);
            writeFileSync(join(OUT, 'inputs', `${sc.name}.f32`), Buffer.from(inp.x.buffer));
            if (sc.source === 'gum') { gumWav = join(OUT, 'inputs', 'gum.wav'); writeWav16(gumWav, inp.x); }
        }
        // ── browser runs ──
        const recorded = (n: string) => existsSync(join(OUT, 'rec', n, 'recv_raw.f32')) && existsSync(join(OUT, 'rec', n, 'meta.json'));
        const todo = scs.filter(s => !(REUSE && recorded(s.name)));
        if (todo.length) {
            if (!process.env.LK_URL) throw new Error('LK_URL (a throwaway LiveKit, see the header)');
            const dist = join(OUT, 'dist');
            const b = spawnSync('npx', ['vite', 'build', '-c', 'harness/call-audio-e2e/vite.config.ts'], { cwd: APP, env: { ...process.env, OUT_DIR: dist }, stdio: 'inherit' });
            if (b.status !== 0) throw new Error('page build failed');
            const spec = {
                gumWav,
                scenarios: todo.map(sc => {
                    const dur = inputs.get(sc.name)!.x.length / SR;
                    return {
                        name: sc.name, source: sc.source ?? 'webaudio', input: sc.source === 'gum' ? undefined : join(OUT, 'inputs', `${sc.name}.f32`),
                        echoCancellation: sc.echoCancellation, netem: sc.netem, actions: sc.actions ?? [],
                        durationS: sc.source === 'gum' ? Math.min(dur - 6, 40) : dur + 0.5,
                        probe: sc.probe,
                        settings: { noiseSuppression: sc.ns !== 'off', noiseSuppressionMode: sc.ns === 'off' ? 'light' : sc.ns, voiceGate: sc.gate, voiceGateThreshold: -45, volumeNormalization: true, micVolume: 100 },
                    };
                }),
            };
            writeFileSync(join(OUT, 'spec.json'), JSON.stringify(spec, null, 1));
            const r = spawnSync('node', ['harness/call-audio-e2e/run.mjs', '--dist', dist, '--spec', join(OUT, 'spec.json'), '--out', join(OUT, 'rec')], { cwd: APP, env: process.env, stdio: 'inherit', timeout: 3 * 3600_000 });
            if (r.status !== 0) throw new Error(`runner exited ${r.status}`);
        }
        // ── analysis ──
        const rows: Record<string, unknown>[] = [];
        for (const sc of scs) {
            const { x, lab } = inputs.get(sc.name)!;
            if (sc.stall) { rows.push(stallRow(sc, JSON.parse(readFileSync(join(OUT, 'rec', sc.name, 'meta.json'), 'utf8')))); continue; }
            const meta = JSON.parse(readFileSync(join(OUT, 'rec', sc.name, 'meta.json'), 'utf8'));
            if (meta.error) { rows.push({ name: sc.name, error: meta.error.split('\n')[0] }); continue; }
            const pre = Math.round((sc.preS ?? 0) * SR);
            let from = sc.passes === 2 ? pre + speech.x.length : pre + 3 * SR;
            if (sc.loud) from = Math.max(from, Math.round((sc.loud.e + 1) * SR));
            // offline
            let off: Metrics | null = null, offTruth: Metrics | null = null, offOut: Float32Array | null = null;
            let offCut: ReturnType<typeof gateCutSummary> | null = null;
            if (sc.muted !== null) {
                const chain = await buildChain({ ns: sc.ns, gate: sc.gate ? 'manual' : 'off', gateThresholdDb: -45, agc: true, gateSource: GATE_WORKLET_SOURCE, muted: sc.muted ?? [] }, NS_SRC);
                const tr = chain.run(x);
                // the gate-cut meter's seconds as the gate worklet posted them offline (second i ends at i + 1 s)
                if (sc.gate) offCut = gateCutSummary(chain.gatePosted.filter(m => m.type === 'gateStats')
                    .map((m, i) => ({ sec: gateCutSecondFrom(m as never), t: i + 1 })), -45);
                const lag = sc.ns === 'off' ? 0 : findLag(x, tr.nsOut, 0, 0.1 * SR).lag;
                offTruth = score(x, lab, tr, lag, from);
                offOut = tr.out.subarray(lag);
                off = scoreAligned(x, lab, offOut, from);
            }
            // sent (the talker's processor output) and received, on the input's time axis
            const sentRaw = readF32(join(OUT, 'rec', sc.name, 'sent.f32'));
            const recvRaw = readF32(join(OUT, 'rec', sc.name, 'recv_raw.f32'));
            const heardRaw = readF32(join(OUT, 'rec', sc.name, 'recv_heard.f32'));
            const gum = sc.source === 'gum';
            const lIS = findLag(x, sentRaw, gum ? -30 * SR : 0, gum ? 5 * SR : 3 * SR).lag;
            const tIS: LagTrack = trackLag(x, sentRaw, lIS);
            const sent = alignByTrack(sentRaw, tIS, x.length);
            if (gum) from = Math.max(from, -lIS + SR);
            const to = gum ? Math.min(x.length, -lIS + sentRaw.length - SR) : x.length;
            const lSR = findLag(sent, recvRaw, -2 * SR, 10 * SR).lag;
            const tSR = trackLag(sent, recvRaw, lSR);
            const recv = alignByTrack(recvRaw, tSR, x.length);
            const heard = alignByTrack(heardRaw, tSR, x.length);
            const sub = (a: Float32Array) => (to < a.length ? a.subarray(0, to) : a);
            const xs = sub(x);
            const mSent = scoreAligned(xs, lab, sub(sent), from);
            const mHeard = scoreAligned(xs, lab, sub(heard), from);
            const rt = roundTrip(sent, recv, lab, from, to);
            const lagsMs = Array.from(tSR.lags).filter((_, w) => Number.isFinite(tSR.corr[w])).map(l => (l / SR) * 1000);
            const tm = meta.talker, lm = meta.listener;
            const chainMs = tm.srcStartWallMs != null ? tm.recStartWallMs + (lIS / SR) * 1000 - tm.srcStartWallMs : null;
            const netMs = lm.recStartWallMs - tm.recStartWallMs + ((lSR - lIS) / SR) * 1000;
            const inb = lm.inb ?? {};
            const jbMs = inb.jitterBufferEmittedCount ? (inb.jitterBufferDelay / inb.jitterBufferEmittedCount) * 1000 : null;
            const intended = intendedLeveler(sent.subarray(0, to), from);
            const row: Record<string, unknown> = {
                name: sc.name, ns: sc.ns, gate: sc.gate, talkerDb: sc.talkerDb, noise: `${sc.noise}${sc.snrDb}`,
                offlineTrueGate: pickM(offTruth), offline: pickM(off), sent: pickM(mSent), heard: pickM(mHeard),
                roundTrip: Object.fromEntries(Object.entries(rt).map(([k, v]) => [k, r2(v)])),
                latency: {
                    inputToSentMs: r2(chainMs), sentToRecvMs: r2(netMs + (lagsMs.length ? lagsMs[lagsMs.length - 1] - (lSR / SR) * 1000 : 0)),
                    sentToRecvStartMs: r2(netMs), driftMs: r2(lagsMs.length ? Math.max(...lagsMs) - Math.min(...lagsMs) : 0), jitterBufferMs: r2(jbMs),
                },
                rtp: { codec: tm.out?.codec, fmtpOut: tm.out?.fmtp, fmtpIn: inb.fmtp, kbps: r2(tm.out?.bytes ? (tm.out.bytes * 8) / 1000 / (sentRaw.length / SR) : null), lost: inb.packetsLost, discarded: inb.packetsDiscarded, recvPackets: inb.packets, sentPackets: tm.out?.packets, concealedMs: r2((inb.concealedSamples ?? 0) / 48), concealEvents: inb.concealmentEvents, fecRecv: inb.fecPacketsReceived, accelMs: r2((inb.removedSamplesForAcceleration ?? 0) / 48), decelMs: r2((inb.insertedSamplesForDeceleration ?? 0) / 48) },
                leveler: levelerSummary(lm, intended),
                underruns: { talker: tm.playback, listener: lm.playback },
                // the app's E2EE audio-lag cap (e2eeAudioLag.ts): windows where it dropped frames / re-based
                e2eeLag: { send: (tm.lagStats ?? []).filter((s: { dir: string }) => s.dir === 'send'), recv: (lm.lagStats ?? []).filter((s: { dir: string }) => s.dir === 'recv') },
                load1m: r2(meta.loadAvg?.[0]),
                // the gate-cut detector (gateCutMeter.js in the gate worklet -> onGateCut -> GateCutWatcher) live vs offline
                gateCut: sc.gate ? { live: gateCutSummary(((tm.gateCut?.secs ?? []) as Array<Record<string, number>>).map(o => ({ sec: gateCutSecondFrom({ cut: o, minDb: o.minDb }), t: o.atS })), -45), offline: offCut } : null,
                agcHeldPct: r2(100 * (tm.levelStats ?? []).reduce((a: number, s: { held: number }) => a + s.held, 0) / Math.max(1, (tm.levelStats ?? []).reduce((a: number, s: { voiced: number }) => a + s.voiced, 0))),
                errs: (meta.errs ?? []).filter((e: string) => /error|pageerror|warn/i.test(e) && !/Host AudioContext is/.test(e)).slice(0, 5),
            };
            // special-case measurements
            if (sc.name === 's_unmute60') {
                const s0 = 60 * SR, s1 = 64 * SR;
                row.special = { roomAfterUnmuteDb: { offline: r2(spanLevelDb(offOut!, s0 + 0.2 * SR, s1)), sent: r2(spanLevelDb(sent, s0 + 0.2 * SR, s1)), heard: r2(spanLevelDb(heard, s0 + 0.2 * SR, s1)) },
                    unmuteToSoundMs: r2(firstSoundMs(sent, s0, s1)) };
            }
            if (sc.ptt) {
                const byLead: Record<string, number[]> = {};
                const offBy: Record<string, number[]> = {};
                const delaysSent: number[] = [], delaysHeard: number[] = [];
                // first 80 ms of the phrase from its audible point, against the same phrase's own body (200-600 ms in)
                const onsetVsBody = (o: Float32Array, aud: number) => {
                    const e = aud + Math.round(0.08 * SR), b0 = aud + Math.round(0.2 * SR), b1 = aud + Math.round(0.6 * SR);
                    return (linToDb(rmsOf(o, aud, e)) - linToDb(rmsOf(x, aud, e))) - (linToDb(rmsOf(o, b0, b1)) - linToDb(rmsOf(x, b0, b1)));
                };
                for (const p of sc.ptt) {
                    const aud = lab.audibleAt[p.onset]; if (aud < 0) continue;
                    (byLead[p.lead] ??= []).push(Math.max(-60, onsetVsBody(heard, aud)));
                    (offBy[p.lead] ??= []).push(Math.max(-60, onsetVsBody(offOut!, aud)));
                }
                for (const a of (tm.actions ?? []) as Array<{ kind: string; at: number }>) {
                    if (a.kind !== 'unmute' || a.at < 0) continue;
                    const s0 = Math.round(a.at * SR), s1 = s0 + SR;
                    delaysSent.push(firstSoundMs(sent, s0, s1)); delaysHeard.push(firstSoundMs(heard, s0, s1));
                }
                const mean = (v: number[]) => v.reduce((p, q) => p + q, 0) / Math.max(1, v.length);
                const med = (v: number[]) => { const f = v.filter(Number.isFinite).sort((a, b) => a - b); return f.length ? f[Math.floor(f.length / 2)] : NaN; };
                row.special = { onsetVsBodyByLeadDb: Object.fromEntries(Object.entries(byLead).map(([k, v]) => [`${Math.round(Number(k) * 1000)}ms`, { heard: r2(mean(v)), offline: r2(mean(offBy[k])), n: v.length }])),
                    pressToSoundMs: { sentMedian: r2(med(delaysSent)), heardMedian: r2(med(delaysHeard)), heardMax: r2(Math.max(...delaysHeard.filter(Number.isFinite))), presses: delaysHeard.length, neverHeard: delaysHeard.filter(v => !Number.isFinite(v)).length } };
            }
            if (sc.name === 's_nsswitch') {
                const sw = ((tm.actions ?? []) as Array<{ kind: string; at: number; mode: string }>).filter(a => a.kind === 'ns');
                row.special = sw.map(a => {
                    const at = Math.round(a.at * SR);
                    return { to: a.mode, atS: r2(a.at),
                        zeroRunMs: { sent: r2(longestZeroRunMs(sent, at - 0.02 * SR, at + 0.3 * SR)), heard: r2(longestZeroRunMs(heard, at - 0.02 * SR, at + 0.3 * SR)) },
                        maxStepDb: { sent: r2(maxStepDb(sent, at - 0.02 * SR, at + 0.3 * SR)), heard: r2(maxStepDb(heard, at - 0.02 * SR, at + 0.3 * SR)), inputSame: r2(maxStepDb(x, at - 0.02 * SR, at + 0.3 * SR)) },
                        // 20 ms frame levels of sent / input across the switch (dB re input): a dip is the switch
                        sentMinusInputDb: Array.from({ length: 8 }, (_, k) => r2(spanLevelDb(sent, at + (k - 2) * 0.02 * SR, at + (k - 1) * 0.02 * SR) - spanLevelDb(x, at + (k - 2) * 0.02 * SR, at + (k - 1) * 0.02 * SR))),
                        levelBeforeAfterDb: { sent: [r2(spanLevelDb(sent, at - 2 * SR, at)), r2(spanLevelDb(sent, at, at + 2 * SR))], heard: [r2(spanLevelDb(heard, at - 2 * SR, at)), r2(spanLevelDb(heard, at, at + 2 * SR))] } };
                });
            }
            if (sc.loud) {
                const ls = Math.round(sc.loud.e * SR);
                row.special = { speechAfterShoutDb: { offline: r2(off?.outSpeechDb), sent: r2(mSent.outSpeechDb), heard: r2(mHeard.outSpeechDb) },
                    peakHeard: r2(Math.max(...Array.from(heard.subarray(ls - SR, ls + SR)).map(Math.abs))) };
            }
            if (sc.noise === 'fan' || sc.noise === 'hiss') {
                // residual-noise character in the longest pause of the scored part: received vs sent
                let best = 0, bs = 0, run = 0, rs = 0;
                for (let f = Math.ceil(from / 240); f < lab.frame.length && f * 240 < to; f++) {
                    if (lab.distToSpeech[f] >= 0.15 * SR) { if (!run) rs = f; run++; if (run > best) { best = run; bs = rs; } } else run = 0;
                }
                row.pauseFluctDb = { sent: r2(spectralFluctuationDb(sent, bs * 240, (bs + best) * 240)), heard: r2(spectralFluctuationDb(heard, bs * 240, (bs + best) * 240)), pauseS: r2((best * 240) / SR) };
            }
            rows.push(row);
            // listening samples: sent vs received, 10 s of the scored part
            if (WAVS && sc.name === 'm_light_gate_t45') {
                mkdirSync(WAVS, { recursive: true });
                const s0 = from + 5 * SR, s1 = s0 + 10 * SR;
                writeWav16(join(WAVS, '01-input-quiet-talker-fan-room.wav'), x.subarray(s0, s1));
                writeWav16(join(WAVS, '02-SENT-light-gate-quiet-talker.wav'), sent.subarray(s0, s1));
                writeWav16(join(WAVS, '03-RECEIVED-as-heard-light-gate-quiet-talker.wav'), heard.subarray(s0, s1));
                writeWav16(join(WAVS, '04-RECEIVED-decoded-before-leveler-light-gate-quiet-talker.wav'), recv.subarray(s0, s1));
            }
            if (WAVS && sc.name === 'm_light_gate_t30') {
                const s0 = from + 5 * SR, s1 = s0 + 10 * SR;
                writeWav16(join(WAVS, '05-SENT-light-gate-normal-talker.wav'), sent.subarray(s0, s1));
                writeWav16(join(WAVS, '06-RECEIVED-as-heard-light-gate-normal-talker.wav'), heard.subarray(s0, s1));
            }
            if (WAVS && sc.name === 'i_burst') {
                const s0 = from, s1 = s0 + 10 * SR;
                writeWav16(join(WAVS, '07-SENT-burst-loss-run.wav'), sent.subarray(s0, s1));
                writeWav16(join(WAVS, '08-RECEIVED-burst-loss-run.wav'), heard.subarray(s0, s1));
            }
            console.log(JSON.stringify(row));
        }
        writeFileSync(join(OUT, 'results.json'), JSON.stringify(rows, null, 1));
        writeFileSync(join(OUT, 'results.md'), table(rows));
        console.log(table(rows));
    });
});

/**
 * The gate-cut decision over a call's seconds, as useGateCutPrompt.ts makes it: every voiced second into a
 * GateCutWatcher, judged from GC_MIN_CALL_SEC into the call. Totals of the meter's counts alongside.
 */
function gateCutSummary(items: Array<{ sec: GateCutSecond | null; t: number }>, thr: number) {
    const w = new GateCutWatcher();
    let first: number | null = null, hits = 0, judged = 0, last: GateCutDetection | null = null;
    const tot = { voiced: 0, gated: 0, starts: 0, clipped: 0, closes: 0 };
    for (const { sec, t } of items) {
        if (!sec) continue;
        // the processor publishes (and the prompt hook decides on) voiced seconds only
        if (!(sec.voiced > 0)) continue;
        w.push(sec);
        tot.voiced += sec.voiced; tot.gated += sec.gated; tot.starts += sec.starts; tot.clipped += sec.clipped; tot.closes += sec.closes;
        if (t < GC_MIN_CALL_SEC) continue;
        const d = w.decide(thr);
        judged++;
        if (d) { hits++; last = d; if (first === null) first = t; }
    }
    return {
        voicedSec: r2(tot.voiced * GC_BLOCK_SEC), gatedPct: r2(tot.voiced ? (100 * tot.gated) / tot.voiced : 0),
        starts: tot.starts, clippedPct: r2(tot.starts ? (100 * tot.clipped) / tot.starts : 0),
        firstTriggerS: r2(first), triggeredPct: r2(judged ? (100 * hits) / judged : 0), suggestDb: last ? r2(last.suggestDb) : null,
    };
}

/**
 * Capture-stall rows: a fan room with no gate and no NS keeps the received signal continuously above -70 dBFS, so every
 * 10 ms frame of the decoded track below that (between its first and last sound) is audio the listener lost.
 */
function stallRow(sc: Sc, meta: Record<string, any>): Record<string, unknown> { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (meta.error) return { name: sc.name, error: String(meta.error).split('\n')[0] };
    const recv = readF32(join(OUT, 'rec', sc.name, 'recv_raw.f32'));
    const F = 480; let first = -1, last = -1;
    for (let s = 0; s + F <= recv.length; s += F) if (linToDb(rmsOf(recv, s, s + F)) > -70) { if (first < 0) first = s; last = s; }
    let lost = 0, run = 0, longest = 0; const gaps: string[] = [];
    for (let s = first; s >= 0 && s <= last; s += F) {
        if (linToDb(rmsOf(recv, s, s + F)) <= -70) { lost += 10; run += 10; } else { if (run >= 100) gaps.push(`${r2((s - run * 48) / SR)}s+${run}ms`); longest = Math.max(longest, run); run = 0; }
    }
    const inb = meta.listener?.inb ?? {};
    return { name: sc.name, stall: true, e2ee: sc.probe?.e2ee !== false, stallMs: sc.actions?.find(a => a.kind === 'stall')?.ms,
        lostMs: lost, longestGapMs: longest, gaps, concealedMs: r2((inb.concealedSamples ?? 0) / 48), packetsLost: inb.packetsLost,
        e2eeLag: { send: (meta.talker?.lagStats ?? []).filter((s: { dir: string }) => s.dir === 'send'), recv: (meta.listener?.lagStats ?? []).filter((s: { dir: string }) => s.dir === 'recv') },
        load1m: r2(meta.loadAvg?.[0]) };
}

function firstSoundMs(x: Float32Array, s: number, e: number): number {
    for (let i = Math.max(0, s); i < Math.min(x.length, e); i++) if (Math.abs(x[i]) > 1e-5) return ((i - s) / SR) * 1000;
    return NaN;
}


function table(rows: Record<string, unknown>[]): string {
    const L: string[] = [];
    L.push('| scenario | speech dBFS off/sent/heard | pause dBFS off/sent/heard | onset loss dB off/heard | tail loss dB off/heard | cut onset ms off/heard | clipped off/heard | nucleus cut % off/heard | dropouts (ms) | concealed ms | segSNR dB | lat in->sent / sent->recv ms | drift ms | leveler applied / intended dB | talker level live / intended (cal err) dB, last-20s gain range |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows as Array<Record<string, any>>) { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (r.error) { L.push(`| ${r.name} | ERROR ${r.error} |`); continue; }
        if (r.stall) { L.push(`| ${r.name} | capture stall ${r.stallMs} ms, E2EE ${r.e2ee ? 'on' : 'off'}: listener lost ${r.lostMs} ms (longest ${r.longestGapMs} ms), concealed ${r.concealedMs} ms, packets lost ${r.packetsLost} |`); continue; }
        const o = r.offline ?? {}, s = r.sent ?? {}, h = r.heard ?? {}, rt = r.roundTrip, la = r.latency;
        L.push(`| ${r.name} | ${o.speechDb ?? '-'} / ${s.speechDb} / ${h.speechDb} | ${o.pauseDb ?? '-'} / ${s.pauseDb} / ${h.pauseDb} | ${o.onsetLossDb ?? '-'} / ${h.onsetLossDb} | ${o.tailLossDb ?? '-'} / ${h.tailLossDb} | ${o.cutOnsetMs ?? '-'} / ${h.cutOnsetMs} | ${o.clipped ?? '-'} / ${h.clipped} of ${h.onsets} | ${o.nucleusCutPct ?? '-'} / ${h.nucleusCutPct} | ${rt.dropouts} (${rt.dropoutMs}) | ${r.rtp.concealedMs} | ${rt.segSnrDb} | ${la.inputToSentMs} / ${la.sentToRecvMs} | ${la.driftMs} | ${r.leveler.appliedDb} / ${r.leveler.intendedDb} | ${r.leveler.levelDb} / ${r.leveler.intendedLevelDb} (${r.leveler.calErrDb}), ${r.leveler.tailRangeDb} (intended ${r.leveler.intendedTailRangeDb}) |`);
    }
    return L.join('\n') + '\n';
}
