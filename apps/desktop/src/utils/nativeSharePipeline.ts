/**
 * The native (Linux hardware) screen share, from the renderer's side: one object that owns the whole thing for the life of a share.
 *
 *   portal ScreenCast -> PipeWire -> NVENC (helper, main-spawned) -> access units -> MessagePort -> E2EE worker
 *        -> replace the dummy track's encoded frame BEFORE LiveKit's cryptor (E2EE intact; see nativeShareWorker.ts)
 *
 * Shaped like HdrSharePipeline on purpose: SidebarConference already knows how to run a share whose track is a generated one (no
 * getDisplayMedia handshake, own size source, no Chromium-side retuning), so a native share reuses those branches instead of adding
 * parallel ones.
 *
 * Failure is always explicit: `startNativeSharePipeline` returns { ok: false, reason } for anything that goes wrong before publishing,
 * and `onSourceEnded` fires once if it goes wrong after (helper crash, compositor stopped the source, encoder error, injection watchdog).
 * The caller falls back to the Chromium path on either. Nothing here publishes a frame that did not come from the helper.
 */
import type { HdrSharePipeline, HdrStartInfo } from './hdrSharePipeline';
import { createGeneratorShareTrack, bridgeNativePort, dummyPublishOptions, dummySimulcastPublishOptions, DUMMY_SIMULCAST_W, DUMMY_SIMULCAST_H, startNativeBitrateLoop, readSenderReading } from './nativeShareDummy';
import { shareLowEncoding } from './screenShare';
import { NATIVE_STATUS_KIND, NATIVE_AU_KIND } from './nativeShareWorker';
import { logCallEvent } from './callEventLog';
import { nativePreviewHub, NATIVE_PREVIEW_FRAME_KIND, PREVIEW_W, PREVIEW_FPS } from './nativeSharePreview';
import type { NativeShareApi, NativeBackendName } from './nativeShareApi';
export type { NativeShareApi, NativeBackendInfo, NativeBackendName } from './nativeShareApi';


/** What the preload exposes as window.nativeShare (electron/preload.ts); every call is validated in main. */

export interface NativeShareParams {
    backend: NativeBackendName;
    /** MAX encode size; the helper encodes at the source size, scaled down into this box when larger. */
    maxWidth: number; maxHeight: number;
    fps: number; bitrateBps: number;
    source: 'monitor' | 'window' | 'any';
    restoreToken?: string | null;
    /** The consent grant minted for the user's pick (captureGrant.ts): lets main bind THIS native session so its audio can start. Absent = no audio. */
    grant?: { sourceId: string; token: string } | null;
}

interface WorkerLike {
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    addEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
    removeEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
}

export interface NativeShareDeps {
    api: NativeShareApi;
    worker: WorkerLike;
    params: NativeShareParams;
    /** A new portal grant to remember (so the next share skips the chooser). */
    onRestoreToken?: (token: string) => void;
    /** PLI/FIR -> intra-refresh instead of a full IDR (needs the encoder's support; off unless the caller asks). */
    intraRefresh?: boolean;
    /**
     * Publish the share with the lighter copy (a 720p simulcast low layer) available. The CALLER decides (setting on, hardware encoder - always true
     * here - and screenShare.shareHasLowerLayer for the size); WHEN the copy actually runs is the shared gate (shareLowLayer.ts) through
     * `setLowLayer`. Needs the E2EE worker like everything else here: both layers are injected in front of the call's cryptor.
     */
    lowerLayer?: boolean;
    /** The portal chooser waits on a person: the first-format wait is long, other failures return at once. */
    startTimeoutMs?: number;
    target?: Window;
}

