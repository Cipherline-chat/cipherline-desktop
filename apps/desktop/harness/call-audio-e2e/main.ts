/**
 * Call audio end-to-end harness page (driven by src/audio/audit/callAudioE2E.sweep.test.ts).
 *
 * One page is the TALKER or the LISTENER of a real LiveKit room with the app's E2EE on.
 * Everything on the audio path is the app's own code, imported from src/:
 *   talker:   room options as CallPane.tsx (dtx off, red off, 64 kbps mic preset), RotatingKeyProvider +
 *             installE2EEKey + the app's E2EE worker (stableE2EEOptions), the mic published as the
 *             Microphone source and the voice processor attached by voiceProcessorManager.bindMicTrack
 *             (the app's MicProcessorBridge path: guard AudioContext, CipherlineVoiceProcessor with the
 *             real RNNoise / Speex / gate / AGC worklets); mute and push-to-talk through
 *             localParticipant.setMicrophoneEnabled exactly as SidebarConference.tsx; NS mode changes
 *             through voiceProcessorManager.updateSettings.
 *   listener: subscribes, attaches the track to an <audio> element (as the app does) and records the
 *             decoded remote track sample by sample through an AudioWorklet. The "Normalize voice volume"
 *             leveler runs the app's loop (useParticipantAudio.ts pollLevelers: tallyRxPoll on
 *             getSynchronizationSources every LEVELER_POLL_MS, ReceiveLeveler.pushLinear, the boost latch)
 *             and its gain is applied to channel 1 of the recording; channel 0 is the decoded track as is.
 *
 * The talker's mic is either a WebAudio buffer source (exact level, scripted timeline) or getUserMedia on
 * Chromium's fake capture device (--use-file-for-fake-audio-capture) with the app's micCaptureConstraints.
 * The talker also records the processor's OUTPUT node (what goes into the encoder) in the processor's own
 * AudioContext, so "what the round trip adds" is measured against what was actually sent.
 */
import { Room, RoomEvent, Track, LocalAudioTrack, RemoteAudioTrack, type RoomOptions, type RemoteTrack } from 'livekit-client';
import e2eeWorkerUrl from '../../src/workers/e2eeWorker?worker&url';
import { stableE2EEOptions } from '../../src/utils/e2eeRoomOptions';
import { installE2EEKey } from '../../src/utils/e2eeActivation';
import { RotatingKeyProvider } from '../../src/utils/e2eeKeyRing';
import * as vpm from '../../src/utils/voiceProcessorManager';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../../src/hooks/useVoiceSettings';
import { micCaptureConstraints } from '../../src/utils/audioInput';
import { ReceiveLeveler, dbToLinear, stepBoostLatch } from '../../src/audio/receiveLeveler.js';
import { LEVELER_POLL_MS, boostNeedsWebAudio } from '../../src/utils/incomingLeveler';
import { newRxPollTally } from '../../src/utils/rxLevelLog';
import { newRxLevelPoll, pollRxLevel, type RxLevelSrc } from '../../src/utils/rxStatsLevel';
import { audioLagStatsFromMessage } from '../../src/utils/e2eeAudioLag';

const lagStats: Array<Record<string, unknown>> = [];

type Row = Record<string, unknown>;

// SDP header extensions seen on this page (does the audio-level extension survive the SFU?).
const extmap = new Set<string>();
for (const m of ['setRemoteDescription', 'setLocalDescription'] as const) {
    const orig = RTCPeerConnection.prototype[m] as (this: RTCPeerConnection, d?: RTCSessionDescriptionInit) => Promise<void>;
    (RTCPeerConnection.prototype as unknown as Record<string, unknown>)[m] = function (this: RTCPeerConnection, d?: RTCSessionDescriptionInit) {
        let audio = false;
        for (const line of (d?.sdp ?? '').split('\r\n')) {
            if (line.startsWith('m=')) audio = line.startsWith('m=audio');
            if (audio && line.startsWith('a=extmap')) extmap.add(`${m === 'setRemoteDescription' ? 'remote' : 'local'} ${d?.type} ${line}`);
        }
        return orig.call(this, d);
    };
}
const logs: Row[] = [];
const log = (m: string, extra: Row = {}) => { logs.push({ t: Date.now(), m, ...extra }); console.info(`harness: ${m}`); };

