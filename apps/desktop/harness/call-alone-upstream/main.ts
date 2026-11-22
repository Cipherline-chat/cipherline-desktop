/**
 * Alone-in-call upstream pause: measurement page (driven by harness/call-alone-upstream/run.mjs).
 *
 * One page is the person ALONE in a real LiveKit room with the app's E2EE on (RotatingKeyProvider + installE2EEKey +
 * the app's E2EE worker, room options as CallPane.tsx: dynacast on, dtx off, red off, 64 kbps mic, simulcast camera);
 * it publishes the mic (a WebAudio tone or quiet noise), optionally a camera (fake device, 720p simulcast) and a
 * screen share (a 1080p30 canvas, the app's buildScreenSharePublishOptions), and runs the app's own AloneUpstream
 * controller + pauseAudioUpstream / resumeAudioUpstream (src/utils/aloneUpstream.ts). The other page JOINS later and
 * records when the first audio (and video) arrives and whether it decrypts.
 *
 * Wire bytes = the `transport` stats' bytesSent of every RTCPeerConnection the page opened (everything that left the
 * socket: RTP, RTCP, STUN, DTLS), sampled by the runner.
 */
import { Room, RoomEvent, Track, LocalVideoTrack, LocalAudioTrack, type RoomOptions, VideoPreset, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import e2eeWorkerUrl from '../../src/workers/e2eeWorker?worker&url';
import { stableE2EEOptions } from '../../src/utils/e2eeRoomOptions';
import { installE2EEKey } from '../../src/utils/e2eeActivation';
import { RotatingKeyProvider } from '../../src/utils/e2eeKeyRing';
import { buildScreenSharePublishOptions } from '../../src/utils/screenShare';
import { AloneUpstream, pauseAudioUpstream, resumeAudioUpstream, type UpstreamRoomLike, type UpstreamResumeReason } from '../../src/utils/aloneUpstream';

type Row = Record<string, unknown>;
const pcs: RTCPeerConnection[] = [];
const OrigPC = window.RTCPeerConnection;
window.RTCPeerConnection = function (this: unknown, cfg?: RTCConfiguration) {
    const pc = new OrigPC(cfg);
    pcs.push(pc);
    return pc;
} as unknown as typeof RTCPeerConnection;
window.RTCPeerConnection.prototype = OrigPC.prototype;
(window.RTCPeerConnection as unknown as { generateCertificate: unknown }).generateCertificate = OrigPC.generateCertificate;

const events: Row[] = [];
const ev = (m: string, extra: Row = {}) => { events.push({ t: Date.now(), pt: performance.now(), m, ...extra }); console.info(`harness: ${m} ${JSON.stringify(extra)}`); };

let room: Room | null = null;
let keyProvider: RotatingKeyProvider | null = null;
let ctl: AloneUpstream | null = null;
let shareTimer: ReturnType<typeof setInterval> | null = null;
let pendingSub: ((t: RemoteTrack, pub: RemoteTrackPublication) => void) | null = null;

function roomOptions(kp: RotatingKeyProvider, worker: Worker): RoomOptions {
    return {
        adaptiveStream: false,
        dynacast: true,
        videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
        publishDefaults: {
            simulcast: true,
            videoSimulcastLayers: [new VideoPreset(320, 180, 200_000, 30), new VideoPreset(640, 360, 600_000, 30)],
            red: false, dtx: false, audioPreset: { maxBitrate: 64_000 },
        },
        encryption: stableE2EEOptions(kp, worker),
    };
}

async function join(o: { url: string; token: string; keyB64: string }) {
    keyProvider = new RotatingKeyProvider();
    const worker = new Worker(e2eeWorkerUrl, { type: 'module' });
    room = new Room(roomOptions(keyProvider, worker));
    await installE2EEKey(keyProvider, o.keyB64);
    room.on(RoomEvent.EncryptionError, e => ev('encryption_error', { msg: String((e as Error)?.message ?? e).slice(0, 160) }));
    room.on(RoomEvent.ParticipantConnected, () => ev('participant_connected'));
    room.on(RoomEvent.TrackSubscribed, (t: RemoteTrack, pub: RemoteTrackPublication) => { ev('track_subscribed', { kind: t.kind, source: t.source }); pendingSub?.(t, pub); });
    room.on(RoomEvent.ParticipantEncryptionStatusChanged, (on: boolean, p) => ev('encryption_status', { on, local: p?.identity === room?.localParticipant.identity }));
    await room.setE2EEEnabled(true);
    await room.connect(o.url, o.token, { rtcConfig: { iceServers: [] } });
    ev('joined', { e2ee: room.isE2EEEnabled });
}

async function publish(o: { camera?: boolean; share?: boolean; mic?: 'tone' | 'quiet' }) {
    if (!room) throw new Error('no room');
    // The mic: a steady 440 Hz tone at -20 dBFS ("talking") or -60 dBFS noise (a quiet room behind the gate's
    // attenuation, which never reaches digital silence) - deterministic, so the byte counts compare.
    const actx = new AudioContext();
    const dest = actx.createMediaStreamDestination();
    if (o.mic === 'quiet') {
        const len = actx.sampleRate * 2;
        const nb = actx.createBuffer(1, len, actx.sampleRate);
        const ch = nb.getChannelData(0);
        for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * 0.001 * Math.sqrt(3);
        const src = actx.createBufferSource(); src.buffer = nb; src.loop = true; src.connect(dest); src.start();
    } else {
        const osc = actx.createOscillator(); osc.frequency.value = 440;
        const g = actx.createGain(); g.gain.value = 0.1 * Math.SQRT2;
        osc.connect(g); g.connect(dest); osc.start();
    }
    await room.localParticipant.publishTrack(new LocalAudioTrack(dest.stream.getAudioTracks()[0], undefined, true), { source: Track.Source.Microphone });
    if (o.camera) await room.localParticipant.setCameraEnabled(true);
    if (o.share) {
        const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
        const g = c.getContext('2d')!;
        let n = 0;
        // Moving content, like a screen with something playing: an encoder fed a still canvas sends almost nothing.
        shareTimer = setInterval(() => {
            n++;
            g.fillStyle = `hsl(${(n * 3) % 360} 60% 40%)`; g.fillRect(0, 0, 1920, 1080);
            g.fillStyle = '#fff'; g.font = '120px sans-serif'; g.fillText(`frame ${n}`, 100 + (n * 7) % 1200, 300 + (n * 5) % 600);
            for (let i = 0; i < 40; i++) { g.fillStyle = `hsl(${(i * 37 + n) % 360} 80% 60%)`; g.fillRect((i * 97 + n * 11) % 1900, (i * 53 + n * 3) % 1060, 60, 60); }
        }, 33);
        const mst = c.captureStream(30).getVideoTracks()[0];
        const track = new LocalVideoTrack(mst, undefined, true);
        await room.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare, ...buildScreenSharePublishOptions('1080p', 30, 'vp8') });
    }
    ev('published', { camera: !!o.camera, share: !!o.share, mic: o.mic ?? 'tone' });
}