/** What the portal's Start said about the stream (the helper's `portal` event, re-validated here). */
export interface PortalStreamInfo {
    /** The stream's compositor rectangle (logical px) when the portal gave a position AND a size for a monitor stream; null otherwise. */
    rect: { x: number; y: number; width: number; height: number } | null;
    /** The capture was re-opened from our restore token with no chooser: a token was offered and Start answered faster than a person can. */
    restoredSilently: boolean;
    /** The grant token this capture ended up with (what the next share will offer). */
    restoreToken: string | null;
    /** The token this capture was started WITH (null when the chooser was asked for). */
    offeredToken: string | null;
}
/**
 * Should a native START that failed with `reason` switch native off for the rest of the session? Only a real encoder/helper failure should:
 * the person closing the chooser, the chooser outliving its timeout, or a stall verdict while still starting say nothing about the hardware,
 * and the next share (a fresh chooser) deserves a fresh try.
 */
export function startFailureLatchesNative(reason: string): boolean {
    return !(reason === 'portal_denied' || reason === 'start_timeout' || reason === 'injection_watchdog');
}
/** A person cannot read a chooser and click in under this; a restored grant answers in tens of ms. */
export const SILENT_RESTORE_MAX_MS = 1500;
const coord = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= -100000 && v <= 100000 ? v : null);
const dimension = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65536 ? v : null);
/** The portal event -> PortalStreamInfo. Anything that is not exactly a monitor stream with a well-formed position and size gives no rect. */
export function readPortalStream(raw: Record<string, unknown> | null, offered: string | null | undefined): PortalStreamInfo | null {
    if (!raw) return null;
    const pos = raw.position && typeof raw.position === 'object' ? raw.position as Record<string, unknown> : null;
    const x = coord(pos?.x), y = coord(pos?.y), w = dimension(raw.width), h = dimension(raw.height);
    const monitor = raw.sourceType === 1;
    const startMs = typeof raw.startMs === 'number' && Number.isFinite(raw.startMs) ? raw.startMs : 0;
    return {
        rect: monitor && x !== null && y !== null && w !== null && h !== null ? { x, y, width: w, height: h } : null,
        restoredSilently: !!offered && startMs > 0 && startMs < SILENT_RESTORE_MAX_MS,
        restoreToken: typeof raw.restoreToken === 'string' && raw.restoreToken ? raw.restoreToken : null,
        offeredToken: offered || null,
    };
}

export interface NativeSharePipeline extends HdrSharePipeline {
    /** What the portal said about the stream (position, silent restore); null until it has said anything. */
    portalStream(): PortalStreamInfo | null;
    readonly publishOptions: ReturnType<typeof dummyPublishOptions>;
    readonly encoder: string;
    readonly gpu: string;
    /** Published as a 2-layer simulcast (the lighter copy is available; it runs only while the gate says so). */
    readonly lowerLayer: boolean;
    /** Ask the helper to start (or stop) the lighter copy's encoder session. No-op on a single-layer share or after the copy failed. */
    setLowLayer(on: boolean): void;
    /** What the sender's own stats cannot say about the copy (they describe the tiny dummy track): for the shared gate. */
    lowLayerFacts(): { hardware: boolean; topShort: number; encodeMs: number; blocked: string | null };
    /** Fires once if the copy cannot run (encoder session limit, open or encode error). The share carries on with its full layer. */
    onLowLayerFailed(cb: (code: string) => void): () => void;
    /** After LiveKit published the track: lift the sender's frame-rate cap and start steering the helper's bitrate from the sender's estimate. */
    afterPublish(pc: RTCPeerConnection | null): Promise<void>;
    /** Latest encoder stats from the helper (encoded fps, resolution, encoder name) for the HUD / share_fps diagnostics. */
    liveStats(): { encoder: string; width: number; height: number; fps: number; effFps: number; dropped: number; encMsP95: number; kbps: number };
}

export type NativeStartOutcome = { ok: true; pipeline: NativeSharePipeline } | { ok: false; reason: string; detail?: string };

interface FormatEv { event: 'format'; srcW: number; srcH: number; w: number; h: number; encoder: string; gpu: string }
interface StatsEv { event: 'stats'; encoder: string; w: number; h: number; fps: number; dropped: number; encMsP95: number; kbps: number; effFps: number; low?: boolean; lowFps?: number; lowKbps?: number }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

