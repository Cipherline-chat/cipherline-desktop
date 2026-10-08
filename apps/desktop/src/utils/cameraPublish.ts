/**
 * Publishing the camera with the ladder from cameraQuality.ts.
 *
 * LiveKit's setCameraEnabled(true) captures with the Room's fixed
 * videoCaptureDefaults and publishes with the fixed publishDefaults — both
 * decided before we know what the camera can do. The ladder has to come from
 * the ACTUAL capture size (a 720p camera must not get a 1440p ladder, and a
 * 1440p camera's mid layer is 720p, not 360p), so the FIRST publish of a call
 * goes through here: capture → read the real settings → step down if the
 * mode is slow → build the ladder → publishTrack. Later toggles still use
 * setCameraEnabled, which only mutes/unmutes the publication this created
 * (LiveKit restarts it with the same constraints and options).
 *
 * E2EE is untouched: the track is published through the same
 * LocalParticipant on the same E2EE-enabled Room, exactly like
 * setCameraEnabled would; nothing here can publish outside it.
 *
 * Every LiveKit call is on a narrow structural interface so the logic is
 * testable with fakes (cameraPublish.test.ts).
 */
import { Track, VideoPreset, type LocalParticipant, type LocalVideoTrack, type TrackPublishOptions } from 'livekit-client';
import {
    captureResolutionFor, cameraPublishPlan, nextStepDown, judgeHardwareCameraStart, decideCameraCodec, effectiveTier,
    type CameraQualityTier, type CameraCodecDecision, type CameraCodecPref, type CameraHwSupport,
    type GpuVendorLike, type LayerEncodeReport, type CameraPublishPlan, type CameraCodec, HEVC_CAMERA_DECISION,
} from './cameraQuality';
import { isHardwareCodec } from './streamStatsHud';
import { logCallEvent } from './callEventLog';
import { markHevcFailed } from './hevcNegotiation';

/** How long both publications coexist in a make-before-break republish. */
export const REPUBLISH_HOLD_MS = 1500;
export const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** LiveKit's stored videoCodec → our camera codec. */
export function asCameraCodec(c: string | undefined): CameraCodec {
    return c === 'h264' || c === 'h265' ? c : 'vp8';
}

// ── Narrow shapes ──────────────────────────────────────────────────────────

export interface CameraTrackLike {
    mediaStreamTrack: MediaStreamTrack;
    sender?: RTCRtpSender;
    source?: Track.Source;
    restartTrack(options?: { resolution?: { width: number; height: number; frameRate?: number }; deviceId?: ConstrainDOMString }): Promise<void>;
    stop(): void;
    /** The constraints LiveKit captured with (carries the deviceId). */
    readonly constraints?: MediaTrackConstraints;
    /** LiveKit @internal fields (LocalVideoTrack): read/written defensively. */
    publishOptions?: TrackPublishOptions;
    lastEncodedDimensions?: { width: number; height: number };
}

export interface CameraParticipantLike {
    getTrackPublication(source: Track.Source): { track?: unknown; isMuted?: boolean } | undefined;
    setCameraEnabled(enabled: boolean): Promise<unknown>;
    createTracks(options: { video: { resolution: { width: number; height: number; frameRate: number } } }): Promise<unknown[]>;
    publishTrack(track: never, options: TrackPublishOptions): Promise<unknown>;
    unpublishTrack(track: never, stopOnUnpublish?: boolean): Promise<unknown>;
}

// ── Session state (module-level, per app run) ──────────────────────────────

/** What the camera was last published with — the HUD and the load offer read it. */
export interface CameraPublishState {
    tier: CameraQualityTier;
    capture: { width: number; height: number; frameRate: number };
    codec: CameraCodecDecision;
    plan: CameraPublishPlan;
}
let lastState: CameraPublishState | null = null;
const stateListeners = new Set<() => void>();
function setState(s: CameraPublishState | null) {
    lastState = s;
    for (const l of [...stateListeners]) { try { l(); } catch { /* isolate */ } }
}
export function getCameraPublishState(): CameraPublishState | null { return lastState; }
export function subscribeCameraPublishState(cb: () => void): () => void {
    stateListeners.add(cb);
    return () => { stateListeners.delete(cb); };
}

