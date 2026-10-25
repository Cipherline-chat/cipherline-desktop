/**
 * Screen-share end-to-end harness page (see README.md). One page is either
 * the PUBLISHER (a 2560x1440 WebGL canvas published as a screen share with
 * the app's own publish options, sender params and lighter-copy gate) or the
 * VIEWER (subscribes like a focused fullscreen tile — the app's arbiter +
 * pickShareLayer — with the app's CallEventMonitor, i.e. the share loss
 * fallback, running). Everything that decides layers, bitrates and fallbacks
 * is imported from src/ — nothing here reimplements it.
 *
 * window.H is driven by run.mjs (Playwright).
 */
import { createRoot } from 'react-dom/client';
import { RoomContext } from '@livekit/components-react';
import {
    Room, RoomEvent, Track, LocalVideoTrack, LocalAudioTrack, ExternalE2EEKeyProvider,
    VideoPreset, RemoteVideoTrack, RemoteAudioTrack, type RemoteTrackPublication, type RoomOptions,
} from 'livekit-client';
import e2eeWorkerUrl from '../../src/workers/e2eeWorker?worker&url';
import { stableE2EEOptions } from '../../src/utils/e2eeRoomOptions';
import { installE2EESenderCodecPin, type CodecPinRoom } from '../../src/utils/e2eeSenderCodec';
import { installE2EEKey } from '../../src/utils/e2eeActivation';
import { buildScreenSharePublishOptions, applyScreenShareSenderParams, type ScreenShareCodec } from '../../src/utils/screenShare';
import { installShareLowLayerControl, type ShareTrackLike } from '../../src/utils/shareLowLayer';
import { claimRemoteQuality, pickShareLayer, normaliseLayers, displayedPixels, appliedQuality, claimedQuality, type QualityClaim } from '../../src/utils/remoteVideoQuality';
import { CallEventMonitor } from '../../src/components/call/CallEventMonitor';
import { setCallEventTap, logCallEvent } from '../../src/utils/callEventLog';

type Row = Record<string, unknown>;
const samples: Row[] = [];
const events: Row[] = [];
setCallEventTap((kind, detail) => { events.push({ t: Date.now(), kind, ...(detail ?? {}) }); });
const log = (m: string) => { events.push({ t: Date.now(), kind: 'harness_log', m }); console.info(m); };

/** The app's room options (CallPane.tsx roomOptions), minus device ids. */
function roomOptions(keyProvider: ExternalE2EEKeyProvider | null, worker: Worker | null): RoomOptions {
    return {
        adaptiveStream: false,
        dynacast: true,
        publishDefaults: {
            simulcast: true,
            videoSimulcastLayers: [new VideoPreset(320, 180, 200_000, 30), new VideoPreset(640, 360, 600_000, 30)],
            red: false,
            dtx: false,
            audioPreset: { maxBitrate: 64_000 },
        },
        ...(keyProvider && worker ? { encryption: stableE2EEOptions(keyProvider, worker) } : {}),
    };
}

async function joinRoom(url: string, token: string, keyB64: string | null, beforeConnect?: (room: Room) => void): Promise<{ room: Room; worker: Worker | null }> {
    const keyProvider = keyB64 ? new ExternalE2EEKeyProvider() : null;
    const worker = keyB64 ? new Worker(e2eeWorkerUrl, { type: 'module' }) : null;
    const room = new Room(roomOptions(keyProvider, worker));
    if (keyProvider && keyB64) await installE2EEKey(keyProvider, keyB64);
    beforeConnect?.(room);
    await room.connect(url, token, { rtcConfig: { iceServers: [] } });
    if (keyB64) await room.setE2EEEnabled(true);
    room.on(RoomEvent.Disconnected, r => log(`disconnected ${String(r)}`));
    room.on(RoomEvent.Reconnecting, () => log('reconnecting'));
    room.on(RoomEvent.Reconnected, () => log('reconnected'));
    // The app's in-call monitor (share loss fallback, freeze / layer events).
    createRoot(document.getElementById('root')!).render(
        <RoomContext.Provider value={room}><CallEventMonitor /></RoomContext.Provider>,
    );
    return { room, worker };
}

