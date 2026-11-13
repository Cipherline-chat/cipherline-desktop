// Test page for the native-share-encoder spike: the REAL e2eeWorker (canonicalizer + native injector + LiveKit cryptor) in a real
// Electron renderer, a real LiveKit SFU, E2EE on. Driven by harness/native-share-spike/main.ts through executeJavaScript.
import { Room, RoomEvent, ExternalE2EEKeyProvider, Track, setLogLevel, LogLevel, type RemoteTrack } from 'livekit-client';
import e2eeWorkerUrl from '../../src/workers/e2eeWorker?worker&url';
import { installE2EESenderCodecPin, e2eeWorkerOf, type CodecPinRoom } from '../../src/utils/e2eeSenderCodec';
import { createDummyShareTrack, createGeneratorShareTrack, dummyPublishOptions, bridgeNativePort, startNativeBitrateLoop, readSenderEstimateBps } from '../../src/utils/nativeShareDummy';

setLogLevel(LogLevel.debug);
type AnyRec = Record<string, unknown>;
const w = window as unknown as AnyRec & { nativeShare?: { start(a: unknown): Promise<{ ok: boolean; error?: string }>; stop(): Promise<unknown> } };

let room: Room | null = null;
let worker: Worker | null = null;
let dummy: { track: MediaStreamTrack; stop(): void } | null = null;
let gen: ReturnType<typeof createGeneratorShareTrack> | null = null;
let dummyTrackId = '';
let stopBitrate: (() => void) | null = null;
let fallbackStop: (() => void) | null = null;
const workerStatus: AnyRec[] = [];
const events: string[] = [];
let exitCode: number | null = null;
window.addEventListener('message', (ev) => { if (ev.data?.kind === 'cl:native-share-exit') { exitCode = ev.data.code; events.push(`helper exit ${ev.data.code} @${Date.now()}`); } });

const video = document.createElement('video');
video.autoplay = true; video.muted = true; video.playsInline = true; video.style.cssText = 'width:640px;height:360px;background:#000';
document.body.appendChild(video);

function pc(): RTCPeerConnection | null {
    const e = room?.engine as unknown as { pcManager?: { publisher?: { pc?: RTCPeerConnection }; subscriber?: { pc?: RTCPeerConnection } } };
    return e?.pcManager?.publisher?.pc ?? null;
}
async function connect(url: string, token: string, key: string | null): Promise<string> {
    const keyProvider = new ExternalE2EEKeyProvider();
    let opts: Record<string, unknown> = { adaptiveStream: false, dynacast: false };
    if (key) {
        worker = new Worker(e2eeWorkerUrl, { type: 'module' });
        worker.addEventListener('message', (e) => {
            if (e.data?.kind === 'cl:native-au') { gen?.pushTick(); return; } if (e.data?.kind === 'cl:native-share-status') { workerStatus.push({ t: Date.now(), ...e.data.data }); events.push(`worker status ${e.data.data.state} @${Date.now()}`); } });
        opts = { ...opts, encryption: { keyProvider, worker } };
    }
    room = new Room(opts);
    room.on(RoomEvent.TrackSubscribed, (t: RemoteTrack) => { if (t.kind === Track.Kind.Video) { t.attach(video); events.push(`subscribed video @${Date.now()}`); } });
    room.on(RoomEvent.TrackUnsubscribed, (t: RemoteTrack) => { t.detach(video); });
    if (key) { await keyProvider.setKey(key); }
    await room.connect(url, token);
    if (key) await room.setE2EEEnabled(true);
    return 'connected';
}

async function startNative(o: { fps: number; width: number; height: number; bitrateBps: number; dummy?: 'canvas' | 'gen'; refresh?: boolean; backend?: string }): Promise<unknown> {
    if (!room || !worker) throw new Error('not connected with E2EE');
    if (!w.nativeShare) throw new Error('window.nativeShare missing (flag off or preload not applied)');
    if (o.dummy === 'canvas') dummy = createDummyShareTrack(o.fps);
    else { gen = createGeneratorShareTrack(o.fps); dummy = { track: gen.track, stop: () => gen!.stop() }; }
    dummyTrackId = dummy.track.id;
    const unbridge = bridgeNativePort(worker, dummyTrackId, window, o.dummy !== 'canvas', o.refresh === true);
    const r = await w.nativeShare.start({ backend: o.backend ?? 'vaapi', fps: o.fps, width: o.width, height: o.height, bitrateBps: o.bitrateBps });
    if (!r.ok) { unbridge(); throw new Error('start failed: ' + r.error); }
    await new Promise((res) => setTimeout(res, 300)); // let the port reach the worker before the sender's encode stream starts
    const uninstall = installE2EESenderCodecPin(room as unknown as CodecPinRoom, e2eeWorkerOf(room as never));
    void uninstall;
    await room.localParticipant.publishTrack(dummy.track, { source: Track.Source.ScreenShare, name: 'native-share', ...dummyPublishOptions(o.fps) });
    const p = pc();
    // LiveKit's screen-share preset caps the encoding at 15 fps; the dummy must be allowed to run as fast as the native encoder.
    const snd = p?.getSenders().find((x) => x.track?.id === dummyTrackId);
    if (snd) {
        const prm = snd.getParameters();
        if (prm.encodings?.length) {
            prm.encodings[0] = { ...prm.encodings[0], maxFramerate: 120, maxBitrate: 2_000_000 };
            delete (prm.encodings[0] as { scaleResolutionDownBy?: number }).scaleResolutionDownBy;
            await snd.setParameters(prm).catch((e) => events.push('setParameters failed ' + e));
        }
        events.push('sender encodings ' + JSON.stringify(snd.getParameters().encodings));
    }
    if (p) stopBitrate = startNativeBitrateLoop(() => readSenderEstimateBps(p), worker, dummyTrackId, 1000);
    return { trackId: dummyTrackId };
}