/** An H.264 camera that failed its start check: VP8 for the rest of the run. */
let hwCameraFailed = false;
export function hasHwCameraFailed(): boolean { return hwCameraFailed; }
export function markHwCameraFailed(): void { hwCameraFailed = true; }
/** Test-only. */
export function __resetCameraPublishForTests(): void { hwCameraFailed = false; lastState = null; inFlight = new WeakMap(); }

let inFlight = new WeakMap<object, Promise<void>>();

// ── Capture ────────────────────────────────────────────────────────────────

function readSettings(track: CameraTrackLike): { width: number; height: number; frameRate: number } {
    const s = track.mediaStreamTrack.getSettings?.() ?? {};
    return { width: s.width ?? 0, height: s.height ?? 0, frameRate: s.frameRate ?? 0 };
}

function readCaps(track: CameraTrackLike): { height?: { max?: number } } | null {
    try {
        const c = (track.mediaStreamTrack as MediaStreamTrack & { getCapabilities?: () => MediaTrackCapabilities }).getCapabilities?.();
        return c ? { height: { max: typeof c.height?.max === 'number' ? c.height.max : undefined } } : null;
    } catch {
        return null;
    }
}

/**
 * LiveKit's restartTrack REPLACES the stored constraints (LocalTrack.restart)
 * and defaults a missing deviceId to 'default' — so a resolution change must
 * carry the device it is already on, or a tier change would silently jump to
 * the system default camera.
 */
export function restartOptions(track: CameraTrackLike, tier: CameraQualityTier) {
    const deviceId = track.constraints?.deviceId;
    return { resolution: captureResolutionFor(tier), ...(deviceId !== undefined ? { deviceId } : {}) };
}

/**
 * Settle the capture mode: while the camera delivers < 24 fps, restart it a
 * tier lower (at most two steps). Returns the final settings. A restart that
 * throws (device gone) keeps what we have.
 */
export async function settleCaptureMode(
    track: CameraTrackLike,
    log: (m: string) => void = () => {},
): Promise<{ width: number; height: number; frameRate: number }> {
    let settings = readSettings(track);
    const caps = readCaps(track);
    for (let i = 0; i < 2; i++) {
        const next = nextStepDown(settings, caps);
        if (!next) break;
        log(`[Camera] ${settings.width}x${settings.height}@${settings.frameRate} is too slow — trying ${next}`);
        try {
            await track.restartTrack(restartOptions(track, next));
        } catch (e) {
            log(`[Camera] step-down to ${next} failed: ${String(e)}`);
            break;
        }
        settings = readSettings(track);
    }
    return settings;
}

// ── Publish options ────────────────────────────────────────────────────────

export function toLiveKitPublishOptions(plan: CameraPublishPlan): TrackPublishOptions {
    return {
        source: Track.Source.Camera,
        simulcast: plan.simulcast,
        videoCodec: plan.videoCodec,
        backupCodec: plan.backupCodec,
        videoEncoding: { ...plan.videoEncoding },
        videoSimulcastLayers: plan.lower.map(l => new VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate)),
        degradationPreference: plan.degradationPreference,
    };
}

// ── Codec ──────────────────────────────────────────────────────────────────

export interface CodecInputs {
    pref: CameraCodecPref;
    probe: (w: number, h: number, fps: number) => Promise<CameraHwSupport | null>;
    gpus: () => Promise<readonly GpuVendorLike[] | null>;
}

export async function chooseCameraCodec(inputs: CodecInputs, width: number, height: number): Promise<CameraCodecDecision> {
    const [hw, gpus] = await Promise.all([
        inputs.probe(width, height, 30).catch(() => null),
        inputs.gpus().catch(() => null),
    ]);
    return decideCameraCodec(inputs.pref, hw, gpus, { hwFailed: hwCameraFailed });
}

// ── Start ──────────────────────────────────────────────────────────────────