// ── Publisher content: a game-like moving picture on WebGL ─────────────────

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; draw: (t: number) => void } {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    document.body.appendChild(canvas);
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false })!;
    const vs = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;
    // Scrolling detailed texture + moving shapes + a noisy HUD strip: real
    // detail that changes every frame, like a game (not white noise).
    const fs = `#version 300 es
precision highp float; uniform float t; uniform vec2 r; out vec4 o;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
void main(){
  vec2 uv = gl_FragCoord.xy / r;
  vec2 q = uv*vec2(r.x/r.y,1.)*6. + vec2(t*0.9, t*0.35);
  float v = n(q*4.)*.5 + n(q*9.)*.25 + n(q*23.)*.15 + n(q*61.)*.1;
  vec3 c = mix(vec3(.08,.12,.2), vec3(.6,.8,.35), v);
  c += .35*vec3(.9,.4,.2)*smoothstep(.12,.1,length(uv-vec2(.5+.35*sin(t*1.3),.5+.3*cos(t*.9))));
  float g = step(.97, fract(uv.x*40.+t*2.)) + step(.97, fract(uv.y*22.-t));
  c = mix(c, vec3(.9), g*.25);
  if (uv.y > .92) c = vec3(h(floor(gl_FragCoord.xy/4.)+floor(t*30.))*.3+.1);
  o = vec4(c,1.);
}`;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const ut = gl.getUniformLocation(prog, 't'); const ur = gl.getUniformLocation(prog, 'r');
    gl.uniform2f(ur, w, h); gl.viewport(0, 0, w, h);
    return { canvas, draw: (t: number) => { gl.uniform1f(ut, t); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); } };
}

/** A 440 Hz tone with a slow tremolo, published as the microphone (the "voice" a viewer hears). */
function makeAudio(): MediaStreamTrack {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const osc = ctx.createOscillator(); osc.frequency.value = 440;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 3;
    const g = ctx.createGain(); g.gain.value = 0.3; const lg = ctx.createGain(); lg.gain.value = 0.2;
    lfo.connect(lg).connect(g.gain);
    const dst = ctx.createMediaStreamDestination();
    osc.connect(g).connect(dst); osc.start(); lfo.start();
    return dst.stream.getAudioTracks()[0];
}

// ── Stats helpers ──────────────────────────────────────────────────────────

type StatsLike = { forEach(cb: (s: Record<string, unknown>) => void): void };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ── Publisher ──────────────────────────────────────────────────────────────

interface PubOpts { url: string; token: string; keyB64: string | null; codec: ScreenShareCodec; fps: number; width: number; height: number; resolution: '1440p' | '1080p' | 'source'; viewers: number; simulateHardware: boolean; source: 'canvas' | 'file'; gate: boolean }

