/**
 * Pure summarizers behind the live stream-stats overlay (StreamStatsHud.tsx).
 *
 * They turn one WebRTC getStats() report (plus the previous snapshot, for
 * per-second rates) into the handful of numbers that answer "why isn't this
 * 90 fps?" — each of which points at a different fix:
 *
 *   capture fps < target            → the capturer (display refresh, OS capture
 *                                     path, Chromium's capture CPU throttle)
 *   encoded fps < capture fps       → the encoder: limitation 'cpu' = too slow
 *                                     (software encoder?), 'bandwidth' = the
 *                                     bandwidth estimate is below what the
 *                                     picture needs
 *   received fps < encoded fps      → network / SFU between the two
 *   rendered/decoded fps < received → the viewer's decoder
 *
 * Kept free of React and LiveKit so it is unit-testable against canned
 * reports.
 */

/** Loose view of an RTCStats entry: we only read fields, never trust shape. */
export type StatsEntry = { id: string; type: string; [k: string]: unknown };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Best-effort "is this a hardware codec?".
 *
 * Chromium reports `powerEfficientEncoder` / `powerEfficientDecoder` directly
 * — but only while the page is capturing (mic/camera/screen), and only in
 * newer builds — so fall back to the implementation NAME, which is always
 * there when the stats are exposed at all. `null` = can't tell.
 */
export function isHardwareCodec(implementation: string | undefined, powerEfficient: unknown): boolean | null {
    if (typeof powerEfficient === 'boolean') return powerEfficient;
    if (!implementation) return null;
    if (/libvpx|openh264|libaom|dav1d|ffmpeg|software/i.test(implementation)) return false;
    if (/external|accelerat|mediafoundation|d3d11|dxva|vaapi|videotoolbox|nvenc|nvdec|v4l2|mediacodec|hardware/i.test(implementation)) return true;
    return null;
}