/** CallPane.tsx roomOptions (audio-relevant part; no video is published here). */
function roomOptions(keyProvider: RotatingKeyProvider | null, worker: Worker | null, probe: ProbeOpts): RoomOptions {
    return {
        // probe only (default: livekit-client's own default, as the app)
        ...(probe.singlePC !== undefined ? { singlePeerConnection: probe.singlePC } : {}),
        adaptiveStream: false,
        dynacast: true,
        publishDefaults: { simulcast: true, red: false, dtx: false, audioPreset: { maxBitrate: 64_000 } },
        ...(keyProvider && worker ? { encryption: stableE2EEOptions(keyProvider, worker) } : {}),
    };
}

/** Diagnostics only: run without E2EE / with a different peer-connection mode, to locate a difference. */
export interface ProbeOpts { e2ee?: boolean; singlePC?: boolean }
let probe: ProbeOpts = {};

async function joinRoom(url: string, token: string, keyB64: string, onSub?: (t: RemoteTrack) => void): Promise<Room> {
    const e2ee = probe.e2ee !== false;
    const keyProvider = e2ee ? new RotatingKeyProvider() : null;
    const worker = e2ee ? new Worker(e2eeWorkerUrl, { type: 'module' }) : null;
    // The app's audio-lag cap reports (e2eeAudioLag.ts): frames it dropped / re-bases, per 10 s window.
    worker?.addEventListener('message', ev => { const s = audioLagStatsFromMessage(ev.data); if (s) lagStats.push({ t: Date.now(), ...s }); });
    const room = new Room(roomOptions(keyProvider, worker, probe));
    if (keyProvider) await installE2EEKey(keyProvider, keyB64);
    if (onSub) room.on(RoomEvent.TrackSubscribed, t => onSub(t));
    room.on(RoomEvent.EncryptionError, e => log(`encryption error: ${String((e as Error)?.message ?? e).slice(0, 160)}`));
    room.on(RoomEvent.Disconnected, r => log(`disconnected ${String(r)}`));
    room.on(RoomEvent.Reconnecting, () => log('reconnecting'));
    // CallPane: rtcConfig iceServers [] (the SFU's own candidates only).
    await room.connect(url, token, { rtcConfig: { iceServers: [] } });
    if (e2ee) await room.setE2EEEnabled(true);
    log('joined', { e2ee: room.isE2EEEnabled });
    return room;
}

// ── Recorder worklet ───────────────────────────────────────────────────────
const RECORDER_SRC = `
class Rec extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.ch = (o.processorOptions && o.processorOptions.channels) || 1;
    this.on = false; this.buf = []; this.n = 0; this.CH = 128 * 188;
    for (let c = 0; c < this.ch; c++) this.buf.push(new Float32Array(this.CH));
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.startFrame = currentFrame; this.port.postMessage({ type: 'started', frame: currentFrame }); }
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ type: 'stopped', frame: currentFrame }); }
    };
  }
  flush() {
    if (!this.n) return;
    const out = this.buf.map(b => b.slice(0, this.n));
    this.port.postMessage({ type: 'chunk', data: out }, out.map(a => a.buffer));
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) return true;
    const inp = inputs[0];
    const len = 128;
    for (let c = 0; c < this.ch; c++) {
      const src = inp && inp[c] ? inp[c] : (inp && inp[0] ? inp[0] : null);
      if (src) this.buf[c].set(src, this.n); else this.buf[c].fill(0, this.n, this.n + len);
    }
    this.n += len;
    if (this.n >= this.CH) this.flush();
    return true;
  }
}
registerProcessor('cl-e2e-recorder', Rec);
`;
const recUrl = URL.createObjectURL(new Blob([RECORDER_SRC], { type: 'application/javascript' }));
const recModuleLoaded = new WeakSet<BaseAudioContext>();

interface Recorder {
    start(): Promise<{ frame: number; wallMs: number }>;
    stop(): Promise<Float32Array[]>;
}

/** Wall-clock ms (shared epoch across pages) at which the context renders `frame`. */
function frameToWallMs(ctx: AudioContext, frame: number): number {
    const ts = ctx.getOutputTimestamp();
    const ctxT = ts.contextTime ?? ctx.currentTime;
    const perfT = ts.performanceTime ?? performance.now();
    return performance.timeOrigin + perfT + (frame / ctx.sampleRate - ctxT) * 1000;
}

