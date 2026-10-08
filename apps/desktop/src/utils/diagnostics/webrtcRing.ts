/**
 * In-memory ring buffer of WebRTC stats for the issue reporter — the "why
 * isn't my screen share 90 fps?" evidence.
 *
 * While a call is up, the recorder (components/diagnostics/
 * CallDiagnosticsRecorder.tsx, mounted inside <LiveKitRoom>) samples every
 * WEBRTC_SAMPLE_INTERVAL_MS and hands this module each track's getStats()
 * report. We keep the last WEBRTC_RING_SIZE samples (~2 minutes). When the
 * call ends the buffer is frozen with its end time, so "it was bad in the call
 * I just left" can still be reported; the next call starts a fresh buffer.
 *
 * PRIVACY — the buffer never holds an identity:
 *   • Tracks are named by ROLE and first-seen order at capture time —
 *     `screen-1`, `camera-1`, `mic-1`, `remote-video-2` — never by LiveKit
 *     SID, participant identity or name. The mapping is a WeakMap keyed by the
 *     track OBJECT, so not even the mapper holds a SID string; it is dropped
 *     when the next call begins.
 *   • Only numbers, codec / encoder implementation names and fixed enums are
 *     read from the stats. No SSRCs, MIDs, track ids, candidate addresses or
 *     certificate fingerprints are copied.
 *
 * Cost: one getStats() per track per 5 s, and nothing at all when no call is
 * active (the recorder unmounts with the room). The summarizers are the same
 * pure ones the stream-stats overlay uses (utils/streamStatsHud.ts).
 */
import {
    summarizeSender, summarizeReceiver, isHardwareCodec,
    type StatsEntry, type SenderSnapshot, type ReceiverSnapshot,
} from '../streamStatsHud';
import type {
    InboundTrackStats, OutboundTrackStats, QualityLimitation, WebrtcSample, WebrtcSummary,
} from './reportTypes';
import { DIAGNOSTIC_LIMITS } from './reportTypes';

export const WEBRTC_SAMPLE_INTERVAL_MS = 5_000;
/** 24 × 5 s = 2 minutes. */
export const WEBRTC_RING_SIZE = 24;
const MAX_OUTBOUND = 4;
const MAX_INBOUND = 8;

export type StatsReportLike = Iterable<StatsEntry> | { forEach: (cb: (s: StatsEntry) => void) => void };

export interface TrackStatsInput {
    /** The track OBJECT. Used only as a WeakMap key; never read or stored. */
    ref: object;
    direction: 'outbound' | 'inbound';
    kind: 'video' | 'audio';
    /** Outbound only; inbound tracks are all `remote-*`. */
    source?: OutboundTrackStats['source'];
    report: StatsReportLike;
    /** The frame rate the user chose to SEND (screen share: the picker's fps). */
    targetFps?: number;
    /** Sender's configured max bitrate, when the stats carry no targetBitrate. */
    maxBitrateBps?: number;
}

export interface CaptureInput {
    kind: 'screen' | 'window' | 'camera';
    requestedFps?: number;
    requestedResolution?: string;
    codecPref?: string;
}

interface StoredSample extends Omit<WebrtcSample, 't_s'> { at: number }

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const r1 = (n: number | undefined): number | undefined => (n === undefined ? undefined : Math.round(n * 10) / 10);
const r0 = (n: number | undefined): number | undefined => (n === undefined ? undefined : Math.round(n));
/** Codec / implementation names are short code identifiers; anything else is dropped. */
const safeName = (v: unknown): string | undefined =>
    (typeof v === 'string' && /^[A-Za-z0-9 _.,()/:+-]{1,80}$/.test(v) ? v : undefined);

function toMap(report: StatsReportLike): Map<string, StatsEntry> {
    const m = new Map<string, StatsEntry>();
    if (typeof (report as { forEach?: unknown }).forEach === 'function') {
        (report as { forEach: (cb: (s: StatsEntry) => void) => void }).forEach(s => { m.set(s.id, s); });
    } else {
        for (const s of report as Iterable<StatsEntry>) m.set(s.id, s);
    }
    return m;
}