function codecName(entries: Map<string, StatsEntry>, codecId: unknown): string | undefined {
    const c = typeof codecId === 'string' ? entries.get(codecId) : undefined;
    const mime = str(c?.mimeType);
    return mime ? mime.replace(/^video\//i, '').toUpperCase() : undefined;
}

function codecFmtp(entries: Map<string, StatsEntry>, codecId: unknown): string | undefined {
    const c = typeof codecId === 'string' ? entries.get(codecId) : undefined;
    return str(c?.sdpFmtpLine);
}

/**
 * H.264 profile from a negotiated fmtp line — which matters because Chromium
 * on Windows only has a hardware path for some of them (see
 * electron/capture-flags.ts). RFC 6184 profile-level-id: profile_idc byte,
 * then the constraint-flags byte; 42 with constraint_set1 (0x40) is
 * Constrained Baseline.
 */
export function h264ProfileFromFmtp(fmtp: string | undefined): string | undefined {
    const m = /profile-level-id=([0-9a-f]{6})/i.exec(fmtp ?? '');
    if (!m) return undefined;
    const idc = parseInt(m[1].slice(0, 2), 16);
    const iop = parseInt(m[1].slice(2, 4), 16);
    switch (idc) {
        case 0x42: return (iop & 0x40) ? 'CB' : 'Baseline';
        case 0x4d: return (iop & 0x80) ? 'CB' : 'Main';
        case 0x58: return 'Extended';
        case 0x64: return 'High';
        case 0xf4: return 'High 4:4:4';
        default: return `idc ${idc}`;
    }
}

function toMap(report: Iterable<StatsEntry> | { forEach: (cb: (s: StatsEntry) => void) => void }): Map<string, StatsEntry> {
    const m = new Map<string, StatsEntry>();
    if (typeof (report as { forEach?: unknown }).forEach === 'function') {
        (report as { forEach: (cb: (s: StatsEntry) => void) => void }).forEach(s => { m.set(s.id, s); });
    } else {
        for (const s of report as Iterable<StatsEntry>) m.set(s.id, s);
    }
    return m;
}

/** The selected ICE candidate pair, for RTT and the send-side bandwidth estimate. */
function selectedPair(entries: Map<string, StatsEntry>): StatsEntry | undefined {
    for (const s of entries.values()) {
        if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
            const p = entries.get(s.selectedCandidatePairId);
            if (p) return p;
        }
    }
    for (const s of entries.values()) {
        if (s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded') return s;
    }
    return undefined;
}

// ── Sender ───────────────────────────────────────────────────────────────────

export interface SenderSnapshot {
    at: number;          // ms
    bytesSent: number;
    framesEncoded: number;
    totalEncodeTime: number;
    keyFramesEncoded: number;
}

export interface SenderHudStats {
    captureFps?: number;
    captureWidth?: number;
    captureHeight?: number;
    encodedFps?: number;
    encodedWidth?: number;
    encodedHeight?: number;
    codec?: string;
    /** Negotiated fmtp line of the send codec (H.264 profile lives here). */
    codecFmtp?: string;
    encoder?: string;
    hardware: boolean | null;
    scalabilityMode?: string;
    /** Actual send rate over the last interval, Mbps. */
    sendMbps?: number;
    /** What the encoder is currently aiming for (bandwidth estimate share), Mbps. */
    targetMbps?: number;
    /** Congestion controller's estimate for the whole link, Mbps. */
    availableMbps?: number;
    /** 'none' | 'cpu' | 'bandwidth' | 'other' */
    limitation?: string;
    resolutionChanges?: number;
    keyFramesEncoded?: number;
    /** Average encode time per frame over the last interval, ms. */
    encodeMs?: number;
    nacks?: number;
    plis?: number;
    rttMs?: number;
    /** Simulcast layers (camera), smallest first: rid, size, fps, and whether
     *  the encoder is running it (dynacast pauses layers nobody watches). */
    layers?: { rid: string; width?: number; height?: number; fps?: number; active: boolean }[];
}

/** One-line layer summary for the overlay: "320×180 30 · 640×360 30 · 1280×720 off". */
export function formatLayers(layers: SenderHudStats['layers']): string | undefined {
    if (!layers || layers.length < 2) return undefined;
    return layers.map(l => `${l.width && l.height ? `${l.width}×${l.height}` : l.rid || '?'} ${l.active ? Math.round(l.fps ?? 0) : 'off'}`).join(' · ');
}

/**
 * Summarize a sender's getStats() report. Multiple outbound-rtp entries
 * (camera simulcast) are reduced to the highest-resolution active layer for
 * fps/size, with bytes summed across layers.
 */
export function summarizeSender(
    report: Iterable<StatsEntry> | { forEach: (cb: (s: StatsEntry) => void) => void },
    prev: SenderSnapshot | null,
    now: number,
): { stats: SenderHudStats; snapshot: SenderSnapshot | null } {
    const entries = toMap(report);
    let top: StatsEntry | undefined;
    let bytesSent = 0;
    let target = 0;
    let hasTarget = false;
    const layers: NonNullable<SenderHudStats['layers']> = [];
    for (const s of entries.values()) {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') continue;
        bytesSent += num(s.bytesSent) ?? 0;
        const t = num(s.targetBitrate);
        if (t !== undefined) { target += t; hasTarget = true; }
        const area = (num(s.frameWidth) ?? 0) * (num(s.frameHeight) ?? 0);
        const topArea = top ? (num(top.frameWidth) ?? 0) * (num(top.frameHeight) ?? 0) : -1;
        // A dynacast-paused layer keeps reporting its last size: prefer the
        // largest layer that is actually being encoded.
        const active = s.active !== false;
        const topActive = top ? top.active !== false : false;
        if (!top || (active && !topActive) || (active === topActive && area > topArea)) top = s;
        layers.push({ rid: str(s.rid) ?? '', width: num(s.frameWidth), height: num(s.frameHeight), fps: num(s.framesPerSecond), active });
    }
    layers.sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0));
    if (!top) return { stats: { hardware: null }, snapshot: null };

    const src = [...entries.values()].find(s => s.type === 'media-source' && s.kind === 'video');
    const pair = selectedPair(entries);
    const snapshot: SenderSnapshot = {
        at: now,
        bytesSent,
        framesEncoded: num(top.framesEncoded) ?? 0,
        totalEncodeTime: num(top.totalEncodeTime) ?? 0,
        keyFramesEncoded: num(top.keyFramesEncoded) ?? 0,
    };
    const dt = prev ? (now - prev.at) / 1000 : 0;
    const dFrames = prev ? snapshot.framesEncoded - prev.framesEncoded : 0;
    const encoder = str(top.encoderImplementation);
    const stats: SenderHudStats = {
        captureFps: num(src?.framesPerSecond),
        captureWidth: num(src?.width),
        captureHeight: num(src?.height),
        encodedFps: num(top.framesPerSecond),
        encodedWidth: num(top.frameWidth),
        encodedHeight: num(top.frameHeight),
        codec: codecName(entries, top.codecId),
        codecFmtp: codecFmtp(entries, top.codecId),
        encoder,
        hardware: isHardwareCodec(encoder, top.powerEfficientEncoder),
        scalabilityMode: str(top.scalabilityMode),
        sendMbps: prev && dt > 0 && bytesSent >= prev.bytesSent ? ((bytesSent - prev.bytesSent) * 8) / dt / 1e6 : undefined,
        targetMbps: hasTarget ? target / 1e6 : undefined,
        availableMbps: pair ? (num(pair.availableOutgoingBitrate) ?? 0) / 1e6 || undefined : undefined,
        limitation: str(top.qualityLimitationReason),
        resolutionChanges: num(top.qualityLimitationResolutionChanges),
        keyFramesEncoded: num(top.keyFramesEncoded),
        encodeMs: prev && dFrames > 0 ? ((snapshot.totalEncodeTime - prev.totalEncodeTime) / dFrames) * 1000 : undefined,
        nacks: num(top.nackCount),
        plis: num(top.pliCount),
        rttMs: pair && num(pair.currentRoundTripTime) !== undefined ? (num(pair.currentRoundTripTime)! * 1000) : undefined,
        layers: layers.length > 1 ? layers : undefined,
    };
    return { stats, snapshot };
}

