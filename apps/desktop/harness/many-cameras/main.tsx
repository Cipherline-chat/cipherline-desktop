/**
 * Many-camera call harness page (see README.md). One page is either
 *
 *   PUBLISHERS  N LiveKit Rooms in this one page, each a separate "participant":
 *               own PeerConnection, own E2EE worker, a synthetic 640x360 camera
 *               (animated canvas -> captureStream) published with the app's
 *               simulcast ladder (180p / 360p) and the shared E2EE key; or
 *
 *   VIEWER      one Room that subscribes to everyone and draws a grid of <video>
 *               tiles, choosing each tile's layer and which tiles are decoded
 *               with the APP's code (remoteVideoQuality.ts: pickTileLayer,
 *               claimRemoteQuality, chooseDecodedSet, DECODE_CAP/AUTO_DECODE_CAP;
 *               remoteVideoDemand.ts: retainRemoteVideo), E2EE on.
 *
 * Viewer policies (`policy`):
 *   high    every tile asks for the top layer, nothing capped      (naive reference)
 *   layers  per-tile layer by size, nothing capped                 (the app before this change in 'auto')
 *   capped  per-tile layer by size + AUTO_DECODE_CAP decoded tiles, overflow = avatars (the app now)
 *
 * window.H is driven by run.mjs (Playwright).
 */
import {
    Room, RoomEvent, Track, LocalVideoTrack, ExternalE2EEKeyProvider, VideoPreset, VideoQuality,
    type RemoteTrackPublication, type RemoteParticipant, type RoomOptions,
} from 'livekit-client';
import e2eeWorkerUrl from '../../src/workers/e2eeWorker?worker&url';
import { stableE2EEOptions } from '../../src/utils/e2eeRoomOptions';
import { installE2EEKey } from '../../src/utils/e2eeActivation';
import {
    claimRemoteQuality, pickTileLayer, normaliseLayers, displayedPixels, chooseDecodedSet, decodeCapFor,
    type QualityClaim, type IncomingVideoMode,
} from '../../src/utils/remoteVideoQuality';
import { retainRemoteVideo, noteRemoteVideoSubscribed } from '../../src/utils/remoteVideoDemand';

const log = (m: string) => console.info(`harness: ${m}`);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function roomOptions(keyProvider: ExternalE2EEKeyProvider, worker: Worker): RoomOptions {
    return {
        adaptiveStream: false,
        dynacast: true,
        publishDefaults: {
            simulcast: true,
            videoSimulcastLayers: [new VideoPreset(320, 180, 200_000, 15)],
            red: false, dtx: false,
        },
        encryption: stableE2EEOptions(keyProvider, worker),
    };
}

async function newRoom(url: string, token: string, keyB64: string, autoSubscribe = true): Promise<{ room: Room; worker: Worker }> {
    const keyProvider = new ExternalE2EEKeyProvider();
    const worker = new Worker(e2eeWorkerUrl, { type: 'module' });
    const room = new Room(roomOptions(keyProvider, worker));
    await installE2EEKey(keyProvider, keyB64);
    await room.connect(url, token, { rtcConfig: { iceServers: [] }, autoSubscribe });
    await room.setE2EEEnabled(true);
    return { room, worker };
}

// ── publishers ──────────────────────────────────────────────────────────────

const pubs: Room[] = [];

function makeCameraTrack(i: number, w: number, h: number, fps: number): LocalVideoTrack {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    let n = 0;
    const draw = () => {
        n++;
        ctx.fillStyle = `hsl(${(i * 37 + n * 2) % 360} 60% 35%)`;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#fff';
        for (let k = 0; k < 24; k++) ctx.fillRect((n * (3 + k) + k * 53) % w, (k * 41 + n) % h, 28, 28);
        ctx.font = '48px sans-serif';
        ctx.fillText(`cam ${i}`, 24, 64);
    };
    draw();
    setInterval(draw, 1000 / fps);
    const track = canvas.captureStream(fps).getVideoTracks()[0];
    return new LocalVideoTrack(track, undefined, false);
}

async function startPublishers(o: { url: string; tokens: string[]; key: string; w: number; h: number; fps: number; batch?: number; offset?: number }): Promise<{ joined: number }> {
    let joined = 0;
    const one = async (i: number) => {
        // Publishers subscribe to nobody: they stand in for people whose own decode cost is not what is measured.
        const { room } = await newRoom(o.url, o.tokens[i], o.key, false);
        pubs.push(room);
        const lv = makeCameraTrack((o.offset ?? 0) + i, o.w, o.h, o.fps);
        await room.localParticipant.publishTrack(lv, {
            source: Track.Source.Camera, name: 'camera', simulcast: true, videoCodec: 'vp8',
            videoSimulcastLayers: [new VideoPreset(320, 180, 200_000, o.fps)],
            videoEncoding: { maxBitrate: 600_000, maxFramerate: o.fps },
        });
        joined++;
    };
    const batch = Math.max(1, o.batch ?? 1);
    for (let i = 0; i < o.tokens.length; i += batch) {
        await Promise.all(Array.from({ length: Math.min(batch, o.tokens.length - i) }, (_, k) => one(i + k)));
    }
    return { joined };
}