async function makeRecorder(ctx: AudioContext, src: AudioNode, channels: number): Promise<Recorder> {
    if (!recModuleLoaded.has(ctx)) { await ctx.audioWorklet.addModule(recUrl); recModuleLoaded.add(ctx); }
    const node = new AudioWorkletNode(ctx, 'cl-e2e-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: channels, channelCountMode: 'explicit', processorOptions: { channels } });
    src.connect(node);
    // keep it pulled: a worklet with no path to the destination may not be rendered
    const sink = ctx.createGain(); sink.gain.value = 0; node.connect(sink); sink.connect(ctx.destination);
    const chunks: Float32Array[][] = [];
    let onStarted: ((f: number) => void) | null = null, onStopped: (() => void) | null = null;
    node.port.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'chunk') chunks.push(d.data);
        if (d.type === 'started') onStarted?.(d.frame);
        if (d.type === 'stopped') onStopped?.();
    };
    return {
        async start() {
            const frame = await new Promise<number>(r => { onStarted = r; node.port.postMessage('start'); });
            return { frame, wallMs: frameToWallMs(ctx, frame) };
        },
        async stop() {
            await new Promise<void>(r => { onStopped = r; node.port.postMessage('stop'); });
            const out: Float32Array[] = [];
            for (let c = 0; c < channels; c++) {
                const n = chunks.reduce((a, ch) => a + ch[c].length, 0);
                const a = new Float32Array(n); let o = 0;
                for (const ch of chunks) { a.set(ch[c], o); o += ch[c].length; }
                out.push(a);
            }
            return out;
        },
    };
}

async function upload(path: string, data: Float32Array) {
    const r = await fetch(`/upload/${path}`, { method: 'POST', body: data.buffer as ArrayBuffer });
    if (!r.ok) throw new Error(`upload ${path}: ${r.status}`);
}

function playbackStats(ctx: AudioContext | undefined): Row | null {
    const ps = (ctx as unknown as { playbackStats?: Record<string, number> } | undefined)?.playbackStats;
    if (!ps) return null;
    return { underrunDuration: ps.underrunDuration, underrunEvents: ps.underrunEvents, totalDuration: ps.totalDuration, maxLatency: ps.maximumLatency };
}

async function rtpStats(track: { getRTCStatsReport(): Promise<RTCStatsReport | undefined> } | undefined, kind: 'outbound-rtp' | 'inbound-rtp'): Promise<Row> {
    const rep = await track?.getRTCStatsReport();
    if (!rep) return {};
    const out: Row = {};
    const codecs = new Map<string, Row>();
    rep.forEach((s: Row & { type: string; id: string }) => { if (s.type === 'codec') codecs.set(s.id, s); });
    rep.forEach((s: Row & { type: string; kind?: string; codecId?: string }) => {
        if (s.type !== kind || s.kind !== 'audio') return;
        const c = s.codecId ? codecs.get(s.codecId) : undefined;
        Object.assign(out, {
            codec: c?.mimeType, fmtp: c?.sdpFmtpLine, packets: s.packetsSent ?? s.packetsReceived, bytes: s.bytesSent ?? s.bytesReceived,
            packetsLost: s.packetsLost, packetsDiscarded: s.packetsDiscarded, jitter: s.jitter, fecPacketsReceived: s.fecPacketsReceived, fecPacketsDiscarded: s.fecPacketsDiscarded,
            concealedSamples: s.concealedSamples, silentConcealedSamples: s.silentConcealedSamples, concealmentEvents: s.concealmentEvents,
            insertedSamplesForDeceleration: s.insertedSamplesForDeceleration, removedSamplesForAcceleration: s.removedSamplesForAcceleration,
            totalSamplesReceived: s.totalSamplesReceived, jitterBufferDelay: s.jitterBufferDelay, jitterBufferEmittedCount: s.jitterBufferEmittedCount,
            jitterBufferTargetDelay: s.jitterBufferTargetDelay, jitterBufferMinimumDelay: s.jitterBufferMinimumDelay, audioLevel: s.audioLevel,
            totalAudioEnergy: s.totalAudioEnergy, totalSamplesDuration: s.totalSamplesDuration,
            targetBitrate: s.targetBitrate, retransmittedPacketsSent: s.retransmittedPacketsSent, nackCount: s.nackCount,
        });
    });
    return out;
}

// ── Talker ─────────────────────────────────────────────────────────────────