export interface StartCameraOptions {
    tier: CameraQualityTier;
    codec: CodecInputs;
    /** Called with H.264 High intent BEFORE publishTrack (the localSenderCreated hook reads it). */
    setWantH264High?: (on: boolean) => void;
    log?: (m: string) => void;
    /** Run the post-start hardware check (default true). */
    watchHardware?: boolean;
    sleep?: (ms: number) => Promise<void>;
    /** Test seam: forced codec (the VP8 republish). */
    forceCodec?: CameraCodecDecision;
    /** One layer only (1:1 call — cameraQuality.CameraLayeringPolicy). Default: simulcast. */
    single?: boolean;
    /** The room negotiation allows H.265 and this machine HW-encodes it (hevcNegotiation.ts). */
    hevc?: boolean;
    /** Builds a LocalVideoTrack for a make-before-break republish (fallbacks). */
    makeTrack?: (mst: MediaStreamTrack, constraints: MediaTrackConstraints | undefined) => unknown;
}

/**
 * Turn the camera on. If a camera publication already exists (a later
 * toggle) this is LiveKit's own unmute; otherwise capture + ladder + publish.
 * Concurrent calls for the same participant share one attempt.
 */
export function startCamera(lp: CameraParticipantLike, opts: StartCameraOptions): Promise<void> {
    const existing = inFlight.get(lp);
    if (existing) return existing;
    const p = (async () => {
        if (lp.getTrackPublication(Track.Source.Camera)) {
            await lp.setCameraEnabled(true);
            return;
        }
        await publishFresh(lp, opts);
    })().finally(() => { inFlight.delete(lp); });
    inFlight.set(lp, p);
    return p;
}

async function publishFresh(lp: CameraParticipantLike, opts: StartCameraOptions): Promise<void> {
    const log = opts.log ?? (m => console.info(m));
    // Encoder first (a local capability query, no capture needed): whether
    // Auto may go to 1440p depends on it (effectiveTier).
    const top = captureResolutionFor(opts.tier);
    const codec = opts.forceCodec ?? (opts.hevc ? HEVC_CAMERA_DECISION : await chooseCameraCodec(opts.codec, top.width, top.height));
    const tier = effectiveTier(opts.tier, !!codec.hardware);
    const tracks = await lp.createTracks({ video: { resolution: captureResolutionFor(tier) } });
    const track = tracks.find(t => (t as { kind?: string }).kind === 'video') as CameraTrackLike | undefined;
    if (!track) throw new Error('camera capture returned no video track');
    try {
        const settings = await settleCaptureMode(track, log);
        const plan = cameraPublishPlan(settings.width, settings.height, codec.codec, { single: opts.single });
        opts.setWantH264High?.(codec.codec === 'h264' && codec.h264Profile === 'high');
        // Someone else published a camera while we were capturing (should not
        // happen — toggleCamera is the only caller — but never publish twice).
        if (lp.getTrackPublication(Track.Source.Camera)) { track.stop(); return; }
        await lp.publishTrack(track as never, toLiveKitPublishOptions(plan));
        setState({ tier: opts.tier, capture: settings, codec, plan });
        logCallEvent('camera_capture', { width: settings.width, height: settings.height, fps: Math.round(settings.frameRate), tier: opts.tier, cap_tier: tier, why: tier !== opts.tier ? 'auto-capped-no-hw-encoder' : 'native-best-mode' });
        logCallEvent('camera_codec', { codec: codec.codec, profile: codec.h264Profile ?? 'none', hardware: !!codec.hardware, reason: codec.reason });
        logCallEvent('camera_ladder', { layers: plan.lower.length + 1, top: `${settings.width}x${settings.height}`, top_kbps: Math.round(plan.videoEncoding.maxBitrate / 1000), low: plan.lower.map(l => `${l.width}x${l.height}`).join('+') || 'none' });
        if (tier !== opts.tier) log(`[Camera] Auto capped at ${tier}: no hardware encoder`);
        log(`[Camera] published ${settings.width}x${settings.height}@${settings.frameRate} · ${codec.codec}${codec.h264Profile ? `/${codec.h264Profile}` : ''} (${codec.reason}) · top ${plan.videoEncoding.maxBitrate} bps, ${plan.lower.length + 1} layers`);
    } catch (e) {
        track.stop();
        throw e;
    }
    if (opts.watchHardware !== false && (lastState?.codec.codec === 'h264' || lastState?.codec.codec === 'h265')) {
        void watchHardwareCamera(lp, track, opts);
    }
}