/** The app's controller with the app's pause / resume, the probe reading the live Room (no hook / presence here). */
function startController() {
    if (!room) throw new Error('no room');
    const r = room;
    ctl = new AloneUpstream({
        probe: () => ({ hook: r.remoteParticipants.size, live: r.remoteParticipants.size, presence: null }),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: h => clearTimeout(h as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
        pause: () => pauseAudioUpstream(r as unknown as UpstreamRoomLike),
        resume: () => resumeAudioUpstream(r as unknown as UpstreamRoomLike),
        onPaused: () => ev('upstream_paused'),
        onResumed: (reason: UpstreamResumeReason, ms: number) => { ev('upstream_resumed', { reason, ms }); void watchFirstPacket(); },
    });
    r.on(RoomEvent.ParticipantConnected, () => ctl?.joined());
    // As SidebarConference: the SFU telling us someone subscribed to one of our tracks is a join too (it can come
    // seconds before ParticipantConnected).
    r.on(RoomEvent.LocalTrackSubscribed, () => { ev('local_track_subscribed'); ctl?.joined(); });
    r.on(RoomEvent.ParticipantDisconnected, () => ctl?.check());
    ctl.check();
    ev('controller_started');
}

/** Sender restart latency, without the controller: pause, hold 1.5 s, resume, time the first new RTP packet. */
async function latencyTrials(n: number): Promise<Row[]> {
    const out: Row[] = [];
    for (let i = 0; i < n; i++) {
        await pauseAudioUpstream(room as unknown as UpstreamRoomLike);
        await new Promise(r => setTimeout(r, 1500));
        const t0 = performance.now();
        await resumeAudioUpstream(room as unknown as UpstreamRoomLike);
        const setMs = performance.now() - t0;
        const fp = await firstPacketSince(t0);
        out.push({ setParametersMs: Math.round(setMs * 10) / 10, firstPacketMs: fp });
        await new Promise(r => setTimeout(r, 500));
    }
    return out;
}

async function firstPacketSince(t0: number): Promise<number> {
    const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const sender = (pub?.track as unknown as { sender?: RTCRtpSender } | undefined)?.sender;
    if (!sender) return -1;
    const read = async () => { let n = 0; (await sender.getStats()).forEach((s: Row & { type: string }) => { if (s.type === 'outbound-rtp') n += Number(s.packetsSent ?? 0); }); return n; };
    const p0 = await read();
    while (performance.now() - t0 < 2000) {
        if ((await read()) > p0) return Math.round(performance.now() - t0);
        await new Promise(r => setTimeout(r, 2));
    }
    return -1;
}

/** After a resume: poll the mic sender's packetsSent every 2 ms until it moves. */
async function watchFirstPacket() {
    const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const sender = (pub?.track as unknown as { sender?: RTCRtpSender } | undefined)?.sender;
    if (!sender) return;
    const read = async () => { let n = 0; (await sender.getStats()).forEach((s: Row & { type: string }) => { if (s.type === 'outbound-rtp') n += Number(s.packetsSent ?? 0); }); return n; };
    const p0 = await read();
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
        if ((await read()) > p0) { ev('first_packet_after_resume', { ms: Math.round(performance.now() - t0) }); return; }
        await new Promise(r => setTimeout(r, 2));
    }
    ev('first_packet_after_resume', { ms: -1 });
}