export interface TalkerAction { t: number; kind: 'mute' | 'unmute' | 'ns' | 'gate' | 'stall'; mode?: 'off' | 'light' | 'strong'; on?: boolean; ms?: number }
export interface TalkerOpts {
    url: string; token: string; keyB64: string; scenario: string;
    settings: Partial<VoiceSettings>;
    source: 'webaudio' | 'gum';
    inputUrl?: string; echoCancellation?: boolean;
    actions: TalkerAction[];
    /** Seconds to play/record. */
    durationS: number;
    probe?: ProbeOpts;
}

let gateCut: { secs: Row[]; t0: number } = { secs: [], t0: 0 };
let talker: { room: Room; srcCtx?: AudioContext; buffer?: AudioBuffer; rec?: Recorder; track?: LocalAudioTrack; settings: VoiceSettings; levelStats: Row[]; renders: Row[]; opts: TalkerOpts } | null = null;

async function prepareTalker(o: TalkerOpts) {
    probe = o.probe ?? {};
    const room = await joinRoom(o.url, o.token, o.keyB64);
    const settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, ...o.settings };
    const levelStats: Row[] = []; const renders: Row[] = [];
    // The gate-cut detector's live input: every second the processor publishes through onGateCut (what
    // useGateCutPrompt.ts feeds its GateCutWatcher), stamped with the time since the input started.
    gateCut = { secs: [], t0: Date.now() };

    vpm.updateCallbacks({
        onMicLevelStats: s => levelStats.push({ t: Date.now(), ...s }),
        onAudioRender: w => renders.push({ t: Date.now(), ...w }),
        onNsUnavailable: () => log('NS unavailable'),
        onNsLoadFallback: i => log('NS load fallback', i as unknown as Row),
        onGateCut: sec => { gateCut.secs.push({ ...sec, atS: (Date.now() - gateCut.t0) / 1000 } as unknown as Row); },
    });
    let mst: MediaStreamTrack;
    let srcCtx: AudioContext | undefined; let buffer: AudioBuffer | undefined;
    if (o.source === 'webaudio') {
        srcCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        const raw = new Float32Array(await (await fetch(o.inputUrl!)).arrayBuffer());
        buffer = srcCtx.createBuffer(1, raw.length, 48000);
        buffer.copyToChannel(raw, 0);
        const dest = srcCtx.createMediaStreamDestination();
        dest.channelCount = 1;
        (srcCtx as unknown as { _dest: MediaStreamAudioDestinationNode })._dest = dest;
        mst = dest.stream.getAudioTracks()[0];
    } else {
        const ms = await navigator.mediaDevices.getUserMedia({ audio: { ...micCaptureConstraints(!!o.echoCancellation) } });
        mst = ms.getAudioTracks()[0];
        log('gum settings', mst.getSettings() as unknown as Row);
    }
    const pub = await room.localParticipant.publishTrack(mst, { source: Track.Source.Microphone });
    const track = pub.track as LocalAudioTrack;
    // CallPane's MicProcessorBridge → voiceProcessorManager.bindMicTrack (guard context + processor).
    await vpm.bindMicTrack(`e2e-${o.scenario}`, track, settings);
    const proc = vpm.getCurrentProcessor();
    if (!proc?.outputNode) throw new Error('voice processor did not attach');
    const pctx = proc.outputNode.context as AudioContext;
    if (pctx.state !== 'running') await pctx.resume().catch(() => {});
    if (srcCtx && srcCtx.state !== 'running') await srcCtx.resume().catch(() => {});
    const rec = await makeRecorder(pctx, proc.outputNode, 1);
    talker = { room, srcCtx, buffer, rec, track, settings, levelStats, renders, opts: o };
    log('talker ready', { plan: proc.chainPlan as unknown as Row, ctxRate: pctx.sampleRate, baseLatency: pctx.baseLatency });
    return { plan: proc.chainPlan, ctxRate: pctx.sampleRate, srcRate: srcCtx?.sampleRate ?? null };
}