/** Per-layer encode report from a sender (rid → active/frames/hardware). */
export async function readLayerReports(sender: RTCRtpSender): Promise<LayerEncodeReport[]> {
    const params = sender.getParameters();
    const activeByRid = new Map<string, boolean>();
    (params.encodings ?? []).forEach((e, i) => activeByRid.set(e.rid ?? String(i), e.active !== false));
    const out: LayerEncodeReport[] = [];
    const report = await sender.getStats();
    report.forEach((s: { type: string; kind?: string; rid?: string; framesEncoded?: number; encoderImplementation?: string; powerEfficientEncoder?: boolean }) => {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
        out.push({
            active: activeByRid.get(s.rid ?? '0') ?? true,
            framesEncoded: s.framesEncoded ?? 0,
            hardware: isHardwareCodec(s.encoderImplementation, s.powerEfficientEncoder),
        });
    });
    return out;
}

/**
 * H.264 start check (see judgeHardwareCameraStart). On failure: remember it
 * for the session and republish the SAME camera as VP8 — an ordinary
 * publish on the same E2EE room, never unencrypted. Returns the verdict.
 */
export async function watchHardwareCamera(
    lp: CameraParticipantLike,
    track: CameraTrackLike,
    opts: StartCameraOptions,
    delayMs = 6000,
): Promise<'ok' | 'no-frames' | 'software' | 'gone'> {
    const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    const log = opts.log ?? (m => console.info(m));
    await sleep(delayMs);
    const pub = lp.getTrackPublication(Track.Source.Camera);
    if (!pub || pub.track !== track || !track.sender) return 'gone';
    let verdict: 'ok' | 'no-frames' | 'software';
    try {
        verdict = judgeHardwareCameraStart(await readLayerReports(track.sender));
    } catch {
        return 'gone';
    }
    const wasHevc = asCameraCodec(track.publishOptions?.videoCodec) === 'h265';
    log(`[Camera] ${wasHevc ? 'H.265' : 'H.264'} start check: ${verdict}`);
    logCallEvent('camera_start_check', { codec: wasHevc ? 'h265' : 'h264', verdict });
    if (verdict === 'ok') return verdict;
    await fallBackFromHardwareCamera(lp, track, opts, verdict);
    return verdict;
}

/**
 * Move a hardware (H.264 / H.265) camera onto the fallback encoder for the
 * rest of the run: remember the failure, then make-before-break republish the
 * SAME capture (a clone of its MediaStreamTrack) — an ordinary publish on the
 * same E2EE room, never unencrypted. H.265 falls back to this machine's
 * normal choice (which may well be hardware H.264); H.264 falls back to VP8.
 * Shared by the start check and the mid-call stall watchdog. Returns whether
 * a new publication went up.
 */
export async function fallBackFromHardwareCamera(
    lp: CameraParticipantLike,
    track: CameraTrackLike,
    opts: StartCameraOptions,
    why: 'no-frames' | 'software' | 'stalled',
): Promise<boolean> {
    const log = opts.log ?? (m => console.info(m));
    const wasHevc = asCameraCodec(track.publishOptions?.videoCodec) === 'h265';
    if (wasHevc) markHevcFailed(); else markHwCameraFailed();
    const name = wasHevc ? 'H.265' : 'H.264';
    const reason = why === 'no-frames' ? `HW ${name} produced no frames`
        : why === 'stalled' ? `HW ${name} encoder stopped mid-call`
        : `${name} fell back to software`;
    // Preferred: make-before-break onto the fallback codec (no blink, no
    // re-capture).
    if (opts.makeTrack) {
        const fallback = wasHevc ? (await chooseCameraCodec(opts.codec, track.mediaStreamTrack.getSettings?.().width ?? 1280, track.mediaStreamTrack.getSettings?.().height ?? 720)).codec : 'vp8';
        logCallEvent('camera_fallback', { from: wasHevc ? 'h265' : 'h264', to: fallback, reason: why });
        if (await republishCamera(lp, { codec: fallback, reason: `${reason} → ${fallback}`, sleep: opts.sleep }, opts.makeTrack, log)) return true;
    }
    try {
        await lp.unpublishTrack(track as never, true);
        await startCamera(lp, {
            ...opts,
            single: lastState?.plan.simulcast === false,
            watchHardware: false,
            hevc: false,
            ...(wasHevc ? {} : { forceCodec: { codec: 'vp8' as const, reason: `${reason} → VP8` } }),
        });
        return true;
    } catch (e) {
        log(`[Camera] VP8 republish failed: ${String(e)}`);
        return false;
    }
}

