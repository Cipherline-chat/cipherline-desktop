/**
 * Beta diagnostics — the per-call quality summary, computed from what the
 * call engine ALREADY measures:
 *
 *   - the issue reporter's WebRTC sampler (utils/diagnostics/webrtcRing.ts,
 *     one getStats() per track every 5 s while connected) — RTT, loss, jitter,
 *     fps, codecs, encoder quality limitation. The ring keeps only 2 minutes;
 *     this accumulates the whole call from the same samples (tap, no extra
 *     getStats);
 *   - the call event log (utils/callEventLog.ts) — ICE route type, freezes,
 *     reconnects, E2EE decrypt errors, participant counts.
 *
 * Pure: no React, no LiveKit, no timers. The BetaCallMonitor component feeds
 * it and sends the result at call end. Nothing here holds an identity: tracks
 * are the ring's placeholders, peers are a count.
 */
import type { WebrtcSample } from '../diagnostics/reportTypes';
import type {
    BetaCallSummaryBody, CallEndReason, CallTransport, CallType, DurationBucket,
} from './types';

export type CallSummaryCore = Omit<BetaCallSummaryBody, 'schema' | 'session_id' | 'app_version' | 'platform' | 'call_summary_id'>;

const DURATION_BUCKETS: readonly DurationBucket[] = [0, 30, 60, 300, 900, 1800, 3600, 7200];
const MAX_SAMPLES = 5000;
/** A gap longer than this between two samples (sleep, a frozen renderer) is not counted as "limited" time. */
const MAX_SAMPLE_GAP_MS = 10_000;

export function durationBucket(seconds: number): DurationBucket {
    let b: DurationBucket = 0;
    for (const x of DURATION_BUCKETS) if (seconds >= x) b = x;
    return b;
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
    const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return 0;
    const rank = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
    return Math.round(v[rank] * 10) / 10;
}

/** ICE route protocol (callEventStats.iceRouteFromStats) → contract transport. */
export function transportFromRoute(protocol: unknown, relay: unknown): CallTransport {
    const p = typeof protocol === 'string' ? protocol.toLowerCase() : '';
    if (p.startsWith('turn-') || relay === true) {
        if (p === 'turn-udp') return 'turn_udp';
        if (p === 'turn-tcp' || p === 'turn-tls') return 'turn_tcp';
        return p === 'udp' ? 'turn_udp' : p === 'tcp' ? 'turn_tcp' : 'unknown';
    }
    if (p === 'udp') return 'udp';
    if (p === 'tcp') return 'tcp';
    return 'unknown';
}

const codecName = (c: unknown): string | undefined =>
    (typeof c === 'string' && /^[A-Za-z0-9._-]{1,24}$/.test(c) ? c.toLowerCase() : undefined);

function mostCommon(m: Map<string, number>): string | undefined {
    let best: string | undefined;
    let n = 0;
    for (const [k, v] of m) if (v > n) { best = k; n = v; }
    return best;
}

export class CallSummaryAccumulator {
    private readonly callType: CallType;
    private readonly e2ee: boolean;
    private readonly startedAt: number;
    private rtt: number[] = [];
    private loss: number[] = [];
    private jitter: number[] = [];
    private fps: number[] = [];
    private audioCodecs = new Map<string, number>();
    private sentVideoCodecs = new Map<string, number>();
    private recvVideoCodecs = new Map<string, number>();
    private sentVideo = false;
    private screenShare = false;
    private cpuLimitedMs = 0;
    private bwLimitedMs = 0;
    private lastSampleAt: number | null = null;
    private transport: CallTransport = 'unknown';
    private freezes = 0;
    private reconnects = 0;
    private e2eeErrors = 0;
    private peersMax = 0;
    private firstAudioMs: number | undefined;
    private endReason: CallEndReason | null = null;

    constructor(o: { callType: CallType; e2ee: boolean; startedAt: number }) {
        this.callType = o.callType;
        this.e2ee = o.e2ee;
        this.startedAt = o.startedAt;
    }

    /** One webrtcRing sample (shape of WebrtcSample minus t_s). */
    onSample(s: Pick<WebrtcSample, 'outbound' | 'inbound' | 'transport'>, at: number): void {
        if (this.rtt.length + this.loss.length > MAX_SAMPLES * 2) return;
        if (typeof s.transport?.rtt_ms === 'number') this.rtt.push(s.transport.rtt_ms);
        if (typeof s.transport?.packet_loss_pct === 'number') this.loss.push(s.transport.packet_loss_pct);
        let jit: number | undefined;
        for (const t of s.inbound ?? []) {
            if (t.kind === 'audio') {
                if (typeof t.jitter_ms === 'number') jit = Math.max(jit ?? 0, t.jitter_ms);
                const c = codecName(t.codec); if (c) this.audioCodecs.set(c, (this.audioCodecs.get(c) ?? 0) + 1);
            } else {
                if (typeof t.fps === 'number') this.fps.push(t.fps);
                const c = codecName(t.codec); if (c) this.recvVideoCodecs.set(c, (this.recvVideoCodecs.get(c) ?? 0) + 1);
            }
        }
        if (jit !== undefined) this.jitter.push(jit);
        let cpu = false;
        let bw = false;
        for (const t of s.outbound ?? []) {
            if (t.kind === 'audio') {
                const c = codecName(t.codec); if (c) this.audioCodecs.set(c, (this.audioCodecs.get(c) ?? 0) + 1);
                continue;
            }
            if (t.source === 'camera') this.sentVideo = true;
            if (t.source === 'screen_share') this.screenShare = true;
            const c = codecName(t.codec); if (c) this.sentVideoCodecs.set(c, (this.sentVideoCodecs.get(c) ?? 0) + 1);
            if (t.quality_limitation_reason === 'cpu') cpu = true;
            if (t.quality_limitation_reason === 'bandwidth') bw = true;
        }
        if (this.lastSampleAt !== null) {
            const dt = at - this.lastSampleAt;
            if (dt > 0 && dt <= MAX_SAMPLE_GAP_MS) {
                if (cpu) this.cpuLimitedMs += dt;
                if (bw) this.bwLimitedMs += dt;
            }
        }
        this.lastSampleAt = at;
    }