async function startPublisher(o: PubOpts) {
    const { room, worker } = await joinRoom(o.url, o.token, o.keyB64);
    installE2EESenderCodecPin(room as unknown as CodecPinRoom, worker as unknown as { postMessage(m: unknown): void } | null, log);
    let vtrack: MediaStreamTrack;
    let drawn = 0;
    if (o.source === 'file') {
        // Chromium's fake capture device playing a Y4M clip (--use-file-for-fake-video-capture):
        // frames arrive in CPU memory at the clip's rate, like a desktop capturer.
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: o.width, height: o.height, frameRate: o.fps } });
        vtrack = s.getVideoTracks()[0];
    } else {
        const { canvas, draw } = makeCanvas(o.width, o.height);
        vtrack = canvas.captureStream().getVideoTracks()[0];
        // Paced draw loop at the target rate (drift-corrected).
        const t0 = performance.now(); let frame = 0;
        const tick = () => {
            draw((performance.now() - t0) / 1000); drawn++;
            frame++;
            setTimeout(tick, Math.max(0, t0 + (frame * 1000) / o.fps - performance.now()));
        };
        tick();
    }
    vtrack.contentHint = 'motion';
    log(`capture ${JSON.stringify(vtrack.getSettings())}`);

    // Exactly the app's publish path (SidebarConference.handleScreenShareSelect):
    const publishOptions = buildScreenSharePublishOptions(o.resolution, o.fps, o.codec, { lowerLayer: true });
    log(`publish options ${JSON.stringify(publishOptions)}`);
    const lv = new LocalVideoTrack(vtrack, undefined, true);
    const pub = await room.localParticipant.publishTrack(lv, { ...publishOptions, source: Track.Source.ScreenShare, name: 'screen' });
    const sender = (pub.track as unknown as { sender?: RTCRtpSender }).sender!;
    await applyScreenShareSenderParams(sender, o.fps, publishOptions.screenShareEncoding.maxBitrate, { codec: o.codec });
    log(`sender params ${JSON.stringify(sender.getParameters().encodings)}`);
    if (!o.gate) {
        // No lighter-copy gate: LiveKit's own dynacast decides (the copy is
        // encoded whenever anyone watches the share) — i.e. what a sharer gets
        // whose gate ALLOWS the copy (hardware encoder, no cost). Used where
        // this box's software encoder would trip the gate's cost back-off.
        log('lighter-copy gate NOT installed (LiveKit dynacast only)');
    } else if (o.simulateHardware) {
        // This box has no hardware encoder. The lighter-copy gate only ever
        // runs the copy on a HARDWARE encoder (shareLowLayer.ts), so — to test
        // the rest of the pipeline — its stats are stamped hardware here. Only
        // the gate's own sender is shimmed; the call monitor sees real stats.
        const orig = sender.getStats.bind(sender);
        const shimmed = { getStats: async () => {
            const r = await orig() as unknown as StatsLike;
            return { forEach: (cb: (s: Record<string, unknown>) => void) => r.forEach(s => cb(s.type === 'outbound-rtp' ? { ...s, powerEfficientEncoder: true } : s)) };
        } };
        const trackProxy = new Proxy(pub.track as object, {
            get(target, prop) {
                if (prop === 'sender') return new Proxy(sender, { get: (s, p) => (p === 'getStats' ? shimmed.getStats : (typeof (s as never)[p] === 'function' ? ((s as never)[p] as (...a: unknown[]) => unknown).bind(s) : (s as never)[p])) });
                const v = Reflect.get(target, prop, target);
                return typeof v === 'function' ? v.bind(target) : v;
            },
            set(target, prop, value) { return Reflect.set(target, prop, value, target); },
        });
        installShareLowLayerControl(trackProxy as unknown as ShareTrackLike, {
            settingOn: () => true, viewers: () => o.viewers, gameRunning: () => false, targetFps: o.fps, log,
            onChange: (allow, reason) => logCallEvent('share_low_layer', { on: allow, reason, viewers: o.viewers }),
        });
    } else {
        installShareLowLayerControl(pub.track as unknown as ShareTrackLike, {
            settingOn: () => true, viewers: () => o.viewers, gameRunning: () => false, targetFps: o.fps, log,
            onChange: (allow, reason) => logCallEvent('share_low_layer', { on: allow, reason, viewers: o.viewers }),
        });
    }
    await room.localParticipant.publishTrack(new LocalAudioTrack(makeAudio(), undefined, false), { source: Track.Source.Microphone, name: 'mic', dtx: false, red: false });

    let prevDrawn = 0;
    const prev = new Map<string, Record<string, number>>();
    setInterval(async () => {
        const now = Date.now();
        const row: Row = { t: now, role: 'pub', canvasFps: drawn - prevDrawn };
        prevDrawn = drawn;
        const r = await sender.getStats() as unknown as StatsLike;
        const layers: Row[] = [];
        let rtt: number | undefined; let outBw: number | undefined;
        r.forEach(s => {
            if (s.type === 'outbound-rtp' && s.kind === 'video') {
                const rid = String(s.rid ?? '-');
                const p = prev.get(rid) ?? {};
                const cur = { bytes: num(s.bytesSent) ?? 0, frames: num(s.framesEncoded) ?? 0, enc: num(s.totalEncodeTime) ?? 0, pli: num(s.pliCount) ?? 0, nack: num(s.nackCount) ?? 0 };
                const dF = cur.frames - (p.frames ?? cur.frames);
                layers.push({
                    rid, active: s.active, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond,
                    kbps: Math.round(((cur.bytes - (p.bytes ?? cur.bytes)) * 8) / 1000),
                    encMs: dF > 0 ? Math.round(((cur.enc - (p.enc ?? cur.enc)) / dF) * 10000) / 10 : undefined,
                    pli: cur.pli - (p.pli ?? cur.pli), nack: cur.nack - (p.nack ?? cur.nack),
                    qlr: s.qualityLimitationReason, impl: s.encoderImplementation, target: num(s.targetBitrate),
                });
                prev.set(rid, cur);
            }
            if (s.type === 'remote-inbound-rtp' && s.kind === 'video') rtt = num(s.roundTripTime);
            if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') outBw = num(s.availableOutgoingBitrate);
        });
        row.layers = layers; row.rtt = rtt; row.outBwKbps = outBw ? Math.round(outBw / 1000) : undefined;
        row.enc = sender.getParameters().encodings.map(e => `${e.rid ?? '-'}:${e.active ? 1 : 0}`).join(',');
        samples.push(row);
    }, 1000);
    return { sid: pub.trackSid, encodings: sender.getParameters().encodings };
}