export async function startNativeSharePipeline(d: NativeShareDeps): Promise<NativeStartOutcome> {
    const { api, worker, params } = d;
    const target = d.target ?? window;
    let gen: ReturnType<typeof createGeneratorShareTrack>;
    const dual = d.lowerLayer === true;
    try { gen = dual ? createGeneratorShareTrack(params.fps, DUMMY_SIMULCAST_W, DUMMY_SIMULCAST_H) : createGeneratorShareTrack(params.fps); } catch (e) { return { ok: false, reason: 'no_track_generator', detail: String((e as Error).message) }; }
    const trackId = gen.track.id;

    let userStopped = false, ended = false, started = false;
    let endReason = '';
    let fmt: FormatEv | null = null, stats: StatsEv | null = null;
    const endCbs = new Set<(reason: string) => void>();
    let wake: (() => void) | null = null;
    let stopBitrate: (() => void) | null = null;
    // The lighter copy: wanted = the gate asked for it; failed = the helper could not run it (latched for the share: never retried).
    let lowWanted = false, lowFailed: string | null = null;
    const lowFailCbs = new Set<(code: string) => void>();
    const sendLow = () => {
        const f0 = fmt as FormatEv | null;
        if (!dual || lowFailed || !started || ended || !f0) return;
        if (!lowWanted) { worker.postMessage({ kind: 'cl:native-low', data: { trackId, on: false } }); return; }
        const lo = shareLowEncoding(f0.w, f0.h, params.fps, 'h264');
        const w = Math.max(16, Math.floor(f0.w / lo.scaleResolutionDownBy) & ~1), h = Math.max(16, Math.floor(f0.h / lo.scaleResolutionDownBy) & ~1);
        worker.postMessage({ kind: 'cl:native-low', data: { trackId, on: true, w: Math.min(w, f0.w), h: Math.min(h, f0.h), fps: Math.max(1, Math.round(lo.maxFramerate)), bps: lo.maxBitrate } });
    };

    const end = (reason: string) => {
        if (userStopped || ended) return;
        ended = true; endReason = reason;
        logCallEvent('native_share_ended', { reason, started });
        if (wake) wake();
        for (const cb of [...endCbs]) { try { cb(reason); } catch { /* listener failed: the share is ending anyway */ } }
    };

    const onWorkerMsg = (e: MessageEvent) => {
        const m = e.data as { kind?: unknown; data?: { trackId?: unknown; state?: unknown; w?: unknown; h?: unknown; rgba?: unknown } } | undefined;
        if (!isObj(m) || !isObj(m.data) || m.data.trackId !== trackId) return;
        if (m.kind === NATIVE_PREVIEW_FRAME_KIND) {
            const { w, h, rgba } = m.data;
            if (typeof w === 'number' && typeof h === 'number' && rgba instanceof ArrayBuffer && rgba.byteLength === w * h * 4) nativePreviewHub.push({ w, h, rgba: new Uint8ClampedArray(rgba) });
        } else if (m.kind === NATIVE_AU_KIND) gen.pushTick();                          // 1:1 pacing: one dummy frame per access unit
        else if (m.kind === NATIVE_STATUS_KIND && m.data.state === 'dead') end('injection_watchdog');
    };
    worker.addEventListener('message', onWorkerMsg);
    const unbridge = bridgeNativePort(worker, trackId, target, true, d.intraRefresh === true, dual ? 2 : 1);

    let portalRaw: Record<string, unknown> | null = null;
    const offEvent = api.onEvent((raw) => {
        if (!isObj(raw)) return;
        switch (raw.event) {
            case 'portal': portalRaw = raw; if (typeof raw.restoreToken === 'string' && raw.restoreToken) d.onRestoreToken?.(raw.restoreToken); break;
            case 'format': fmt = raw as unknown as FormatEv; if (wake) wake(); if (started && lowWanted) sendLow(); break;   // a new source size: the copy is re-asked at the new size
            case 'stats': stats = raw as unknown as StatsEv; break;
            case 'fps_limited': logCallEvent('native_share_fps_limited', { fps: Number(raw.fps) || 0, requested: Number(raw.requested) || 0, enc_ms_p95: Number(raw.encMsP95) || 0 }); break;
            case 'ended': end(`source_ended:${typeof raw.reason === 'string' ? raw.reason.slice(0, 100) : ''}`); break;
            case 'low': logCallEvent('native_share_low', { on: raw.state === 'on', reason: String(raw.reason ?? '').slice(0, 40), w: Number(raw.w) || 0, h: Number(raw.h) || 0 }); break;
            case 'low_failed': {
                lowFailed = String(raw.code ?? 'low_failed').slice(0, 40); lowWanted = false;
                logCallEvent('native_share_low_failed', { code: lowFailed, msg: String(raw.message ?? '').slice(0, 160) });
                for (const cb of [...lowFailCbs]) { try { cb(lowFailed); } catch { /* listener failed: the share is unaffected */ } }
                break;
            }
            case 'error': logCallEvent('native_share_helper_error', { code: String(raw.code ?? ''), msg: String(raw.message ?? '').slice(0, 200) }); break;
            default: break;
        }
    });
    const offExit = api.onExit((x) => end(x.reason || `exit_${x.code}`));

    let stopped = false;
    const teardown = () => {
        if (stopped) return; stopped = true;
        try { nativePreviewHub.setSource(null); } catch { /* a tile's callback failed: the share is ending anyway */ }
        try { stopBitrate?.(); } catch { /* not running */ }
        try { offEvent(); offExit(); } catch { /* already unsubscribed */ }
        worker.removeEventListener('message', onWorkerMsg);
        try { unbridge(); } catch { /* done */ }
        try { void api.stop(); } catch { /* helper already gone */ }
        try { gen.stop(); } catch { /* already stopped */ }
    };

    const fail = (reason: string, detail?: string): NativeStartOutcome => { userStopped = true; teardown(); return { ok: false, reason, ...(detail ? { detail } : {}) }; };

    let res: { ok: boolean; error?: string };
    try {
        res = await api.start({
            backend: params.backend, width: params.maxWidth, height: params.maxHeight, fps: params.fps, bitrateBps: params.bitrateBps,
            capture: { source: params.source, persist: true, ...(params.restoreToken ? { restoreToken: params.restoreToken } : {}) },
            ...(params.grant ? { grant: params.grant } : {}),
        });
    } catch (e) { return fail('start_threw', String((e as Error).message)); }
    if (!res.ok) return fail('start_rejected', res.error);

    // Wait for the helper's first `format` event (portal granted + first frame + encoder open), a failure, or the timeout.
    const timeoutMs = d.startTimeoutMs ?? 130_000;
    await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        wake = () => { clearTimeout(t); resolve(); };
        if (fmt || ended) wake();
    });
    wake = null;
    if (ended) return fail(endReason || 'helper_failed');
    const f = fmt as FormatEv | null;
    if (!f) return fail('start_timeout');
    if (!(f.w >= 2 && f.h >= 2)) return fail('bad_format');
    // The port was handed to the page at start; let the worker bind it before the sender's encode stream begins (measured need: harness).
    await new Promise((r) => setTimeout(r, 300));
    if (ended) return fail(endReason || 'helper_failed');
    started = true;
    worker.postMessage({ kind: 'cl:native-arm', data: { trackId } });   // from here AUs are owed: the worker's stall watchdog (idle through the chooser) starts
    // The sharer's own tile asks for thumbnails only while it is on screen (nativeSharePreview.ts); until then the helper does nothing extra.
    nativePreviewHub.setSource({ request: (on) => { if (!ended && !userStopped) worker.postMessage({ kind: 'cl:native-preview', data: { trackId, on, w: PREVIEW_W, fps: PREVIEW_FPS } }); } });

    const lowEnc = shareLowEncoding(f.w, f.h, params.fps, 'h264');
    const info: HdrStartInfo = { width: f.w, height: f.h, srcWidth: f.srcW || f.w, srcHeight: f.srcH || f.h, hdr: false, inputFormat: 'bgrx', sdrWhiteNits: 0, peakNits: 0, knee: 0 };
    const pipeline: NativeSharePipeline = {
        track: gen.track,
        session: 0,
        info,
        publishOptions: (dual ? dummySimulcastPublishOptions(params.fps, { maxBitrate: Math.max(400_000, params.bitrateBps) }, lowEnc) : dummyPublishOptions(params.fps, params.bitrateBps)) as ReturnType<typeof dummyPublishOptions>,
        lowerLayer: dual,
        setLowLayer(on) { if (!dual || lowFailed || userStopped || ended || lowWanted === on) return; lowWanted = on; sendLow(); },
        lowLayerFacts: () => {
            const s = stats as StatsEv | null, fm = fmt as FormatEv | null;
            return { hardware: (s?.encoder || fm?.encoder || f.encoder) !== 'pcm', topShort: Math.min(fm?.w ?? f.w, fm?.h ?? f.h), encodeMs: s?.encMsP95 ?? 0, blocked: lowFailed ? `lighter copy failed (${lowFailed})` : null };
        },
        onLowLayerFailed(cb) { lowFailCbs.add(cb); if (lowFailed) queueMicrotask(() => { if (lowFailCbs.has(cb) && lowFailed) cb(lowFailed); }); return () => { lowFailCbs.delete(cb); }; },
        encoder: f.encoder,
        gpu: f.gpu,
        portalStream: () => readPortalStream(portalRaw, params.restoreToken),
        onSourceEnded(cb) {
            endCbs.add(cb);
            if (ended) queueMicrotask(() => { if (endCbs.delete(cb)) cb(endReason); });
            return () => { endCbs.delete(cb); };
        },
        captureSettings: () => ({ width: (fmt as FormatEv | null)?.w ?? info.width, height: (fmt as FormatEv | null)?.h ?? info.height, frameRate: (stats as StatsEv | null)?.fps ?? 0 }),
        stats: () => ({ written: gen.written(), dropped: (stats as StatsEv | null)?.dropped ?? 0 }),
        liveStats: () => {
            const s = stats as StatsEv | null, fm = fmt as FormatEv | null;
            return { encoder: s?.encoder || fm?.encoder || f.encoder, width: s?.w || fm?.w || f.w, height: s?.h || fm?.h || f.h, fps: s?.fps ?? 0, effFps: s?.effFps ?? 0, dropped: s?.dropped ?? 0, encMsP95: s?.encMsP95 ?? 0, kbps: s?.kbps ?? 0 };
        },
        async afterPublish(pc) {
            if (!pc || userStopped || ended) return;
            // LiveKit's screen-share preset caps the sender at 15 fps; the dummy must be allowed to run as fast as the native encoder.
            const snd = pc.getSenders().find((x) => x.track?.id === trackId);
            if (snd) {
                try {
                    const prm = snd.getParameters();
                    if (prm.encodings?.length) {
                        // Two layers (rids q = low, h = full): neither is frame-rate capped (the helper paces each), and the low one keeps a
                        // real 2:1 step below the full one so the two dummy layers differ in size even though LiveKit computed a scale of 1 for both.
                        prm.encodings = prm.encodings.map((e, i) => {
                            const isLow = prm.encodings.length > 1 && (e.rid === 'q' || (!e.rid && i === 0));
                            const next = { ...e, maxFramerate: 120, ...(isLow ? { scaleResolutionDownBy: 2 } : { maxBitrate: Math.max(400_000, params.bitrateBps) }) };
                            if (!isLow) delete (next as { scaleResolutionDownBy?: number }).scaleResolutionDownBy;
                            return next;
                        });
                        await snd.setParameters(prm);
                    }
                } catch (e) { logCallEvent('native_share_sender_params_failed', { msg: String((e as Error).message).slice(0, 120) }); }
            }
            stopBitrate = startNativeBitrateLoop(() => readSenderReading(pc), worker as unknown as { postMessage(msg: unknown, transfer?: Transferable[]): void }, trackId, 1000, params.bitrateBps);
        },
        stop() { userStopped = true; teardown(); },
    };
    return { ok: true, pipeline };
}