async function applyAction(a: TalkerAction) {
    const t = talker!;
    if (a.kind === 'mute') await t.room.localParticipant.setMicrophoneEnabled(false);
    else if (a.kind === 'unmute') await t.room.localParticipant.setMicrophoneEnabled(true);
    else if (a.kind === 'ns') {
        t.settings = { ...t.settings, noiseSuppression: a.mode !== 'off', noiseSuppressionMode: a.mode === 'off' ? t.settings.noiseSuppressionMode : a.mode! };
        vpm.updateSettings(t.settings);
    } else if (a.kind === 'stall') {
        // A capture stall of `ms` (what a CPU-starved audio thread, a device restart or the processor attach does):
        // the context that feeds the published track stops rendering, so the track delivers no samples for that long.
        const c = vpm.getCurrentProcessor()?.outputNode?.context as AudioContext | undefined;
        if (c) { await c.suspend(); await new Promise(r => setTimeout(r, a.ms ?? 500)); await c.resume(); }
    } else if (a.kind === 'gate') {
        t.settings = { ...t.settings, voiceGate: !!a.on };
        vpm.updateSettings(t.settings);
    }
}

/** Play the input (or let the fake device run) for durationS while recording the processor output. */
async function runTalker() {
    const t = talker!; const o = t.opts;
    const recStart = await t.rec!.start();
    gateCut.secs = []; gateCut.t0 = Date.now();
    const done: Row[] = [];
    let srcStartWallMs: number | null = null;
    let clock: () => number;
    // Actions with t < 0 happen before the input starts (e.g. "muted for the first 60 s").
    for (const a of o.actions.filter(a => a.t < 0)) { await applyAction(a); done.push({ ...a, at: -1 }); }
    if (t.srcCtx && t.buffer) {
        const ctx = t.srcCtx;
        const node = ctx.createBufferSource(); node.buffer = t.buffer;
        node.connect((ctx as unknown as { _dest: MediaStreamAudioDestinationNode })._dest);
        const when = ctx.currentTime + 0.2;
        node.start(when);
        srcStartWallMs = frameToWallMs(ctx, Math.round(when * ctx.sampleRate));
        clock = () => ctx.currentTime - when;
    } else {
        const t0 = performance.now();
        clock = () => (performance.now() - t0) / 1000;
    }
    const pending = o.actions.filter(a => a.t >= 0).sort((a, b) => a.t - b.t);
    while (clock() < o.durationS) {
        while (pending.length && clock() >= pending[0].t) {
            const a = pending.shift()!;
            const at = clock();
            await applyAction(a);
            done.push({ ...a, at, after: clock() });
        }
        await new Promise(r => setTimeout(r, 4));
    }
    const [sent] = await t.rec!.stop();
    await upload(`${o.scenario}/sent.f32`, sent);
    const proc = vpm.getCurrentProcessor();
    const pctx = proc?.outputNode?.context as AudioContext | undefined;
    return {
        recStartWallMs: recStart.wallMs, srcStartWallMs, sentSamples: sent.length, actions: done,
        out: await rtpStats(t.track, 'outbound-rtp'), playback: playbackStats(pctx), srcPlayback: playbackStats(t.srcCtx),
        levelStats: t.levelStats, renders: t.renders, logs, sdpAudioExt: [...extmap], lagStats, gateCut,
    };
}

async function stopTalker() {
    if (!talker) return;
    try { await vpm.destroyForCall(`e2e-${talker.opts.scenario}`); } catch { /* ignore */ }
    await talker.room.disconnect();
    try { await talker.srcCtx?.close(); } catch { /* ignore */ }
    talker = null;
}

// ── Listener ───────────────────────────────────────────────────────────────

let listener: { room: Room; ctx?: AudioContext; rec?: Recorder; gain?: GainNode; gains: Array<[number, number, number]>; readings: Array<[number, number, number, number, number]>; timer?: ReturnType<typeof setInterval>; track?: RemoteAudioTrack; extmap?: string[]; subscribed: Promise<void>; recStartFrame: number; el?: HTMLMediaElement } | null = null;