async function rotateKey(keyB64: string) {
    if (!keyProvider) throw new Error('no key provider');
    await installE2EEKey(keyProvider, keyB64);
    ev('key_rotated');
}

async function wire(): Promise<Row> {
    let transport = 0;
    const out: Row[] = [];
    for (const pc of pcs) {
        if (pc.connectionState === 'closed') continue;
        const rep = await pc.getStats();
        rep.forEach((s: Row & { type: string }) => {
            if (s.type === 'transport') transport += Number(s.bytesSent ?? 0);
            if (s.type === 'outbound-rtp') out.push({ kind: s.kind, rid: s.rid ?? null, bytes: s.bytesSent, hdr: s.headerBytesSent, packets: s.packetsSent, frames: s.framesEncoded ?? null, active: s.active ?? null, w: s.frameWidth ?? null, h: s.frameHeight ?? null, lim: s.qualityLimitationReason ?? null });
        });
    }
    const senders: Row[] = [];
    room?.localParticipant.trackPublications.forEach(pub => {
        const s = (pub.track as unknown as { sender?: RTCRtpSender } | undefined)?.sender;
        senders.push({ source: pub.source, muted: pub.isMuted, enc: s?.getParameters().encodings?.map(e => ({ rid: e.rid ?? null, active: e.active !== false })) ?? null });
    });
    return { t: Date.now(), transport, out, senders, paused: ctl?.paused ?? false, micEnabled: room?.localParticipant.isMicrophoneEnabled ?? null, micTrackLive: (room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack?.readyState) ?? null };
}