// ── Receiver ─────────────────────────────────────────────────────────────────

export interface ReceiverSnapshot {
    at: number;
    bytesReceived: number;
    framesDecoded: number;
    framesDropped: number;
    totalDecodeTime: number;
    jitterBufferDelay: number;
    jitterBufferEmittedCount: number;
    packetsLost: number;
    packetsReceived: number;
}

export interface ReceiverHudStats {
    fps?: number;
    width?: number;
    height?: number;
    codec?: string;
    decoder?: string;
    hardware: boolean | null;
    recvMbps?: number;
    framesDropped?: number;
    /** Frames dropped per second over the last interval. */
    droppedPerSec?: number;
    freezes?: number;
    /** Average time a frame waited in the jitter buffer over the last interval, ms. */
    jitterBufferMs?: number;
    decodeMs?: number;
    /** Packet loss over the last interval, %. */
    lossPct?: number;
    nacks?: number;
    plis?: number;
}

export function summarizeReceiver(
    report: Iterable<StatsEntry> | { forEach: (cb: (s: StatsEntry) => void) => void },
    prev: ReceiverSnapshot | null,
    now: number,
): { stats: ReceiverHudStats; snapshot: ReceiverSnapshot | null } {
    const entries = toMap(report);
    let inb: StatsEntry | undefined;
    for (const s of entries.values()) {
        if (s.type !== 'inbound-rtp' || s.kind !== 'video') continue;
        if (!inb || (num(s.bytesReceived) ?? 0) > (num(inb.bytesReceived) ?? 0)) inb = s;
    }
    if (!inb) return { stats: { hardware: null }, snapshot: null };
    const snapshot: ReceiverSnapshot = {
        at: now,
        bytesReceived: num(inb.bytesReceived) ?? 0,
        framesDecoded: num(inb.framesDecoded) ?? 0,
        framesDropped: num(inb.framesDropped) ?? 0,
        totalDecodeTime: num(inb.totalDecodeTime) ?? 0,
        jitterBufferDelay: num(inb.jitterBufferDelay) ?? 0,
        jitterBufferEmittedCount: num(inb.jitterBufferEmittedCount) ?? 0,
        packetsLost: num(inb.packetsLost) ?? 0,
        packetsReceived: num(inb.packetsReceived) ?? 0,
    };
    const dt = prev ? (now - prev.at) / 1000 : 0;
    const dDecoded = prev ? snapshot.framesDecoded - prev.framesDecoded : 0;
    const dEmitted = prev ? snapshot.jitterBufferEmittedCount - prev.jitterBufferEmittedCount : 0;
    const dLost = prev ? Math.max(0, snapshot.packetsLost - prev.packetsLost) : 0;
    const dRecv = prev ? Math.max(0, snapshot.packetsReceived - prev.packetsReceived) : 0;
    const decoder = str(inb.decoderImplementation);
    const stats: ReceiverHudStats = {
        fps: num(inb.framesPerSecond),
        width: num(inb.frameWidth),
        height: num(inb.frameHeight),
        codec: codecName(entries, inb.codecId),
        decoder,
        hardware: isHardwareCodec(decoder, inb.powerEfficientDecoder),
        recvMbps: prev && dt > 0 && snapshot.bytesReceived >= prev.bytesReceived
            ? ((snapshot.bytesReceived - prev.bytesReceived) * 8) / dt / 1e6 : undefined,
        framesDropped: num(inb.framesDropped),
        droppedPerSec: prev && dt > 0 ? Math.max(0, snapshot.framesDropped - prev.framesDropped) / dt : undefined,
        freezes: num(inb.freezeCount),
        jitterBufferMs: dEmitted > 0 ? ((snapshot.jitterBufferDelay - prev!.jitterBufferDelay) / dEmitted) * 1000 : undefined,
        decodeMs: dDecoded > 0 ? ((snapshot.totalDecodeTime - prev!.totalDecodeTime) / dDecoded) * 1000 : undefined,
        lossPct: prev && dLost + dRecv > 0 ? (dLost / (dLost + dRecv)) * 100 : undefined,
        nacks: num(inb.nackCount),
        plis: num(inb.pliCount),
    };
    return { stats, snapshot };
}

