/**
 * Renderer side of the native share encoder (SPIKE, off by default).
 * The "screen share" is published as a tiny animated canvas track that exists
 * only to give Chromium's RTP sender (and the SFU, and LiveKit's cryptor) a
 * stream to carry; the E2EE worker swaps each dummy frame's bytes for the
 * native encoder's access unit (utils/nativeShareWorker.ts).
 */
import { VideoPreset } from 'livekit-client';
import { BitrateController, type PathSignals } from './nativeShareInject';

export interface DummyShare { track: MediaStreamTrack; stop(): void }

/** A small canvas whose pixels change every frame (a static canvas would make Chromium send almost nothing). */
export function createDummyShareTrack(fps: number, width = 128, height = 72): DummyShare {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    let n = 0;
    const draw = () => {
        n++;
        ctx.fillStyle = `rgb(${(n * 7) % 256},${(n * 3) % 256},${(n * 11) % 256})`;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#fff'; ctx.fillRect((n * 5) % width, (n * 3) % height, 16, 16);
    };
    draw();
    const stream = canvas.captureStream(fps);
    const timer = setInterval(draw, Math.max(1, Math.floor(1000 / fps) - 1));
    const track = stream.getVideoTracks()[0];
    return { track, stop: () => { clearInterval(timer); track.stop(); } };
}

/**
 * The 1:1 variant: a MediaStreamTrackGenerator the NATIVE encoder drives. The worker posts `cl:native-au` for every access unit it
 * receives; `pushTick` writes exactly one tiny VideoFrame per call, so Chromium's encoder emits exactly one dummy frame per AU and the
 * injector's queue never overflows (no gaps, no forced IDRs from cadence mismatch). Frame content is a reused buffer with one pixel
 * changed per frame (identical frames invite encoder frame-skipping).
 */
export interface GeneratorShare { track: MediaStreamTrack; pushTick(): void; stop(): void; written(): number }
export function createGeneratorShareTrack(fps: number, width = 128, height = 72): GeneratorShare {
    const Gen = (globalThis as unknown as { MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> } }).MediaStreamTrackGenerator;
    if (!Gen) throw new Error('MediaStreamTrackGenerator unavailable');
    const gen = new Gen({ kind: 'video' });
    const writer = gen.writable.getWriter();
    const buf = new Uint8Array(width * height * 4).fill(96);
    let n = 0, inflight = 0;
    return {
        track: gen,
        written: () => n,
        pushTick() {
            if (inflight > 8) return; // writer backed up: the encoder is the bottleneck; AU queue guard handles the rest
            buf[(n * 4) % buf.length] = (n * 7) & 255;
            const f = new VideoFrame(buf, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: Math.round((n * 1e6) / fps) });
            n++; inflight++;
            writer.write(f).catch(() => { /* track stopped */ }).finally(() => { inflight--; f.close(); });
        },
        stop() { try { void writer.close(); } catch { /* closed */ } gen.stop(); },
    };
}

/** LiveKit publish options for the dummy: H.264, ONE layer, frame rate over resolution, tiny encoder budget (it carries no real picture). */
export function dummyPublishOptions(fps: number, maxBitrate = 400_000) {
    return {
        videoCodec: 'h264' as const,
        simulcast: false,
        backupCodec: false as const,
        degradationPreference: 'maintain-framerate' as const,
        videoEncoding: { maxBitrate: Math.max(400_000, maxBitrate), maxFramerate: Math.max(fps, 30) + 30 },
    };
}

/**
 * LiveKit publish options for the dummy WITH the lighter copy: a 2-layer simulcast (rids q = low, h = full), exactly how the Chromium share
 * publishes it (screenShare.buildScreenSharePublishOptions), so the SFU, the viewers' layer picking (remoteVideoQuality) and the gate
 * (shareLowLayer.ts) see no difference. `low` is the lighter copy's real ceiling (what the helper's second session is told), because
 * LiveKit advertises each layer's maxBitrate to the SFU for its allocation. The dummy track must be >= 480 px on its long side or LiveKit
 * collapses the simulcast to one layer (computeVideoEncodings) - see DUMMY_SIMULCAST_W/H.
 */