/**
 * The mid-call encoder watchdog's action (cameraEncoderStall.ts said
 * 'stalled' for the current camera publication). Hardware codecs move to the
 * fallback encoder; a software (VP8) camera has nowhere better to go, so it
 * is only logged — the diagnostics report then shows it.
 */
export async function recoverStalledCamera(
    lp: CameraParticipantLike,
    opts: StartCameraOptions,
): Promise<'recovered' | 'not-hardware' | 'gone' | 'failed'> {
    const log = opts.log ?? (m => console.info(m));
    const pub = lp.getTrackPublication(Track.Source.Camera);
    const track = pub?.track as CameraTrackLike | undefined;
    if (!pub || !track || pub.isMuted) return 'gone';
    const codec = asCameraCodec(track.publishOptions?.videoCodec);
    const hardware = codec !== 'vp8';
    log(`[Camera] encoder stalled mid-call (${codec}) — ${hardware ? 'moving to the fallback encoder' : 'software encoder, no fallback'}`);
    logCallEvent('camera_encoder_stall', { codec, hardware });
    if (!hardware) return 'not-hardware';
    return (await fallBackFromHardwareCamera(lp, track, opts, 'stalled')) ? 'recovered' : 'failed';
}

// ── Mid-call changes ───────────────────────────────────────────────────────

/**
 * Re-derive the ladder after the capture size changed under a published
 * camera (a device switch to a camera with a different native size, or a
 * tier change). LiveKit recomputes encodings on restart from the
 * publishOptions it stored at publish — i.e. the OLD camera's lower-layer
 * sizes, which on a smaller camera would collapse two layers onto the same
 * resolution. So: replace those options with the new ladder and ask LiveKit
 * to recompute (its own refresh path, which also preserves dynacast-paused
 * layers). Returns true when it re-tuned.
 */
export async function retuneCamera(track: CameraTrackLike | undefined): Promise<boolean> {
    if (!track?.sender || !track.publishOptions) return false;
    const s = readSettings(track);
    if (!s.width || !s.height) return false;
    const codec = asCameraCodec(track.publishOptions.videoCodec);
    const plan = cameraPublishPlan(s.width, s.height, codec, { single: track.publishOptions.simulcast === false });
    const lk = toLiveKitPublishOptions(plan);
    track.publishOptions = {
        ...track.publishOptions,
        videoEncoding: lk.videoEncoding,
        videoSimulcastLayers: lk.videoSimulcastLayers,
    };
    track.lastEncodedDimensions = undefined;
    const refresh = (track as unknown as { onSenderTrackSwapped?: () => Promise<void> }).onSenderTrackSwapped;
    if (typeof refresh !== 'function') return false;
    await refresh.call(track);
    if (lastState) setState({ ...lastState, capture: s, plan });
    return true;
}

/**
 * Apply a new quality tier to the live camera (Settings, or "Lower" on the
 * performance offer): restart the capture at the new cap, settle, re-tune.
 * A camera that is off just remembers it — the next publish uses the tier.
 */
export async function applyCameraTier(lp: CameraParticipantLike, tier: CameraQualityTier, log: (m: string) => void = m => console.info(m)): Promise<boolean> {
    const track = lp.getTrackPublication(Track.Source.Camera)?.track as CameraTrackLike | undefined;
    if (!track) return false;
    try {
        const hw = !!lastState?.codec.hardware && !hwCameraFailed;
        await track.restartTrack(restartOptions(track, effectiveTier(tier, hw)));
        await settleCaptureMode(track, log);
        await retuneCamera(track);
        if (lastState) setState({ ...lastState, tier });
        log(`[Camera] tier → ${tier}`);
        const st = readSettings(track);
        logCallEvent('camera_tier', { tier, width: st.width, height: st.height, fps: Math.round(st.frameRate) });
        return true;
    } catch (e) {
        log(`[Camera] tier change failed: ${String(e)}`);
        return false;
    }
}