/** The normal Chromium path stand-in: a real-size animated canvas, encoded by Chromium itself (VP8), same counter blocks (offset 40000). */
async function startFallback(o: { fps: number; width: number; height: number }): Promise<unknown> {
    if (!room) throw new Error('not connected');
    const pubs = [...room.localParticipant.trackPublications.values()];
    for (const pub of pubs) if (pub.track && pub.source === Track.Source.ScreenShare) await room.localParticipant.unpublishTrack(pub.track as never, true);
    if (stopBitrate) { stopBitrate(); stopBitrate = null; }
    if (dummy) { dummy.stop(); dummy = null; }
    const c = document.createElement('canvas'); c.width = o.width; c.height = o.height;
    const g = c.getContext('2d')!; let n = 40000;
    const draw = () => {
        n++;
        g.fillStyle = `hsl(${(n * 3) % 360},60%,40%)`; g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#fff'; g.fillRect((n * 9) % c.width, (n * 5) % c.height, 120, 120);
        for (let b = 0; b < 16; b++) { g.fillStyle = (n >> (15 - b)) & 1 ? '#ebebeb' : '#101010'; g.fillRect(b * 32, 0, 32, 32); }
    };
    draw();
    const t = setInterval(draw, 1000 / o.fps);
    fallbackStop = () => clearInterval(t);
    const track = c.captureStream(o.fps).getVideoTracks()[0];
    await room.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare, name: 'fallback-share', videoCodec: 'vp8', simulcast: false, videoEncoding: { maxBitrate: 4_000_000, maxFramerate: o.fps } });
    return 'fallback published';
}

async function inbound(): Promise<AnyRec> {
    const out: AnyRec = {};
    const e = room?.engine as unknown as { pcManager?: { publisher?: { pc?: RTCPeerConnection }; subscriber?: { pc?: RTCPeerConnection } } };
    for (const p of [e?.pcManager?.subscriber?.pc, e?.pcManager?.publisher?.pc]) {
        if (!p) continue;
        (await p.getStats()).forEach((r: AnyRec) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
                for (const k of ['framesDecoded', 'framesReceived', 'framesDropped', 'keyFramesDecoded', 'pliCount', 'firCount', 'nackCount', 'frameWidth', 'frameHeight', 'framesPerSecond', 'bytesReceived', 'packetsReceived', 'packetsLost', 'decoderImplementation', 'totalDecodeTime', 'freezeCount', 'totalFreezesDuration'] as const) out[k] = r[k];
            }
        });
    }
    out.videoWidth = video.videoWidth; out.videoHeight = video.videoHeight;
    return out;
}
async function outbound(): Promise<AnyRec> {
    const p = pc(); if (!p) return {};
    const out: AnyRec = {};
    (await p.getStats()).forEach((r: AnyRec) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') for (const k of ['framesEncoded', 'keyFramesEncoded', 'frameWidth', 'frameHeight', 'framesPerSecond', 'encoderImplementation', 'targetBitrate', 'bytesSent', 'pliCount', 'firCount', 'qualityLimitationReason'] as const) out[k] = r[k];
        if (r.type === 'candidate-pair' && r.nominated) out.availableOutgoingBitrate = r.availableOutgoingBitrate;
    });
    return out;
}

const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360;
/** The 16-bit counter in the top-left 16 blocks (32 px each at source scale). Read from a 640-wide DOWNSCALED copy: cheap enough to sample at 4 Hz. */
function readCounter(): number | null {
    if (!video.videoWidth) return null;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    const k = 640 / video.videoWidth;
    cv.height = Math.round(video.videoHeight * k);
    ctx.drawImage(video, 0, 0, cv.width, cv.height);
    let v = 0;
    for (let b = 0; b < 16; b++) {
        const d = ctx.getImageData(Math.round((b * 32 + 12) * k), Math.round(12 * k), 3, 3).data;
        let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i];
        v = (v << 1) | (s / (d.length / 4) > 128 ? 1 : 0);
    }
    return v;
}
async function sampleCounters(ms: number, everyMs = 250): Promise<number[]> {
    const out: number[] = []; const end = Date.now() + ms;
    while (Date.now() < end) { const c = readCounter(); if (c !== null) out.push(c); await new Promise((r) => setTimeout(r, everyMs)); }
    return out;
}

(window as unknown as AnyRec).lab = {
    setEnc: async (on: boolean) => { await room!.setE2EEEnabled(on); return on; },
    connect, startNative, startFallback, inbound, outbound, readCounter, sampleCounters,
    testIgnorePli: (v: boolean) => worker?.postMessage({ kind: 'cl:native-test', data: { trackId: dummyTrackId, ignorePli: v } }),
    testSkip: (skipAus: number, guard: boolean) => worker?.postMessage({ kind: 'cl:native-test', data: { trackId: dummyTrackId, skipAus, guard } }),
    workerStatus: () => workerStatus, events: () => events, exitCode: () => exitCode,
    hasDummyTrack: () => !!dummy, keyFrameRequest: async () => { /* PLI is generated by the viewer itself (decoder) */ },
    disconnect: async () => { if (stopBitrate) stopBitrate(); if (fallbackStop) fallbackStop(); if (dummy) dummy.stop(); await room?.disconnect(); },
    injStats: async () => { const n = workerStatus.length; worker?.postMessage({ kind: 'cl:native-stats-req', data: { trackId: dummyTrackId } }); for (let i = 0; i < 20 && workerStatus.length === n; i++) await new Promise((r) => setTimeout(r, 50)); return workerStatus[workerStatus.length - 1]; },
    genWritten: () => gen?.written() ?? 0,
};