export const DUMMY_SIMULCAST_W = 480;
export const DUMMY_SIMULCAST_H = 270;
export function dummySimulcastPublishOptions(fps: number, full: { maxBitrate: number }, low: { maxBitrate: number; maxFramerate: number }) {
    return {
        videoCodec: 'h264' as const,
        simulcast: true,
        backupCodec: false as const,
        degradationPreference: 'maintain-framerate' as const,
        screenShareEncoding: { maxBitrate: full.maxBitrate, maxFramerate: Math.max(fps, 30) + 30, priority: 'high' as RTCPriorityType },
        screenShareSimulcastLayers: [new VideoPreset(1280, 720, low.maxBitrate, low.maxFramerate, 'high')],
    };
}

interface WorkerLike { postMessage(msg: unknown, transfer?: Transferable[]): void }

/** Forward the main-process port (handed over by the preload as window message `cl:native-share-port`) to the E2EE worker. */
export function bridgeNativePort(worker: WorkerLike, trackId: string, target: Window = window, tick = false, refresh = false, layers: 1 | 2 = 1): () => void {
    const onMsg = (ev: MessageEvent) => {
        if (ev.source !== target || ev.data?.kind !== 'cl:native-share-port' || !ev.ports?.length) return;
        worker.postMessage({ kind: 'cl:native-share', data: { trackId, port: ev.ports[0], tick, refresh, ...(layers === 2 ? { layers } : {}) } }, [ev.ports[0]]);
        target.removeEventListener('message', onMsg);
    };
    target.addEventListener('message', onMsg);
    return () => target.removeEventListener('message', onMsg);
}

/** A bandwidth estimate alone, or with what the path says (loss, RTT) so the controller may probe above the estimate. */
export type SenderReading = number | (PathSignals & { estimateBps: number });

/**
 * Drive the native encoder's target from the sender's bandwidth estimate. `ceilingBps` (the share's real target) lets the controller
 * lead the estimate while the path is clean (BitrateController); without it, or without signals, it only follows. Returns the stop function.
 */
export function startNativeBitrateLoop(
    readEstimateBps: () => Promise<SenderReading | null>,
    worker: WorkerLike,
    trackId: string,
    intervalMs = 1000,
    ceilingBps: number | null = null,
): () => void {
    const ctl = new BitrateController(() => Date.now(), undefined, ceilingBps);
    const t = setInterval(async () => {
        try {
            const r = await readEstimateBps();
            const bps = r === null ? null : typeof r === 'number' ? ctl.update(r) : ctl.update(r.estimateBps, { lossPct: r.lossPct, rttMs: r.rttMs });
            if (bps !== null) worker.postMessage({ kind: 'cl:native-bitrate', data: { trackId, bps } });
        } catch { /* stats unavailable: keep the current target */ }
    }, intervalMs);
    return () => clearInterval(t);
}

/** availableOutgoingBitrate of the selected candidate pair (falls back to the sum of outbound-rtp targetBitrate). */
export async function readSenderEstimateBps(pc: RTCPeerConnection): Promise<number | null> {
    return (await readSenderReading(pc))?.estimateBps ?? null;
}

/** The estimate plus the path signals: the receiver's reported loss (worst video layer) and the round-trip time. */
export async function readSenderReading(pc: RTCPeerConnection): Promise<(PathSignals & { estimateBps: number }) | null> {
    const stats = await pc.getStats();
    let avail: number | null = null, target = 0, loss: number | null = null, rtt: number | null = null;
    stats.forEach((r: Record<string, unknown>) => {
        if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) {
            if (typeof r.availableOutgoingBitrate === 'number') avail = r.availableOutgoingBitrate as number;
            if (typeof r.currentRoundTripTime === 'number' && r.currentRoundTripTime > 0) rtt = (r.currentRoundTripTime as number) * 1000;
        }
        if (r.type === 'outbound-rtp' && r.kind === 'video' && typeof r.targetBitrate === 'number') target += r.targetBitrate as number;
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video' && typeof r.fractionLost === 'number') loss = Math.max(loss ?? 0, (r.fractionLost as number) * 100);
    });
    const estimateBps = avail ?? (target > 0 ? target : null);
    return estimateBps === null ? null : { estimateBps, lossPct: loss, rttMs: rtt };
}