    /** One call-event-log entry (kind + detail as logged). */
    onCallEvent(kind: string, detail?: Record<string, unknown>): void {
        switch (kind) {
            case 'ice_route':
                // The subscriber leg carries what we hear; prefer it, else whatever we saw.
                if (detail?.pc === 'subscriber' || this.transport === 'unknown') {
                    this.transport = transportFromRoute(detail?.protocol, detail?.turn);
                }
                break;
            case 'freeze_start': this.freezes++; break;
            case 'reconnecting': this.reconnects++; break;
            case 'e2ee_decrypt_error': this.e2eeErrors++; break;
            case 'call_join':
            case 'call_leave':
                this.notePeers(Number(detail?.participants) - 1);
                break;
            case 'participants':
                this.notePeers(Number(detail?.count) - 1);
                break;
            default: break;
        }
    }

    notePeers(n: number): void {
        if (Number.isFinite(n) && n > this.peersMax) this.peersMax = Math.min(Math.floor(n), 10_000);
    }

    noteFirstAudio(ms: number): void {
        if (this.firstAudioMs === undefined && Number.isFinite(ms) && ms >= 0) this.firstAudioMs = Math.round(ms);
    }

    get timeToFirstAudioMs(): number | undefined { return this.firstAudioMs; }

    /** The most specific reason wins: error > kicked > dropped > shutdown > remote > user. */
    noteEndReason(r: CallEndReason): void {
        const rank: Record<CallEndReason, number> = { error: 6, kicked: 5, dropped: 4, shutdown: 3, remote: 2, user: 1 };
        if (!this.endReason || rank[r] > rank[this.endReason]) this.endReason = r;
    }

    finish(endAt: number, defaultReason: CallEndReason = 'remote'): CallSummaryCore {
        const seconds = Math.max(0, (endAt - this.startedAt) / 1000);
        const sentCodec = mostCommon(this.sentVideoCodecs);
        const recvCodec = mostCommon(this.recvVideoCodecs);
        const videoCodec = (this.sentVideo || this.screenShare) && sentCodec ? sentCodec : recvCodec ?? sentCodec;
        const out: CallSummaryCore = {
            call_type: this.callType,
            duration_s_bucket: durationBucket(seconds),
            peers_max: this.peersMax,
            e2ee: this.e2ee,
            audio_codec: mostCommon(this.audioCodecs) ?? 'unknown',
            ...(videoCodec ? { video_codec: videoCodec } : {}),
            sent_video: this.sentVideo,
            screen_share: this.screenShare,
            transport: this.transport,
            rtt_ms_p50: percentile(this.rtt, 50),
            rtt_ms_p95: percentile(this.rtt, 95),
            jitter_ms_p95: percentile(this.jitter, 95),
            loss_pct_p50: percentile(this.loss, 50),
            loss_pct_p95: percentile(this.loss, 95),
            video_freezes: this.freezes,
            ...(this.fps.length ? { fps_p50: percentile(this.fps, 50) } : {}),
            cpu_limited_s: Math.round(this.cpuLimitedMs / 1000),
            bw_limited_s: Math.round(this.bwLimitedMs / 1000),
            reconnects: this.reconnects,
            e2ee_errors: this.e2eeErrors,
            ...(this.firstAudioMs !== undefined ? { time_to_first_audio_ms: this.firstAudioMs } : {}),
            end_reason: this.endReason ?? defaultReason,
        };
        return out;
    }
}

// ── one-way audio, inbound ─────────────────────────────────────────────────

/** An unmuted, subscribed remote mic whose packet count has not moved for this long = we are not hearing them. */
export const INBOUND_STALL_MS = 15_000;

export interface InboundAudioReading {
    /** The track OBJECT — a map key only, never read or stored beyond this call. */
    ref: object;
    /** Publisher says the mic is on (LiveKit's publication mute state). */
    unmuted: boolean;
    packetsReceived: number;
}

/**
 * "We can't hear them": an unmuted remote microphone, subscribed, whose
 * inbound packet count stays flat for INBOUND_STALL_MS. An unmuted mic keeps
 * sending (comfort-noise / DTX packets at least) even when its owner is
 * silent, so a flat count is a dead inbound path — not a quiet person. The
 * outbound half ("they can't hear us") is SidebarConference's existing
 * SilenceWatchdog (utils/audioSilenceWatchdog.ts).
 *
 * Fires at most once per call (returns true on that update only).
 */
export class InboundAudioStallDetector {
    private state = new WeakMap<object, { packets: number; since: number }>();
    private fired = false;

    update(readings: readonly InboundAudioReading[], now: number): boolean {
        if (this.fired) return false;
        for (const r of readings) {
            const prev = this.state.get(r.ref);
            if (!r.unmuted) { this.state.delete(r.ref); continue; }
            if (!prev || r.packetsReceived !== prev.packets) {
                this.state.set(r.ref, { packets: r.packetsReceived, since: now });
                continue;
            }
            if (now - prev.since >= INBOUND_STALL_MS) {
                this.fired = true;
                return true;
            }
        }
        return false;
    }
}