async function startListener(o: { url: string; token: string; keyB64: string; leveler: boolean; probe?: ProbeOpts }) {
    probe = o.probe ?? {};
    let resolveSub!: () => void;
    const subscribed = new Promise<void>(r => { resolveSub = r; });
    const state = { room: null as unknown as Room, gains: [] as Array<[number, number, number]>, readings: [] as Array<[number, number, number, number, number]>, subscribed, recStartFrame: 0 } as NonNullable<typeof listener>;
    listener = state;
    const onSub = async (t: RemoteTrack) => {
        if (t.kind !== Track.Kind.Audio || t.source !== Track.Source.Microphone) return;
        const track = t as RemoteAudioTrack;
        // The app plays a remote mic through an attached <audio> element (useParticipantAudio 'element' path).
        const el = track.attach(); el.volume = 1; document.body.appendChild(el); state.el = el; state.track = track;
        const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        if (ctx.state !== 'running') await ctx.resume().catch(() => {});
        const src = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        const gain = ctx.createGain();
        const merger = ctx.createChannelMerger(2);
        src.connect(merger, 0, 0);
        src.connect(gain); gain.connect(merger, 0, 1);
        state.ctx = ctx; state.gain = gain;
        state.rec = await makeRecorder(ctx, merger, 2);
        if (o.leveler) {
            // useParticipantAudio.ts pollLevelers / applyLevelReading + resetLeveler(applied = true), one talker:
            // the same level source (rxStatsLevel.pollRxLevel: RTP header level, else getStats energy).
            const leveler = new ReceiveLeveler();
            let tally = newRxPollTally();
            const rxPoll = newRxLevelPoll();
            let lastPoll = 0, levelGainDb = leveler.gainDb, boostAccum = 0, latched = false;
            const apply = (db: number) => {
                const lin = dbToLinear(db);
                // 'element' path: element.volume tops out at 1, so a boost is only heard once latched onto Web Audio.
                gain.gain.value = latched ? lin : Math.min(1, lin);
            };
            apply(levelGainDb);
            const onReading = (db: number, dt: number, src: RxLevelSrc) => {
                const gainDb = leveler.push(db, dt);
                if (Math.abs(gainDb - levelGainDb) >= 0.05) { levelGainDb = gainDb; apply(gainDb); }
                if (!latched) {
                    const step = stepBoostLatch(boostAccum, boostNeedsWebAudio(1, 1, gainDb), dt);
                    boostAccum = step.accumSec;
                    if (step.latched) { latched = true; apply(levelGainDb); log('leveler boost latched (web audio path)'); }
                }
                const frame = Math.round(ctx.currentTime * 48000) - state.recStartFrame;
                state.gains.push([frame, gainDb, latched ? 1 : 0]);
                state.readings.push([frame, Math.round(db * 100) / 100, Math.round(dt * 1000) / 1000, src === 'rtp' ? 0 : 1, Math.round(leveler.levelDb * 100) / 100]);
            };
            state.timer = setInterval(() => {
                const now = performance.now();
                const receiver = track.receiver;
                if (!receiver) return;
                const dt = lastPoll > 0 ? Math.min(0.5, (now - lastPoll) / 1000) : LEVELER_POLL_MS / 1000;
                lastPoll = now;
                pollRxLevel(receiver, rxPoll, () => tally, now, dt, onReading);
                if (tally.polls > 1000) tally = newRxPollTally();
            }, LEVELER_POLL_MS);
        }
        resolveSub();
    };
    state.room = await joinRoom(o.url, o.token, o.keyB64, t => { void onSub(t); });
    // already-published tracks
    for (const p of state.room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) if (pub.track) void onSub(pub.track as RemoteTrack);
    return true;
}

async function listenerRecord() {
    const l = listener!;
    await l.subscribed;
    const r = await l.rec!.start();
    l.recStartFrame = r.frame;
    l.gains.length = 0;
    l.readings.length = 0;
    return { recStartWallMs: r.wallMs };
}

async function listenerStop(scenario: string) {
    const l = listener!;
    const [raw, heard] = await l.rec!.stop();
    await upload(`${scenario}/recv_raw.f32`, raw);
    await upload(`${scenario}/recv_heard.f32`, heard);
    return { samples: raw.length, gains: l.gains.slice(), readings: l.readings.slice(), inb: await rtpStats(l.track, 'inbound-rtp'), ssrcSample: l.track?.receiver?.getSynchronizationSources(), sdpAudioExt: [...extmap], playback: playbackStats(l.ctx), logs, lagStats };
}

async function stopListener() {
    if (!listener) return;
    if (listener.timer) clearInterval(listener.timer);
    await listener.room.disconnect();
    try { await listener.ctx?.close(); } catch { /* ignore */ }
    listener.el?.remove();
    listener = null;
}

(window as unknown as { H: unknown }).H = { prepareTalker, runTalker, stopTalker, startListener, listenerRecord, listenerStop, stopListener, logs: () => logs };
(window as unknown as { HREADY: boolean }).HREADY = true;