// ── viewer ──────────────────────────────────────────────────────────────────

interface Tile { pub: RemoteTrackPublication; p: RemoteParticipant; el: HTMLVideoElement; release: () => void; claim: QualityClaim }
let viewer: Room | null = null;
let viewerWorker: Worker | null = null;
const tiles = new Map<string, Tile>();
let cfg = { policy: 'capped' as 'high' | 'layers' | 'capped', mode: 'auto' as IncomingVideoMode, cols: 7, cellW: 200, cellH: 112, dpr: 1, cap: 0, countAsTiles: 0 };
const encErrors: string[] = [];
let gridEl: HTMLDivElement | null = null;

function remoteCameras(): { p: RemoteParticipant; pub: RemoteTrackPublication }[] {
    const out: { p: RemoteParticipant; pub: RemoteTrackPublication }[] = [];
    if (!viewer) return out;
    for (const p of viewer.remoteParticipants.values()) {
        const pub = p.getTrackPublication(Track.Source.Camera) as RemoteTrackPublication | undefined;
        if (pub) out.push({ p, pub });
    }
    return out.sort((a, b) => a.p.identity.localeCompare(b.p.identity));
}

/** Which identities get a decoded tile, per the policy. */
function decodedSet(order: string[]): Set<string> {
    if (cfg.policy !== 'capped') return new Set(order);
    const cap = cfg.cap > 0 ? cfg.cap : decodeCapFor(cfg.mode);
    return chooseDecodedSet({ order, focused: null, recentSpeakers: [], cap }) ?? new Set(order);
}

function reconcile(): void {
    if (!viewer || !gridEl) return;
    const cams = remoteCameras();
    const want = decodedSet(cams.map(c => c.p.identity));
    const count = want.size;
    for (const [id, t] of [...tiles]) {
        if (!want.has(id) || !cams.find(c => c.p.identity === id)) {
            t.release(); t.claim.release(); t.pub.track?.detach(t.el); t.el.remove(); tiles.delete(id);
        }
    }
    for (const { p, pub } of cams) {
        if (!want.has(p.identity) || tiles.has(p.identity) || !pub.track) continue;
        const el = document.createElement('video');
        el.autoplay = true; el.muted = true; el.playsInline = true;
        el.style.cssText = `width:${cfg.cellW}px;height:${cfg.cellH}px;object-fit:contain;background:#111`;
        gridEl.appendChild(el);
        pub.track.attach(el);
        const claim = claimRemoteQuality(pub);
        const release = retainRemoteVideo(pub);
        tiles.set(p.identity, { pub, p, el, release, claim });
    }
    // The layer each tile asks for (same inputs the app's VideoTile gives pickTileLayer).
    for (const t of tiles.values()) {
        if (cfg.policy === 'high') { t.claim.set(VideoQuality.HIGH); continue; }
        const layers = normaliseLayers((t.pub.trackInfo?.layers ?? []) as { quality?: number; width?: number; height?: number }[]);
        const need = displayedPixels(cfg.cellW, cfg.cellH, cfg.dpr, 16 / 9, 'contain');
        t.claim.set(pickTileLayer({ need, layers, role: 'grid', count: Math.max(count, cfg.countAsTiles), mode: cfg.mode }));
    }
}

async function startViewer(o: { url: string; token: string; key: string; policy: string; mode: string; cols: number; cellW: number; cellH: number; cap: number }): Promise<void> {
    cfg = { ...cfg, policy: o.policy as typeof cfg.policy, mode: o.mode as IncomingVideoMode, cols: o.cols, cellW: o.cellW, cellH: o.cellH, cap: o.cap };
    gridEl = document.createElement('div');
    gridEl.style.cssText = `display:grid;grid-template-columns:repeat(${o.cols},${o.cellW}px);gap:2px`;
    document.body.appendChild(gridEl);
    const r = await newRoom(o.url, o.token, o.key);
    viewer = r.room; viewerWorker = r.worker;
    viewer.on(RoomEvent.EncryptionError, e => { encErrors.push(String((e as Error)?.message ?? e).slice(0, 80)); });
    // As CallPane does: a subscribed video no tile claims within PAUSE_AFTER_MS is paused at the SFU.
    viewer.on(RoomEvent.TrackSubscribed, (_t, pub) => noteRemoteVideoSubscribed(pub as RemoteTrackPublication));
    for (const ev of [RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackPublished]) viewer.on(ev, () => reconcile());
    setInterval(reconcile, 1500);
    reconcile();
}

interface Sample {
    tiles: number; remoteCams: number; inboundActive: number; inboundTotal: number;
    decPerSec: number; decMpxPerSec: number; decoders: Record<string, number>; heights: Record<string, number>;
    framesDecodedTotal: number; keyFramesTotal: number; encErrors: number; jbMs: number; videoFramesPresentedPerSec: number;
}
let prev: { at: number; frames: number; px: number; shown: number } | null = null;