// ── Viewer ─────────────────────────────────────────────────────────────────

interface ViewOpts { url: string; token: string; keyB64: string | null }

async function startViewer(o: ViewOpts) {
    let vpub: RemoteTrackPublication | null = null;
    let vtrack: RemoteVideoTrack | null = null;
    let atrack: RemoteAudioTrack | null = null;
    let claim: QualityClaim | null = null;
    let lastPick: number | undefined;
    const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true;
    document.body.appendChild(video);
    const audio = document.createElement('audio'); audio.autoplay = true; document.body.appendChild(audio);

    // VideoTile.tsx's share path: one claim per tile, pickShareLayer as a
    // focused fullscreen tile, re-evaluated as the publication updates.
    const pick = () => {
        if (!vpub || !claim) return;
        const d = vpub.dimensions;
        const aspect = d && d.height > 0 ? d.width / d.height : 16 / 9;
        const q = pickShareLayer({
            layers: normaliseLayers(vpub.trackInfo?.layers), role: 'focus',
            need: displayedPixels(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, aspect, 'contain'),
            mode: 'auto', current: lastPick as never,
        });
        lastPick = q;
        claim.set(q);
    };
    const onSub = (track: unknown, pub: RemoteTrackPublication) => {
        if (pub.source === Track.Source.ScreenShare && track instanceof RemoteVideoTrack) {
            vpub = pub; vtrack = track; track.attach(video);
            claim = claimRemoteQuality(pub);
            pick();
            log(`subscribed share layers=${JSON.stringify(pub.trackInfo?.layers?.map(l => ({ q: l.quality, w: l.width, h: l.height })))}`);
        }
        if (pub.source === Track.Source.Microphone && track instanceof RemoteAudioTrack) { atrack = track; track.attach(audio); }
    };
    // Registered BEFORE connect: a publisher already in the room is subscribed during connect.
    const { room } = await joinRoom(o.url, o.token, o.keyB64, r => r.on(RoomEvent.TrackSubscribed, (t, p) => onSub(t, p)));
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) if (pub.track && pub !== vpub) onSub(pub.track, pub);
    // Late join / already published: subscribe happens via auto-subscribe.
    setInterval(pick, 2000);

    let pv: Record<string, number> | null = null;
    let pa: Record<string, number> | null = null;
    let pBytes = 0;
    setInterval(async () => {
        const row: Row = { t: Date.now(), role: 'view' };
        if (vtrack && vpub) {
            const r = await vtrack.getRTCStatsReport() as unknown as StatsLike | undefined;
            r?.forEach(s => {
                if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
                const cur = {
                    dec: num(s.framesDecoded) ?? 0, rx: num(s.packetsReceived) ?? 0, lost: num(s.packetsLost) ?? 0,
                    pli: (num(s.pliCount) ?? 0) + (num(s.firCount) ?? 0), nack: num(s.nackCount) ?? 0,
                    fz: num(s.freezeCount) ?? 0, fzDur: num(s.totalFreezesDuration) ?? 0, kf: num(s.keyFramesDecoded) ?? 0,
                    bytes: num(s.bytesReceived) ?? 0, drop: num(s.framesDropped) ?? 0,
                };
                const p = pv ?? cur;
                const exp = (cur.rx - p.rx) + Math.max(0, cur.lost - p.lost);
                Object.assign(row, {
                    fps: cur.dec - p.dec, w: s.frameWidth, h: s.frameHeight,
                    lossPct: exp > 0 ? Math.round((Math.max(0, cur.lost - p.lost) / exp) * 1000) / 10 : null,
                    pli: cur.pli - p.pli, nack: cur.nack - p.nack, freezes: cur.fz - p.fz,
                    freezeMs: Math.round((cur.fzDur - p.fzDur) * 1000), kf: cur.kf - p.kf,
                    kbps: Math.round(((cur.bytes - p.bytes) * 8) / 1000), dropped: cur.drop - p.drop,
                    decoder: s.decoderImplementation,
                });
                pv = cur;
            });
            row.applied = appliedQuality(vpub); row.claimed = claimedQuality(vpub);
            row.streamState = vpub.track?.streamState;
        }
        if (atrack) {
            const r = await atrack.getRTCStatsReport() as unknown as StatsLike | undefined;
            r?.forEach(s => {
                if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
                const cur = { rx: num(s.packetsReceived) ?? 0, lost: num(s.packetsLost) ?? 0, conc: num(s.concealedSamples) ?? 0, tot: num(s.totalSamplesReceived) ?? 0 };
                const p = pa ?? cur;
                const exp = (cur.rx - p.rx) + Math.max(0, cur.lost - p.lost);
                row.aLossPct = exp > 0 ? Math.round((Math.max(0, cur.lost - p.lost) / exp) * 1000) / 10 : null;
                row.aConcPct = cur.tot - p.tot > 0 ? Math.round(((cur.conc - p.conc) / (cur.tot - p.tot)) * 1000) / 10 : null;
                row.aJitterMs = Math.round((num(s.jitter) ?? 0) * 1000);
                pa = cur;
            });
        }
        // Whole-transport receive rate (all tracks) from the subscriber pc.
        const sub = (room as unknown as { engine?: { pcManager?: { subscriber?: { getStats(): Promise<StatsLike> } } } }).engine?.pcManager?.subscriber;
        if (sub) {
            const r = await sub.getStats();
            r.forEach(s => {
                if (s.type === 'transport') {
                    const b = num(s.bytesReceived) ?? 0;
                    row.totKbps = pBytes ? Math.round(((b - pBytes) * 8) / 1000) : undefined; pBytes = b;
                }
                if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') row.rtt = num(s.currentRoundTripTime);
            });
        }
        samples.push(row);
    }, 1000);
}

function drain() {
    const out = { samples: samples.splice(0), events: events.splice(0) };
    return out;
}

(window as unknown as { H: unknown }).H = { startPublisher, startViewer, drain };
(window as unknown as { HREADY: boolean }).HREADY = true;