/**
 * Switch the live camera between one layer (1:1) and the simulcast ladder,
 * MAKE-BEFORE-BREAK: publish a second camera publication carrying a clone of
 * the same capture with the new layering, then unpublish the old one. A
 * viewer's tile keeps showing the old publication (getTrackPublication
 * returns the first) until it is gone, by which point the new one is
 * already subscribed and flowing — so the swap is a re-attach, not a
 * re-subscribe. Measured in the harness (see the commit). Same E2EE room:
 * the new publication is encrypted exactly like the first.
 *
 * Skipped (returns false) when the camera is off/muted (the policy asks
 * again later), when a picture-adjustment processor is attached (a clone of
 * the raw capture would lose it — rare, and the call just keeps its ladder),
 * or when nothing would change.
 *
 * `makeTrack` builds the LocalVideoTrack for the clone; the caller passes
 * `(t, c) => new LocalVideoTrack(t, c, false)` — not user-provided, so
 * LiveKit still stops the device on camera-off and re-opens it (with the
 * same constraints, device included) on camera-on.
 */
export function relayerCamera(
    lp: CameraParticipantLike,
    single: boolean,
    makeTrack: (mst: MediaStreamTrack, constraints: MediaTrackConstraints | undefined) => unknown,
    log: (m: string) => void = m => console.info(m),
): Promise<boolean> {
    return republishCamera(lp, { single }, makeTrack, log);
}

/**
 * The general make-before-break camera republish: new layering and/or a new
 * codec (H.265 negotiation, hevcNegotiation.ts). See relayerCamera.
 */
export async function republishCamera(
    lp: CameraParticipantLike,
    opts: { single?: boolean; codec?: CameraCodec; reason?: string; holdMs?: number; sleep?: (ms: number) => Promise<void> },
    makeTrack: (mst: MediaStreamTrack, constraints: MediaTrackConstraints | undefined) => unknown,
    log: (m: string) => void = m => console.info(m),
): Promise<boolean> {
    // One republish at a time per participant: the start-check fallback and
    // the layering/H.265 loop can both want one; the loser retries next tick.
    if (republishing.has(lp)) return false;
    republishing.add(lp);
    try {
        return await republishCameraLocked(lp, opts, makeTrack, log);
    } finally {
        republishing.delete(lp);
    }
}

const republishing = new WeakSet<object>();

async function republishCameraLocked(
    lp: CameraParticipantLike,
    opts: { single?: boolean; codec?: CameraCodec; reason?: string; holdMs?: number; sleep?: (ms: number) => Promise<void> },
    makeTrack: (mst: MediaStreamTrack, constraints: MediaTrackConstraints | undefined) => unknown,
    log: (m: string) => void,
): Promise<boolean> {
    const pub = lp.getTrackPublication(Track.Source.Camera);
    const old = pub?.track as (CameraTrackLike & { getProcessor?: () => unknown }) | undefined;
    if (!pub || !old || pub.isMuted || !old.publishOptions) return false;
    if (old.getProcessor?.()) return false;
    const wasSingle = old.publishOptions.simulcast === false;
    const single = opts.single ?? wasSingle;
    const sameCodec = !opts.codec || opts.codec === asCameraCodec(old.publishOptions.videoCodec);
    if (single === wasSingle && sameCodec) return false;
    if (old.mediaStreamTrack.readyState === 'ended') return false;
    const s = readSettings(old);
    if (!s.width || !s.height) return false;
    const codec = opts.codec ?? asCameraCodec(old.publishOptions.videoCodec);
    const plan = cameraPublishPlan(s.width, s.height, codec, { single });
    const clone = old.mediaStreamTrack.clone();
    const fresh = makeTrack(clone, old.constraints);
    try {
        await lp.publishTrack(fresh as never, toLiveKitPublishOptions(plan));
    } catch (e) {
        clone.stop();
        log(`[Camera] republish (${codec}, ${single ? 'single' : 'simulcast'}) failed, keeping the current one: ${String(e)}`);
        return false;
    }
    // Keep the old publication up while viewers subscribe to the new one.
    // Measured in the harness: unpublishing as soon as publishTrack resolves
    // left subscribers ~0.3–0.5 s with no picture (the old track was gone
    // before the new one had been subscribed); with the hold the swap is a
    // re-attach to a track that is already flowing.
    await (opts.sleep ?? sleepMs)(opts.holdMs ?? REPUBLISH_HOLD_MS);
    try { await lp.unpublishTrack(old as never, true); } catch { /* already gone */ }
    if (lastState) {
        setState({
            ...lastState,
            plan,
            codec: sameCodec ? lastState.codec : { codec, reason: opts.reason ?? `switched to ${codec}`, hardware: codec === 'h265' ? true : lastState.codec.hardware },
        });
    }
    if (single !== wasSingle) logCallEvent('camera_layering', { mode: single ? 'single' : 'simulcast', layers: plan.lower.length + 1 });
    if (!sameCodec) logCallEvent('h265_switch', { track: 'self-camera', codec, reason: opts.reason ?? 'negotiation' });
    log(`[Camera] now ${codec} · ${single ? 'one layer (1:1 call)' : `simulcast (${plan.lower.length + 1} layers)`}`);
    return true;
}