async function sample(): Promise<Sample> {
    const cams = remoteCameras();
    const s: Sample = { tiles: tiles.size, remoteCams: cams.length, inboundActive: 0, inboundTotal: 0, decPerSec: 0, decMpxPerSec: 0, decoders: {}, heights: {}, framesDecodedTotal: 0, keyFramesTotal: 0, encErrors: encErrors.length, jbMs: 0, videoFramesPresentedPerSec: 0 };
    if (!viewer) return s;
    // livekit-client may run ONE peer connection (`publisher` carries the inbound streams) or two.
    const pm = (viewer.engine as unknown as { pcManager?: { subscriber?: { getStats(): Promise<RTCStatsReport> }; publisher?: { getStats(): Promise<RTCStatsReport> } } }).pcManager;
    const reps = await Promise.all([pm?.subscriber?.getStats(), pm?.publisher?.getStats()].filter(Boolean) as Promise<RTCStatsReport>[]);
    const rep = { forEach: (cb: (r: Record<string, unknown>) => void) => reps.forEach(r => r.forEach(cb as never)) };
    let frames = 0, px = 0, jbD = 0, jbN = 0;
    const lastFrames = (sample as unknown as { _l?: Map<string, number> })._l ?? new Map<string, number>();
    (sample as unknown as { _l?: Map<string, number> })._l = lastFrames;
    rep.forEach((r: Record<string, unknown>) => {
        if (r.type !== 'inbound-rtp' || (r.kind ?? r.mediaType) !== 'video') return;
        s.inboundTotal++;
        const fd = Number(r.framesDecoded ?? 0);
        const id = String(r.id);
        const d = fd - (lastFrames.get(id) ?? fd);
        lastFrames.set(id, fd);
        if (d > 0) {
            s.inboundActive++;
            frames += d;
            px += d * Number(r.frameWidth ?? 0) * Number(r.frameHeight ?? 0);
            const h = String(r.frameHeight ?? '?'); s.heights[h] = (s.heights[h] ?? 0) + 1;
        }
        s.framesDecodedTotal += fd;
        s.keyFramesTotal += Number(r.keyFramesDecoded ?? 0);
        const dec = String(r.decoderImplementation ?? '?'); s.decoders[dec] = (s.decoders[dec] ?? 0) + 1;
        jbD += Number(r.jitterBufferDelay ?? 0); jbN += Number(r.jitterBufferEmittedCount ?? 0);
    });
    let shown = 0;
    for (const t of tiles.values()) { const q = t.el.getVideoPlaybackQuality?.(); if (q) shown += q.totalVideoFrames - q.droppedVideoFrames; }
    const now = performance.now();
    if (prev) {
        const dt = (now - prev.at) / 1000;
        s.decPerSec = Math.round((frames / dt) * 10) / 10;
        s.decMpxPerSec = Math.round((px / dt / 1e6) * 100) / 100;
        s.videoFramesPresentedPerSec = Math.round(((shown - prev.shown) / dt) * 10) / 10;
    }
    prev = { at: now, frames, px, shown };
    s.jbMs = jbN > 0 ? Math.round((jbD / jbN) * 1000) : 0;
    return s;
}

/** E2EE proof: how many decoded frames / how many tiles actually painted pixels. */
async function proof(): Promise<{ framesDecoded: number; keyFrames: number; encErrors: number; paintedTiles: number; tiles: number; decoders: Record<string, number> }> {
    const s = await sample();
    let painted = 0;
    for (const t of tiles.values()) {
        const c = document.createElement('canvas'); c.width = 16; c.height = 9;
        const g = c.getContext('2d')!;
        try {
            if (t.el.videoWidth > 0 && t.el.readyState >= 2) { g.drawImage(t.el.srcObject ? t.el : t.el, 0, 0, 16, 9); const d = g.getImageData(0, 0, 16, 9).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]; if (sum > 0) painted++; }
        } catch { /* tainted / not ready */ }
    }
    return { framesDecoded: s.framesDecodedTotal, keyFrames: s.keyFramesTotal, encErrors: encErrors.length, paintedTiles: painted, tiles: tiles.size, decoders: s.decoders };
}

async function dbg(): Promise<unknown> {
    const eng = (viewer as unknown as { engine?: { pcManager?: Record<string, unknown> } })?.engine;
    const pm = eng?.pcManager as { subscriber?: { getStats(): Promise<RTCStatsReport> }; publisher?: { getStats(): Promise<RTCStatsReport> } } | undefined;
    const types: Record<string, number> = {};
    for (const k of ['subscriber', 'publisher'] as const) {
        const r = await pm?.[k]?.getStats();
        r?.forEach((v: { type: string }) => { types[`${k}:${v.type}`] = (types[`${k}:${v.type}`] ?? 0) + 1; });
    }
    return { pmKeys: Object.keys(pm ?? {}), engKeys: Object.keys(eng ?? {}).slice(0, 20), types };
}

(window as unknown as { H: unknown }).H = {
    dbg, startPublishers, startViewer, sample, proof, log,
    stop: async () => { for (const r of pubs) await r.disconnect(); await viewer?.disconnect(); viewerWorker?.terminate(); },
};
log('ready');