function codecOf(entries: Map<string, StatsEntry>, codecId: unknown): string | undefined {
    const c = typeof codecId === 'string' ? entries.get(codecId) : undefined;
    const mime = typeof c?.mimeType === 'string' ? c.mimeType : undefined;
    return mime ? safeName(mime.replace(/^(?:audio|video)\//i, '').toUpperCase()) : undefined;
}

const LIMITS: readonly QualityLimitation[] = ['cpu', 'bandwidth', 'other', 'none'];
const asLimitation = (v: unknown): QualityLimitation | undefined =>
    (LIMITS as readonly unknown[]).includes(v) ? v as QualityLimitation : undefined;

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

/** Highest-resolution outbound video layer (same pick as summarizeSender). */
/** Encodings of one sender and how many are active (outbound-rtp `active`). */
function layerCounts(entries: Map<string, StatsEntry>): { layers?: number; active_layers?: number } {
    let layers = 0;
    let active = 0;
    let known = false;
    for (const s of entries.values()) {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') continue;
        layers++;
        if (typeof s.active === 'boolean') known = true;
        if (s.active !== false) active++;
    }
    return layers && known ? { layers, active_layers: active } : {};
}

function topOutboundVideo(entries: Map<string, StatsEntry>): StatsEntry | undefined {
    let top: StatsEntry | undefined;
    for (const s of entries.values()) {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') continue;
        const area = (num(s.frameWidth) ?? 0) * (num(s.frameHeight) ?? 0);
        const topArea = top ? (num(top.frameWidth) ?? 0) * (num(top.frameHeight) ?? 0) : -1;
        if (!top || area > topArea) top = s;
    }
    return top;
}

interface AudioSnap { at: number; bytes: number; lost: number; recv: number }

const PLACEHOLDER_PREFIX: Record<string, string> = {
    'outbound:screen_share': 'screen',
    'outbound:screen_share_audio': 'screen-audio',
    'outbound:camera': 'camera',
    'outbound:microphone': 'mic',
    'outbound:unknown': 'local-track',
    'inbound:video': 'remote-video',
    'inbound:audio': 'remote-audio',
};

export class WebrtcRing {
    private samples: StoredSample[] = [];
    private active = false;
    private endedAt: number | null = null;
    private capture: CaptureInput | null = null;
    // Per-call, keyed by track OBJECT (see the privacy note above).
    private names = new WeakMap<object, string>();
    private counters = new Map<string, number>();
    private prevSender = new WeakMap<object, SenderSnapshot | null>();
    private prevReceiver = new WeakMap<object, ReceiverSnapshot | null>();
    private prevAudio = new WeakMap<object, AudioSnap>();
    private sentPrev = new WeakMap<object, { at: number; frames: number }>();
    private readonly size: number;

    constructor(size: number = WEBRTC_RING_SIZE) {
        this.size = Math.max(1, Math.min(size, DIAGNOSTIC_LIMITS.maxWebrtcSamples));
    }

    get isActive(): boolean { return this.active; }

    /** A call connected: start a fresh buffer (the previous call's is dropped). */
    beginCall(): void {
        this.samples = [];
        this.active = true;
        this.endedAt = null;
        this.capture = null;
        this.names = new WeakMap();
        this.counters = new Map();
        this.prevSender = new WeakMap();
        this.prevReceiver = new WeakMap();
        this.prevAudio = new WeakMap();
        this.sentPrev = new WeakMap();
    }

    /** The call ended: keep the buffer, stop accepting samples. */
    endCall(now: number): void {
        if (!this.active) return;
        this.active = false;
        this.endedAt = now;
    }

    /** What the local capture was asked for (screen share / camera). */
    setCapture(c: CaptureInput | null): void {
        if (!this.active) return;
        this.capture = c ? { ...c } : null;
    }

    private nameFor(t: TrackStatsInput): string {
        const existing = this.names.get(t.ref);
        if (existing) return existing;
        const key = t.direction === 'outbound' ? `outbound:${t.source ?? 'unknown'}` : `inbound:${t.kind}`;
        const prefix = PLACEHOLDER_PREFIX[key] ?? 'track';
        const n = (this.counters.get(prefix) ?? 0) + 1;
        this.counters.set(prefix, n);
        const name = `${prefix}-${n}`;
        this.names.set(t.ref, name);
        return name;
    }

    /** Add one sample. Ignored when no call is active. */
    record(at: number, tracks: readonly TrackStatsInput[]): void {
        if (!this.active) return;
        const outbound: OutboundTrackStats[] = [];
        const inbound: InboundTrackStats[] = [];
        let rttMs: number | undefined;
        let availKbps: number | undefined;
        let lostDelta = 0;
        let recvDelta = 0;

        for (const t of tracks) {
            if (t.direction === 'outbound' && outbound.length >= MAX_OUTBOUND) continue;
            if (t.direction === 'inbound' && inbound.length >= MAX_INBOUND) continue;
            let entries: Map<string, StatsEntry>;
            try { entries = toMap(t.report); } catch { continue; }
            const pair = selectedPair(entries);
            if (pair) {
                const rtt = num(pair.currentRoundTripTime);
                if (rtt !== undefined && rttMs === undefined) rttMs = rtt * 1000;
                const avail = num(pair.availableOutgoingBitrate);
                if (t.direction === 'outbound' && avail !== undefined && avail > 0 && availKbps === undefined) availKbps = avail / 1000;
            }
            const track = this.nameFor(t);

            if (t.direction === 'outbound' && t.kind === 'video') {
                const prev = this.prevSender.get(t.ref) ?? null;
                const { stats: s, snapshot } = summarizeSender(entries.values(), prev, at);
                this.prevSender.set(t.ref, snapshot);
                const top = topOutboundVideo(entries);
                const durations = top && typeof top.qualityLimitationDurations === 'object' && top.qualityLimitationDurations
                    ? top.qualityLimitationDurations as Record<string, unknown> : null;
                const qls: Partial<Record<QualityLimitation, number>> = {};
                if (durations) for (const k of LIMITS) { const v = num(durations[k]); if (v !== undefined) qls[k] = r1(v)!; }
                const o: OutboundTrackStats = {
                    track, kind: 'video', source: t.source ?? 'unknown',
                    codec: safeName(s.codec), encoder: safeName(s.encoder), hardware: s.hardware,
                    target_fps: num(t.targetFps),
                    capture_fps: r1(s.captureFps),
                    encoded_fps: r1(s.encodedFps),
                    sent_fps: r1(this.sentFps(t.ref, top, at)),
                    width: r0(s.encodedWidth), height: r0(s.encodedHeight),
                    quality_limitation_reason: asLimitation(s.limitation),
                    quality_limitation_s: durations ? qls : undefined,
                    bitrate_kbps: s.sendMbps !== undefined ? r0(s.sendMbps * 1000) : undefined,
                    target_bitrate_kbps: s.targetMbps !== undefined ? r0(s.targetMbps * 1000)
                        : num(t.maxBitrateBps) !== undefined ? r0(t.maxBitrateBps! / 1000) : undefined,
                    nack_count: r0(s.nacks), pli_count: r0(s.plis),
                    ...layerCounts(entries),
                };
                outbound.push(prune(o));
            } else if (t.direction === 'outbound') {
                const rtp = [...entries.values()].find(e => e.type === 'outbound-rtp' && e.kind === 'audio');
                const bytes = num(rtp?.bytesSent) ?? 0;
                const prev = this.prevAudio.get(t.ref);
                this.prevAudio.set(t.ref, { at, bytes, lost: 0, recv: 0 });
                const dt = prev ? (at - prev.at) / 1000 : 0;
                outbound.push(prune({
                    track, kind: 'audio', source: t.source ?? 'unknown',
                    codec: rtp ? codecOf(entries, rtp.codecId) : undefined,
                    bitrate_kbps: prev && dt > 0 && bytes >= prev.bytes ? r0(((bytes - prev.bytes) * 8) / dt / 1000) : undefined,
                    nack_count: r0(num(rtp?.nackCount)),
                }));
            } else if (t.kind === 'video') {
                const prev = this.prevReceiver.get(t.ref) ?? null;
                const { stats: s, snapshot } = summarizeReceiver(entries.values(), prev, at);
                this.prevReceiver.set(t.ref, snapshot);
                if (prev && snapshot) {
                    lostDelta += Math.max(0, snapshot.packetsLost - prev.packetsLost);
                    recvDelta += Math.max(0, snapshot.packetsReceived - prev.packetsReceived);
                }
                const rtp = [...entries.values()].find(e => e.type === 'inbound-rtp' && e.kind === 'video');
                inbound.push(prune({
                    track, kind: 'video',
                    codec: safeName(s.codec), decoder: safeName(s.decoder), hardware: s.hardware,
                    fps: r1(s.fps), width: r0(s.width), height: r0(s.height),
                    bitrate_kbps: s.recvMbps !== undefined ? r0(s.recvMbps * 1000) : undefined,
                    packets_lost_pct: r1(s.lossPct),
                    jitter_ms: num(rtp?.jitter) !== undefined ? r1(num(rtp?.jitter)! * 1000) : undefined,
                    frames_dropped: r0(s.framesDropped),
                    freeze_count: r0(s.freezes),
                }));
            } else {
                const rtp = [...entries.values()].find(e => e.type === 'inbound-rtp' && e.kind === 'audio');
                const bytes = num(rtp?.bytesReceived) ?? 0;
                const lost = num(rtp?.packetsLost) ?? 0;
                const recv = num(rtp?.packetsReceived) ?? 0;
                const prev = this.prevAudio.get(t.ref);
                this.prevAudio.set(t.ref, { at, bytes, lost, recv });
                const dt = prev ? (at - prev.at) / 1000 : 0;
                const dl = prev ? Math.max(0, lost - prev.lost) : 0;
                const dr = prev ? Math.max(0, recv - prev.recv) : 0;
                lostDelta += dl;
                recvDelta += dr;
                inbound.push(prune({
                    track, kind: 'audio',
                    codec: rtp ? codecOf(entries, rtp.codecId) : undefined,
                    decoder: safeName(rtp?.decoderImplementation),
                    hardware: rtp ? isHardwareCodec(safeName(rtp.decoderImplementation), undefined) : undefined,
                    bitrate_kbps: prev && dt > 0 && bytes >= prev.bytes ? r0(((bytes - prev.bytes) * 8) / dt / 1000) : undefined,
                    packets_lost_pct: prev && dl + dr > 0 ? r1((dl / (dl + dr)) * 100) : undefined,
                    jitter_ms: num(rtp?.jitter) !== undefined ? r1(num(rtp?.jitter)! * 1000) : undefined,
                }));
            }
        }

        const transport = prune({
            rtt_ms: r1(rttMs),
            available_outgoing_kbps: r0(availKbps),
            packet_loss_pct: lostDelta + recvDelta > 0 ? r1((lostDelta / (lostDelta + recvDelta)) * 100) : undefined,
        });
        this.samples.push({ at, outbound, inbound, ...(Object.keys(transport).length ? { transport } : {}) });
        if (this.samples.length > this.size) this.samples.splice(0, this.samples.length - this.size);
    }

    // framesSent delta per second — "sent fps" (what left the encoder for the wire).
    private sentFps(ref: object, top: StatsEntry | undefined, at: number): number | undefined {
        const frames = num(top?.framesSent);
        if (frames === undefined) return undefined;
        const prev = this.sentPrev.get(ref);
        this.sentPrev.set(ref, { at, frames });
        if (!prev || at <= prev.at || frames < prev.frames) return undefined;
        return (frames - prev.frames) / ((at - prev.at) / 1000);
    }

    /** Wire-shaped summary; `t_s` is relative to `now` (≤ 0). */
    summary(now: number): WebrtcSummary {
        const samples: WebrtcSample[] = this.samples.map(({ at, ...rest }) => ({
            t_s: Math.round(((at - now) / 1000) * 10) / 10,
            ...structuredCloneSafe(rest),
        }));
        const out: WebrtcSummary = { call_active: this.active, samples };
        if (!this.active && this.endedAt !== null) out.seconds_since_call_end = Math.max(0, Math.round((now - this.endedAt) / 1000));
        if (this.capture) {
            // The measured capture rate of the capture track, newest sample.
            const wantSource = this.capture.kind === 'camera' ? 'camera' : 'screen_share';
            let measured: number | undefined;
            for (let i = this.samples.length - 1; i >= 0 && measured === undefined; i--) {
                measured = this.samples[i].outbound.find(o => o.source === wantSource && o.kind === 'video')?.capture_fps;
            }
            out.capture = prune({
                kind: this.capture.kind,
                requested_fps: num(this.capture.requestedFps),
                requested_resolution: this.capture.requestedResolution && /^[A-Za-z0-9]{1,12}$/.test(this.capture.requestedResolution) ? this.capture.requestedResolution : undefined,
                capture_fps: measured,
                codec_pref: this.capture.codecPref && /^[a-z0-9]{1,8}$/.test(this.capture.codecPref) ? this.capture.codecPref : undefined,
            });
        }
        return out;
    }

    /** Test hook. */
    reset(): void {
        this.beginCall();
        this.active = false;
    }
}

/** Drop undefined fields so the JSON (and the preview) carries only what was measured. */
function prune<T extends object>(o: T): T {
    for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
    return o;
}

function structuredCloneSafe<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

/** The app-wide ring (one call at a time). */
export const webrtcRing = new WebrtcRing();
