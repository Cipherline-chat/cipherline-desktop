/**
 * LiveKit server upgrade harness page (driven by ./run.mjs). One page = one call participant.
 *
 * Joins a real LiveKit room the way CallPane.tsx does: the app's Room options (adaptiveStream off,
 * dynacast on, simulcast camera ladder, red/dtx off), RotatingKeyProvider + installE2EEKey +
 * activateRoomE2EE (fail-closed activation before connect) + the app's own E2EE worker
 * (workers/e2eeWorker.ts, Annex-B canonicalizer) + installE2EESenderCodecPin, and screen shares
 * published with the app's buildScreenSharePublishOptions. Capture devices are replaced by
 * synthetic sources: a sine tone as the microphone and animated canvases as camera / screen.
 *
 * What it measures, per page:
 *   audio  - the PEER's tone (spectral peak within 3 bins of the peer's frequency, > -55 dBFS) on
 *            the decoded remote track. Undecryptable frames give silence/noise, never that peak.
 *   video  - framesDecoded / fps / size / codec / freezes of every remote video track (rendered
 *            into a hidden <video> so Chromium actually decodes it), and its trackInfo.encryption.
 *   data   - reliable data packets (encrypted by the room's data-channel E2EE) received per topic.
 *   events - reconnect / disconnect / participant / encryption-error events with timestamps.
 */
import {
    Room, RoomEvent, Track, Encryption_Type, VideoPreset, ConnectionState,
    type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant, type RoomOptions,
} from 'livekit-client';
import e2eeWorkerUrl from '../../src/workers/e2eeWorker?worker&url';
import { stableE2EEOptions } from '../../src/utils/e2eeRoomOptions';
import { installE2EEKey, activateRoomE2EE } from '../../src/utils/e2eeActivation';
import { RotatingKeyProvider } from '../../src/utils/e2eeKeyRing';
import { installE2EESenderCodecPin, e2eeWorkerOf } from '../../src/utils/e2eeSenderCodec';
import { buildScreenSharePublishOptions, type ScreenShareCodec } from '../../src/utils/screenShare';

type Row = Record<string, unknown>;
const t0 = performance.now();
const t = () => Math.round(performance.now() - t0);
const events: Row[] = [];
const ev = (e: string, d: Row = {}) => { events.push({ t: t(), e, ...d }); };
const data: Row[] = [];
let room: Room | null = null;
let audioCtx: AudioContext | null = null;
let expectHz = 0;
let audioGood = 0, audioFrames = 0, audioPeakDb = -200, audioPeakHz = 0;
const remoteVideos = new Map<string, { track: RemoteTrack; pub: RemoteTrackPublication; who: string; el: HTMLVideoElement }>();
const timers: ReturnType<typeof setInterval>[] = [];

function roomOptions(keyProvider: RotatingKeyProvider, worker: Worker): RoomOptions {
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
        encryption: stableE2EEOptions(keyProvider, worker),
    } as RoomOptions;
}

const audioTimers = new Map<string, ReturnType<typeof setInterval>>();
function analyseAudio(track: RemoteTrack, sid: string) {
    const mst = track.mediaStreamTrack;
    const el = document.createElement('audio');
    el.muted = true; el.autoplay = true; el.srcObject = new MediaStream([mst]);
    document.body.appendChild(el);
    void el.play().catch(() => undefined);
    const ctx = audioCtx!;
    const an = ctx.createAnalyser();
    an.fftSize = 4096;
    ctx.createMediaStreamSource(new MediaStream([mst])).connect(an);
    const bins = new Float32Array(an.frequencyBinCount);
    const hzPerBin = ctx.sampleRate / an.fftSize;
    const iv = setInterval(() => {
        if (mst.readyState === 'ended') return;
        an.getFloatFrequencyData(bins);
        let best = -Infinity, bi = 0;
        for (let i = 1; i < bins.length; i++) if (bins[i] > best) { best = bins[i]; bi = i; }
        audioFrames++;
        audioPeakDb = Math.round(best); audioPeakHz = Math.round(bi * hzPerBin);
        if (best > -55 && Math.abs(bi * hzPerBin - expectHz) <= 3 * hzPerBin) audioGood++;
    }, 50);
    timers.push(iv);
    audioTimers.set(sid, iv);
}

function attachVideo(track: RemoteTrack, pub: RemoteTrackPublication, who: string) {
    const el = document.createElement('video');
    el.muted = true; el.autoplay = true; el.playsInline = true; el.width = 320; el.height = 180;
    document.body.appendChild(el);
    track.attach(el);
    remoteVideos.set(pub.trackSid, { track, pub, who, el });
}