// ── Listener (the joiner) ───────────────────────────────────────────────────
async function listen(o: { url: string; token: string; keyB64: string; publishMic?: boolean }) {
    const seen: Row = {};
    (window as unknown as { SEEN: Row }).SEEN = seen;
    // Decoded audio level, pulled through WebAudio (a headless shell has no output device, so nothing would
    // otherwise decode the track): a frame that failed to decrypt is dropped, so energy here = decrypted audio.
    const actx = new AudioContext();
    const an = actx.createAnalyser(); an.fftSize = 2048;
    const sink = actx.createGain(); sink.gain.value = 0; an.connect(sink); sink.connect(actx.destination);
    const buf = new Float32Array(an.fftSize);
    let maxRms = 0;
    const onSub = (t: RemoteTrack, pub: RemoteTrackPublication) => {
        seen[`${pub.source}_subscribed`] = Date.now();
        const el = t.attach(); el.muted = true; document.body.appendChild(el);
        if (t.kind === 'audio') actx.createMediaStreamSource(new MediaStream([t.mediaStreamTrack])).connect(an);
    };
    pendingSub = onSub;
    await join(o);
    const r = room!;
    if (o.publishMic) {
        const actx2 = new AudioContext();
        const d2 = actx2.createMediaStreamDestination();
        const osc = actx2.createOscillator(); osc.frequency.value = 660; const g = actx2.createGain(); g.gain.value = 0.01; osc.connect(g); g.connect(d2); osc.start();
        await r.localParticipant.publishTrack(new LocalAudioTrack(d2.stream.getAudioTracks()[0], undefined, true), { source: Track.Source.Microphone });
        seen.joiner_published = Date.now();
    }
    const level = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let e = 0; for (const v of buf) e += v * v;
        const rms = Math.sqrt(e / buf.length);
        if (rms > maxRms) maxRms = rms;
        if (rms > 0.001 && !seen.audio_first_decoded_sound) seen.audio_first_decoded_sound = Date.now();
        seen.audio_max_rms = maxRms;
    }, 5);
    r.once(RoomEvent.Disconnected, () => clearInterval(level));
    // first inbound packet / energy / decoded frame per kind, polled every 5 ms for 8 s
    const t0 = Date.now();
    const poll = async () => {
        while (Date.now() - t0 < 8000) {
            for (const pc of pcs) {
                if (pc.connectionState === 'closed') continue;
                (await pc.getStats()).forEach((s: Row & { type: string }) => {
                    if (s.type !== 'inbound-rtp') return;
                    if (s.kind === 'audio') {
                        if (Number(s.packetsReceived ?? 0) > 0 && !seen.audio_first_packet) seen.audio_first_packet = Date.now();
                        if (Number(s.totalAudioEnergy ?? 0) > 0 && !seen.audio_first_energy) seen.audio_first_energy = Date.now();
                        seen.audio_energy = s.totalAudioEnergy; seen.audio_packets = s.packetsReceived; seen.audio_concealed = s.concealedSamples; seen.audio_samples = s.totalSamplesReceived;
                    }
                    if (s.kind === 'video') {
                        if (Number(s.framesDecoded ?? 0) > 0 && !seen.video_first_decoded) seen.video_first_decoded = Date.now();
                        seen.video_decoded = Math.max(Number(seen.video_decoded ?? 0), Number(s.framesDecoded ?? 0));
                    }
                });
            }
            await new Promise(res => setTimeout(res, 5));
        }
    };
    seen.connected = Date.now();
    void poll().then(() => { clearInterval(level); seen.done = true; });
}

async function leave() {
    ctl?.dispose();
    if (shareTimer) clearInterval(shareTimer);
    await room?.disconnect();
    room = null;
}

(window as unknown as Record<string, unknown>).H = {
    join, publish, startController, wire, rotateKey, listen, leave, latencyTrials,
    events: () => events,
    seen: () => (window as unknown as { SEEN?: Row }).SEEN ?? null,
    pauseNow: () => pauseAudioUpstream(room as unknown as UpstreamRoomLike),
    resumeNow: () => resumeAudioUpstream(room as unknown as UpstreamRoomLike),
};
(window as unknown as Record<string, unknown>).HREADY = true;