// ── Capture-side verdict ─────────────────────────────────────────────────────

export type CaptureVerdict =
    | 'ok'          // capture and encode both at the requested rate
    | 'display'     // capture ≈ the captured display's refresh rate, which is below the request
    | 'throttle'    // Chromium's half-a-core capture cap (measured from its own log)
    | 'timer'       // grabs are cheap, but Chromium's capture timer fires late (Windows)
    | 'unchanged'   // the capturer is polled on time but often has no new frame
    | 'pipeline'    // Chromium grabbed the frames, but fewer reached WebRTC (dropped in between)
    | 'capturer'    // capture short, cause not measured (turn the capture log on)
    | 'encoder'     // capture fine, encoder drops frames
    | 'network'     // capture fine, bandwidth estimate starving the encoder
    | 'unknown';

export interface CaptureHintInput {
    captureFps?: number;
    /** The frame rate the share is meant to SEND (the user's choice / encoding
     *  maxFramerate). The capturer is deliberately asked for more
     *  (captureFrameRateFor), so this — not the capture request — is the bar. */
    requestedFps?: number;
    /** Refresh rate of the captured display; null/undefined = unknown. */
    displayHz?: number | null;
    encodedFps?: number;
    limitation?: string;
    /** Chromium's own per-frame numbers (capture-timing log), when available.
     *  `intervalMs` = measured time between grabs; `requestedFps` = what
     *  Chromium's capturer was actually asked for. */
    timing?: { captureMs: number; periodMs: number; unchangedRatio: number; intervalMs?: number; requestedFps?: number } | null;
}

/**
 * Name the ONE hop that is holding the frame rate back, in the order the
 * frames flow. Every threshold here is deliberately loose (5–15%): the stats
 * are one-second averages, and the point is to pick the right suspect, not to
 * grade it.
 *
 * The capture-side split relies on how Chromium schedules desktop capture
 * (content/browser/media/capture/desktop_capture_device.cc):
 *   period = max(2 × last grab duration, 1 / requested fps)
 * so from its log: period well above the requested one AND ≈ 2 × grab time →
 * the CPU cap ('throttle'); period on time but frames missing → the polls
 * found nothing new ('unchanged': static content, or the OS capturer is not
 * producing frames that fast); grabs on time and new, yet fewer frames reach
 * WebRTC's media-source → lost between the capturer and the track
 * ('pipeline'). Without the log, the best we can say is 'capturer', with the
 * grab time the cap WOULD imply.
 */