/** Animated, noisy canvas so the encoder has real work; returns its capture track. */
function canvasTrack(w: number, h: number, fps: number, label: string): MediaStreamTrack {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    let n = 0;
    timers.push(setInterval(() => {
        n++;
        g.fillStyle = `hsl(${(n * 3) % 360} 60% 30%)`; g.fillRect(0, 0, w, h);
        for (let i = 0; i < 24; i++) {
            g.fillStyle = `hsl(${(i * 37 + n) % 360} 80% 60%)`;
            g.fillRect((i * 97 + n * (i + 3)) % w, (i * 53 + n * 2) % h, w / 10, h / 10);
        }
        g.fillStyle = '#fff'; g.font = `${Math.round(h / 12)}px monospace`;
        g.fillText(`${label} ${n} ${Date.now()}`, 20, h / 2);
    }, 1000 / fps));
    return c.captureStream(fps).getVideoTracks()[0];
}

function errText(e: unknown) { return String((e as Error)?.message ?? e).slice(0, 200); }

const H = {
    async join(a: { url: string; token: string; keyB64: string; toneHz: number; expectHz: number; relay?: boolean }) {
        expectHz = a.expectHz;
        audioCtx = new AudioContext({ sampleRate: 48000 });
        await audioCtx.resume();
        const keyProvider = new RotatingKeyProvider();
        const worker = new Worker(e2eeWorkerUrl, { type: 'module' });
        room = new Room(roomOptions(keyProvider, worker));
        const r = room;
        r.on(RoomEvent.EncryptionError, (e) => ev('encryption_error', { msg: errText(e) }));
        r.on(RoomEvent.Reconnecting, () => ev('reconnecting'));
        r.on(RoomEvent.SignalReconnecting, () => ev('signal_reconnecting'));
        r.on(RoomEvent.Reconnected, () => ev('reconnected'));
        r.on(RoomEvent.Disconnected, (reason) => ev('disconnected', { reason }));
        r.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => ev('participant_connected', { who: p.identity }));
        r.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => ev('participant_disconnected', { who: p.identity }));
        r.on(RoomEvent.TrackUnsubscribed, (_tr, pub: RemoteTrackPublication, p: RemoteParticipant) => {
            remoteVideos.delete(pub.trackSid);
            const iv = audioTimers.get(pub.trackSid);
            if (iv) { clearInterval(iv); audioTimers.delete(pub.trackSid); }
            ev('track_unsubscribed', { who: p.identity, source: pub.source });
        });
        r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
            const enc = (pub as unknown as { trackInfo?: { encryption?: number } }).trackInfo?.encryption;
            ev('track_subscribed', { who: p.identity, kind: track.kind, source: pub.source, gcm: enc === Encryption_Type.GCM, mime: pub.mimeType });
            if (track.kind === Track.Kind.Audio) analyseAudio(track, pub.trackSid);
            else attachVideo(track, pub, p.identity);
        });
        r.on(RoomEvent.DataReceived, (payload: Uint8Array, p?: RemoteParticipant, _k?: unknown, topic?: string) => {
            data.push({ t: t(), from: p?.identity, topic, text: new TextDecoder().decode(payload) });
        });
        r.on(RoomEvent.ParticipantPermissionsChanged, () => ev('permissions_changed', { sources: r.localParticipant.permissions?.canPublishSources }));
        // <E2EEActivator>: key + activation BEFORE connect (fail-closed).
        const keyReady = installE2EEKey(keyProvider, a.keyB64);
        keyReady.catch(() => undefined);
        activateRoomE2EE(r as never, keyProvider as never, {
            onFailure: (f) => ev('e2ee_failure', { kind: f.kind }),
            onActive: () => ev('e2ee_active'),
        }, { keyReady });
        installE2EESenderCodecPin(r as never, e2eeWorkerOf(r as never), (m) => ev('codec_pin', { m }));
        try {
            await r.connect(a.url, a.token, { autoSubscribe: true, ...(a.relay ? { rtcConfig: { iceTransportPolicy: 'relay' } } : {}) });
            ev('connected', { sid: r.localParticipant.sid, serverVersion: (r as unknown as { serverInfo?: { version?: string } }).serverInfo?.version });
        } catch (e) { ev('connect_error', { msg: errText(e) }); return H.stats(); }
        const osc = audioCtx.createOscillator(); osc.frequency.value = a.toneHz;
        const gain = audioCtx.createGain(); gain.gain.value = 0.4;
        const dest = audioCtx.createMediaStreamDestination();
        osc.connect(gain); gain.connect(dest); osc.start();
        try {
            await r.localParticipant.publishTrack(dest.stream.getAudioTracks()[0], { source: Track.Source.Microphone, name: 'tone' });
            ev('published', { source: 'microphone' });
        } catch (e) { ev('publish_error', { source: 'microphone', msg: errText(e) }); }
        return H.stats();
    },

    async publishCamera(o: { codec: 'vp8' | 'h264' | 'vp9'; bypassClientCheck?: boolean } = { codec: 'vp8' }) {
        const lp = room!.localParticipant;
        // Free-tier test: skip livekit-client's own canPublishSources check so the request
        // reaches the SFU, which is the actual enforcement point.
        if (o.bypassClientCheck && lp.permissions) lp.permissions.canPublishSources = [];
        try {
            const pub = await Promise.race([
                lp.publishTrack(canvasTrack(1280, 720, 30, 'cam'), { source: Track.Source.Camera, videoCodec: o.codec, simulcast: true }),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('harness: no publish answer in 15 s')), 15_000)),
            ]);
            ev('published', { source: 'camera', sid: pub.trackSid });
            return { ok: true, sid: pub.trackSid };
        } catch (e) { ev('publish_error', { source: 'camera', msg: errText(e) }); return { ok: false, err: errText(e) }; }
    },

    async publishScreen(o: { codec: ScreenShareCodec; res: '1080p' | '720p'; fps: 15 | 30 | 60 }) {
        const { width, height } = o.res === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
        const opts = buildScreenSharePublishOptions(o.res, o.fps, o.codec, { lowerLayer: true });
        try {
            const pub = await room!.localParticipant.publishTrack(canvasTrack(width, height, o.fps, 'share'), { ...opts, source: Track.Source.ScreenShare, name: 'screen' } as never);
            ev('published', { source: 'screen_share', sid: pub.trackSid, codec: o.codec });
            return { ok: true, sid: pub.trackSid };
        } catch (e) { ev('publish_error', { source: 'screen_share', msg: errText(e) }); return { ok: false, err: errText(e) }; }
    },

    async unpublishVideo() {
        const lp = room!.localParticipant;
        for (const p of [...lp.trackPublications.values()]) if (p.kind === Track.Kind.Video && p.track) await lp.unpublishTrack(p.track);
    },

    /** Undo a server-side mutePublishedTrack (moderation path) on the local mic. */
    async unmuteMic() {
        for (const p of room!.localParticipant.trackPublications.values()) if (p.kind === Track.Kind.Audio && p.isMuted) await p.track?.unmute();
        return true;
    },

    async sendData(n: number, topic: string) {
        const lp = room!.localParticipant;
        for (let i = 0; i < n; i++) await lp.publishData(new TextEncoder().encode(`${lp.identity}#${i}`), { reliable: true, topic });
        return n;
    },

    /** Snapshot: audio counters (and reset), per-remote-video decode stats, data, events, selected ICE pair. */
    async stats(resetAudio = false) {
        const videos: Row[] = [];
        for (const [sid, v] of remoteVideos) {
            const row: Row = { sid, who: v.who, source: v.pub.source, mime: v.pub.mimeType,
                gcm: (v.pub as unknown as { trackInfo?: { encryption?: number } }).trackInfo?.encryption === Encryption_Type.GCM };
            try {
                const rep = await (v.track as unknown as { getRTCStatsReport(): Promise<RTCStatsReport | undefined> }).getRTCStatsReport();
                rep?.forEach((s: Row & { type: string }) => {
                    if (s.type === 'inbound-rtp') Object.assign(row, { framesDecoded: s.framesDecoded, keyFramesDecoded: s.keyFramesDecoded, fps: s.framesPerSecond,
                        w: s.frameWidth, h: s.frameHeight, freezes: s.freezeCount, plis: s.pliCount, bytes: s.bytesReceived, packetsLost: s.packetsLost });
                    if (s.type === 'codec') row.codec = s.mimeType;
                });
            } catch (e) { row.err = errText(e); }
            videos.push(row);
        }
        let pair: Row | undefined;
        try {
            const pc = (room as unknown as { engine?: { pcManager?: { subscriber?: { pc?: RTCPeerConnection }; publisher?: { pc?: RTCPeerConnection } } } })
                ?.engine?.pcManager?.publisher?.pc;
            const rep = await pc?.getStats();
            const cands = new Map<string, Row>();
            rep?.forEach((s: Row & { type: string; id: string }) => { if (s.type === 'local-candidate' || s.type === 'remote-candidate') cands.set(s.id, s); });
            rep?.forEach((s: Row & { type: string }) => {
                if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
                    const l = cands.get(s.localCandidateId as string); const r = cands.get(s.remoteCandidateId as string);
                    pair = { local: l?.candidateType, localProto: l?.protocol, relayProto: l?.relayProtocol, remote: `${r?.address}:${r?.port}` };
                }
            });
        } catch { /* */ }
        const out = {
            t: t(),
            state: room?.state ?? ConnectionState.Disconnected,
            identity: room?.localParticipant.identity,
            remotes: room ? [...room.remoteParticipants.values()].map(p => p.identity) : [],
            audio: { good: audioGood, frames: audioFrames, peakDb: audioPeakDb, peakHz: audioPeakHz },
            videos, data: [...data], events: [...events], pair,
            perms: room?.localParticipant.permissions?.canPublishSources,
        };
        if (resetAudio) { audioGood = 0; audioFrames = 0; }
        return out;
    },

    async leave() {
        try { await room?.disconnect(true); } catch { /* */ }
        for (const x of timers.splice(0)) clearInterval(x);
        for (const v of remoteVideos.values()) v.el.remove();
        remoteVideos.clear();
        try { await audioCtx?.close(); } catch { /* */ }
        room = null;
        return events.length;
    },
};
(window as unknown as { H: typeof H }).H = H;
(window as unknown as { HREADY: boolean }).HREADY = true;