/**
 * Camera encoder snapshot for diagnostics (the issue reporter's call stats
 * can read this; nothing here leaves the device unless the user sends a
 * report). Null when no camera is published.
 */
export interface CameraEncoderInfo {
    tier: CameraQualityTier | null;
    capture: { width: number; height: number; frameRate: number } | null;
    codecDecision: string | null;
    codec: string | null;
    encoderImplementation: string | null;
    /** true = a hardware encoder on any layer, false = software, null = unknown. */
    hardware: boolean | null;
    layers: { rid: string; width: number; height: number; fps: number; active: boolean }[];
}

export async function readCameraEncoderInfo(lp: CameraParticipantLike): Promise<CameraEncoderInfo | null> {
    const track = lp.getTrackPublication(Track.Source.Camera)?.track as CameraTrackLike | undefined;
    if (!track?.sender) return null;
    const params = track.sender.getParameters();
    const activeByRid = new Map<string, boolean>();
    (params.encodings ?? []).forEach((e, i) => activeByRid.set(e.rid ?? String(i), e.active !== false));
    const report = await track.sender.getStats();
    const layers: CameraEncoderInfo['layers'] = [];
    let impl: string | null = null;
    let hw: boolean | null = null;
    let codecId: string | undefined;
    const codecs = new Map<string, string>();
    report.forEach((s: Record<string, unknown>) => {
        if (s.type === 'codec' && typeof s.id === 'string' && typeof s.mimeType === 'string') codecs.set(s.id, s.mimeType);
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
        const rid = typeof s.rid === 'string' ? s.rid : '';
        layers.push({
            rid,
            width: typeof s.frameWidth === 'number' ? s.frameWidth : 0,
            height: typeof s.frameHeight === 'number' ? s.frameHeight : 0,
            fps: typeof s.framesPerSecond === 'number' ? s.framesPerSecond : 0,
            active: activeByRid.get(rid || '0') ?? true,
        });
        const enc = typeof s.encoderImplementation === 'string' ? s.encoderImplementation : undefined;
        if (enc) impl = enc;
        const h = isHardwareCodec(enc, s.powerEfficientEncoder);
        if (h !== null) hw = hw === null ? h : (hw || h);
        if (typeof s.codecId === 'string') codecId = s.codecId;
    });
    layers.sort((a, b) => a.width * a.height - b.width * b.height);
    return {
        tier: lastState?.tier ?? null,
        capture: lastState?.capture ?? null,
        codecDecision: lastState?.codec.reason ?? null,
        codec: codecId ? codecs.get(codecId) ?? null : null,
        encoderImplementation: impl,
        hardware: hw,
        layers,
    };
}

/** For callers holding LiveKit's real types. */
export const asCameraParticipant = (lp: LocalParticipant) => lp as unknown as CameraParticipantLike;
export const asCameraTrack = (t: LocalVideoTrack | undefined) => t as unknown as CameraTrackLike | undefined;