export function captureLimitHint(i: CaptureHintInput): { verdict: CaptureVerdict; text: string } {
    const { captureFps, requestedFps } = i;
    if (captureFps === undefined || !requestedFps) return { verdict: 'unknown', text: '' };
    const r = (n: number) => Math.round(n);

    if (captureFps < requestedFps * 0.93) {
        const hz = i.displayHz ?? 0;
        if (hz > 0 && hz < requestedFps * 0.97 && captureFps >= hz * 0.9) {
            return { verdict: 'display', text: `display ${r(hz)} Hz caps capture` };
        }
        const t = i.timing;
        if (t && t.periodMs > 0) {
            // Chromium truncates the period to whole ms: floor(1000 / fps).
            const requestedPeriod = Math.floor(1000 / (t.requestedFps ?? requestedFps));
            if (t.periodMs > requestedPeriod * 1.15 && t.captureMs * 2 >= t.periodMs * 0.8) {
                return {
                    verdict: 'throttle',
                    text: `grab ${t.captureMs}ms ×2 → ≤${r(1000 / t.periodMs)} fps (Chromium CPU cap)`,
                };
            }
            // Grabs are cheap and scheduled on time, but the timer that fires
            // them runs late (Windows: 1–2 ms per frame). Real interval, not
            // the scheduled period, is what sets the rate.
            if (t.intervalMs !== undefined && t.intervalMs > t.periodMs * 1.05 && t.captureMs * 2 < t.intervalMs
                && t.unchangedRatio < 0.1) {
                const headroom = (t.requestedFps ?? requestedFps) > requestedFps;
                return {
                    verdict: 'timer',
                    text: `capture timer late: every ${t.periodMs}ms asked, ${t.intervalMs}ms real → ${r(1000 / t.intervalMs)} fps`
                        + (headroom ? '' : ' (no capture headroom)'),
                };
            }
            if (t.unchangedRatio >= 0.1) {
                return { verdict: 'unchanged', text: `${r(t.unchangedRatio * 100)}% of polls had no new frame` };
            }
            const grabbed = (1000 / t.periodMs) * (1 - t.unchangedRatio);
            if (grabbed > captureFps * 1.2) {
                return { verdict: 'pipeline', text: `Chromium grabbed ${r(grabbed)}/s, WebRTC got ${r(captureFps)}` };
            }
            return { verdict: 'capturer', text: `capturer: poll ${r(1000 / t.periodMs)}/s, grab ${t.captureMs}ms` };
        }
        return {
            verdict: 'capturer',
            text: `capture-bound (if CPU-capped: ≈${(1000 / (2 * captureFps)).toFixed(1)}ms/grab)`,
        };
    }

    if (i.encodedFps !== undefined && i.encodedFps < captureFps * 0.9) {
        if (i.limitation === 'bandwidth') return { verdict: 'network', text: 'encoder starved by bandwidth estimate' };
        if (i.limitation === 'cpu') return { verdict: 'encoder', text: 'encoder too slow (cpu)' };
        return { verdict: 'encoder', text: 'encoder dropping frames' };
    }
    return { verdict: 'ok', text: 'nothing limiting' };
}

/**
 * Seconds after the share goes live during which a low bandwidth estimate is
 * the congestion controller still ramping, not a verdict on the link.
 * livekit-client sets an SDP start bitrate only for VP9/AV1, so a VP8/H.264
 * share starts from WebRTC's 300 kbps default and climbs. Measured on a
 * LiveKit v1.9.12 SFU (loopback, VP8, E2EE), target bitrate ≈3 Mbps at 1.5 s,
 * ≈6 at 5 s, ≈11 at 13 s, 19–22 at 20–25 s — and the SAME ramp with no
 * viewer in the room as with one (the SFU sends transport-cc feedback to a
 * publisher whether or not anyone subscribes), so "alone in the call" does not
 * hold the estimate down.
 */
export const BWE_RAMP_SECONDS = 20;

/**
 * When the encoder is bandwidth-limited, one line on what the estimate means
 * right now: still ramping (wait), or settled (that is the uplink). Null when
 * bandwidth is not the limiter.
 */
export function bandwidthHint(i: {
    limitation?: string;
    availableMbps?: number;
    encodedWidth?: number; encodedHeight?: number;
    captureWidth?: number; captureHeight?: number;
    /** Seconds since the share went live; undefined = unknown. */
    ageSec?: number;
}): string | null {
    if (i.limitation !== 'bandwidth') return null;
    const est = i.availableMbps !== undefined ? `${i.availableMbps < 10 ? i.availableMbps.toFixed(1) : Math.round(i.availableMbps)} Mbps` : 'the estimate';
    const scaled = !!(i.encodedWidth && i.encodedHeight && i.captureWidth && i.captureHeight)
        && i.encodedWidth * i.encodedHeight < i.captureWidth * i.captureHeight * 0.9;
    const effect = scaled ? `sending ${i.encodedWidth}×${i.encodedHeight} to fit` : 'encoder held back';
    if (i.ageSec !== undefined && i.ageSec < BWE_RAMP_SECONDS) {
        return `link ${est}, still ramping (${Math.round(i.ageSec)}s in) — ${effect}`;
    }
    return `link settled at ${est} — likely your upload; ${effect}`;
}

/** Traffic-light for a frame rate against what was asked for. */
export function fpsTone(fps: number | undefined, target: number | undefined): 'ok' | 'warn' | 'bad' | 'neutral' {
    if (fps === undefined || !target) return 'neutral';
    if (fps >= target * 0.95) return 'ok';
    if (fps >= target * 0.75) return 'warn';
    return 'bad';
}

// ── Static content: is the encoder padding? ─────────────────────────────────
//
// Chromium's hardware encode path runs CBR (rtc_video_encoder.cc configures
// media::Bitrate::Mode::kConstant). A CBR hardware encoder on a STATIC screen
// may keep spending close to its target by lowering QP instead of dropping to
// a trickle the way libvpx does — in which case a static share (or a still
// webcam) costs near its ceiling, and lowering maxBitrate for static content
// WOULD save bits. Not measurable on the dev box (no working HW encoder);
// this hint is how the owner's Windows test answers it.
//
// "Static" = the capture log says ≥ 80 % of polls had no new frame, or (no
// log) the share encodes < 30 % of its target frame rate.

export function paddingHint(i: {
    sendMbps?: number;
    capMbps?: number;
    encodedFps?: number;
    targetFps?: number;
    unchangedRatio?: number | null;
}): { padding: boolean; text: string } | null {
    if (i.sendMbps === undefined || !i.capMbps) return null;
    const staticByLog = typeof i.unchangedRatio === 'number' && i.unchangedRatio >= 0.8;
    const staticByFps = i.unchangedRatio == null && !!i.targetFps && i.encodedFps !== undefined && i.encodedFps < 0.3 * i.targetFps;
    if (!staticByLog && !staticByFps) return null;
    const pct = Math.round((i.sendMbps / i.capMbps) * 100);
    const mbps = i.sendMbps < 10 ? i.sendMbps.toFixed(1) : String(Math.round(i.sendMbps));
    return pct >= 50
        ? { padding: true, text: `static content at ${pct}% of cap (${mbps} Mbps) — encoder padding?` }
        : { padding: false, text: `static content: ${mbps} Mbps (${pct}% of cap) — no padding` };
}

// ── HEVC (H.265) capability probe ───────────────────────────────────────────
//
// Information only: the app does not publish H.265 (Android cannot decode it
// and E2EE removes LiveKit's backup-codec fallback — see the codec research).
// Chromium 150 has H.265 send/receive on by default but HARDWARE-only, so
// this tells us what the owner's machines would offer.

export interface HevcSupport { send: boolean | null; recv: boolean | null; hwEncode: boolean | null }

type CodecList = { codecs?: { mimeType: string }[] } | null | undefined;

export async function probeHevc(deps: {
    senderCaps?: () => CodecList;
    receiverCaps?: () => CodecList;
    encodingInfo?: (c: unknown) => Promise<{ supported: boolean; powerEfficient: boolean }>;
} = {}): Promise<HevcSupport> {
    const has = (list: CodecList) => (list?.codecs ? list.codecs.some(c => /^video\/h265$/i.test(c.mimeType)) : null);
    const sc = deps.senderCaps ?? (() => (typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video') : null));
    const rc = deps.receiverCaps ?? (() => (typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities?.('video') : null));
    const ei = deps.encodingInfo ?? (typeof navigator !== 'undefined' && navigator.mediaCapabilities?.encodingInfo
        ? (c: unknown) => navigator.mediaCapabilities.encodingInfo(c as MediaEncodingConfiguration)
        : undefined);
    let send: boolean | null = null;
    let recv: boolean | null = null;
    try { send = has(sc()); } catch { /* unknown */ }
    try { recv = has(rc()); } catch { /* unknown */ }
    let hwEncode: boolean | null = null;
    if (ei) {
        try {
            const r = await ei({ type: 'webrtc', video: { contentType: 'video/H265', width: 2560, height: 1440, bitrate: 8_000_000, framerate: 30 } });
            hwEncode = !!(r.supported && r.powerEfficient);
        } catch { hwEncode = null; }
    }
    return { send, recv, hwEncode };
}

export function formatHevc(h: HevcSupport): string {
    const m = (v: boolean | null) => (v === null ? '?' : v ? '✓' : '✗');
    return `send ${m(h.send)} · recv ${m(h.recv)} · HW enc ${m(h.hwEncode)} (info only)`;
}
