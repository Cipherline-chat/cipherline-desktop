/**
 * Receive side of "is this PC keeping up?": is DECODING everyone else's
 * video what is bogging it down (as opposed to our own encoder —
 * callLoadMonitor.ts — or the network)?
 *
 * Per one-second tick, summed over every remote video track that decoded
 * something (deltas of the cumulative inbound-rtp counters, matched by id):
 *   dropRatio = framesDropped / (framesDecoded + framesDropped)
 *   decodeMs  = totalDecodeTime / framesDecoded              (avg per frame)
 *   lossRatio = packetsLost / (packetsLost + packetsReceived)
 *   nackRatio = nackCount / packetsReceived
 *   jbMs      = jitterBufferDelay / jitterBufferEmittedCount
 *   freezes   = freezeCount growth
 *
 * NETWORK tick: loss ≥ 2 %, or NACKs ≥ 5 % of packets, or the jitter buffer
 * ≥ 80 ms above its own best level this call. The picture suffers, but
 * decoding less would not help the PC and the offer would blame the wrong
 * thing — a network tick NEVER counts as decode pressure.
 *
 * DECODE tick (local CPU): not a network tick, ≥ 2 remote videos decoding,
 * and any of
 *   - ≥ 5 % of arriving frames dropped before display,
 *   - decode ≥ 16 ms per frame on average (half a 30 fps frame budget —
 *     streams share decoder threads, so half is where frames start to queue),
 *   - a freeze while drops (≥ 2 %) or decode time (≥ 10 ms) are elevated.
 * When the CPU of the renderer + GPU process is known (main's getAppMetrics via the
 * perf:get-process-cpu IPC) and is below 15 % of one core, the tick is NOT a
 * decode tick: an idle renderer cannot be the bottleneck (rules out drops from
 * display timing alone). Unknown CPU never vetoes.
 *
 * Sustained = the send side's rule: 10 of the last 12 ticks, the newest
 * included, after a 15 s warm-up; a sampling gap > 3 s restarts everything.
 * "fps below what the sender sends" is not used directly: the receiver does
 * not know the sender's rate, and the frames that go missing locally are
 * exactly what framesDropped counts.
 *
 * Pure: the caller feeds samples (CallPerformanceGuard.tsx).
 */
import { WINDOW_TICKS, STRAINED_TICKS, WARMUP_MS, GAP_RESET_MS } from './callLoadMonitor';

export const MIN_DECODING_TRACKS = 2;
export const LOSS_NETWORK = 0.02;
export const NACK_NETWORK = 0.05;
export const JB_GROWTH_NETWORK_MS = 80;
export const DROP_DECODE = 0.05;
export const DECODE_MS_DECODE = 16;
export const FREEZE_DROP = 0.02;
export const FREEZE_DECODE_MS = 10;
export const CPU_IDLE_PCT = 15;

export interface InboundVideoStats {
    /** Stable per-track key (the track sid). */
    id: string;
    framesDecoded?: number;
    framesDropped?: number;
    /** Seconds, cumulative. */
    totalDecodeTime?: number;
    packetsReceived?: number;
    packetsLost?: number;
    nackCount?: number;
    freezeCount?: number;
    /** Seconds, cumulative. */
    jitterBufferDelay?: number;
    jitterBufferEmittedCount?: number;
}

type Counters = Required<Omit<InboundVideoStats, 'id'>>;
const COUNTERS: (keyof Counters)[] = [
    'framesDecoded', 'framesDropped', 'totalDecodeTime', 'packetsReceived', 'packetsLost',
    'nackCount', 'freezeCount', 'jitterBufferDelay', 'jitterBufferEmittedCount',
];

export interface ReceiveSample {
    at: number;
    tracks: readonly InboundVideoStats[];
    /** Renderer process CPU, percent of ONE core; null/undefined = unknown. */
    rendererCpuPct?: number | null;
}

export interface ReceiveTick {
    decodingTracks: number;
    dropRatio: number;
    decodeMs: number | null;
    lossRatio: number;
    nackRatio: number;
    jbMs: number | null;
    freezes: number;
    network: boolean;
    decode: boolean;
}

export interface ReceiveVerdict {
    /** Sustained local decode/CPU pressure from incoming video. */
    decodeBound: boolean;
    /** Sustained network trouble on incoming video (no offer is made for it). */
    networkBound: boolean;
    tick: ReceiveTick | null;
}

const n0 = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Classify one tick from per-track deltas. */
export function classifyReceiveTick(
    deltas: readonly Counters[],
    jbFloorMs: number | null,
    rendererCpuPct?: number | null,
): ReceiveTick {
    let decoded = 0, dropped = 0, decodeS = 0, recv = 0, lost = 0, nacks = 0, freezes = 0, jbS = 0, jbN = 0, decodingTracks = 0;
    for (const d of deltas) {
        decoded += d.framesDecoded; dropped += d.framesDropped; decodeS += d.totalDecodeTime;
        recv += d.packetsReceived; lost += Math.max(0, d.packetsLost); nacks += d.nackCount; freezes += d.freezeCount;
        jbS += d.jitterBufferDelay; jbN += d.jitterBufferEmittedCount;
        if (d.framesDecoded > 0) decodingTracks++;
    }
    const dropRatio = decoded + dropped > 0 ? dropped / (decoded + dropped) : 0;
    const decodeMs = decoded > 0 ? (decodeS * 1000) / decoded : null;
    const lossRatio = lost + recv > 0 ? lost / (lost + recv) : 0;
    const nackRatio = recv > 0 ? nacks / recv : 0;
    const jbMs = jbN > 0 ? (jbS * 1000) / jbN : null;
    const jbGrown = jbMs !== null && jbFloorMs !== null && jbMs - jbFloorMs >= JB_GROWTH_NETWORK_MS;
    const network = lossRatio >= LOSS_NETWORK || nackRatio >= NACK_NETWORK || jbGrown;
    const cpuIdle = typeof rendererCpuPct === 'number' && Number.isFinite(rendererCpuPct) && rendererCpuPct < CPU_IDLE_PCT;
    const pressure =
        dropRatio >= DROP_DECODE
        || (decodeMs !== null && decodeMs >= DECODE_MS_DECODE)
        || (freezes > 0 && (dropRatio >= FREEZE_DROP || (decodeMs ?? 0) >= FREEZE_DECODE_MS));
    const decode = !network && !cpuIdle && decodingTracks >= MIN_DECODING_TRACKS && pressure;
    return { decodingTracks, dropRatio, decodeMs, lossRatio, nackRatio, jbMs, freezes, network, decode };
}

export class ReceiveLoadDetector {
    private lastAt: number | null = null;
    private since: number | null = null;
    private prev = new Map<string, Counters>();
    private decodeTicks: boolean[] = [];
    private netTicks: boolean[] = [];
    private jbFloor: number | null = null;

    reset(): void {
        this.lastAt = null;
        this.since = null;
        this.prev = new Map();
        this.decodeTicks = [];
        this.netTicks = [];
        this.jbFloor = null;
    }

    observe(sample: ReceiveSample): ReceiveVerdict {
        if (this.lastAt !== null && sample.at - this.lastAt > GAP_RESET_MS) this.reset();
        this.lastAt = sample.at;
        if (this.since === null) this.since = sample.at;
        const deltas: Counters[] = [];
        const next = new Map<string, Counters>();
        for (const t of sample.tracks) {
            const cur = {} as Counters;
            for (const k of COUNTERS) cur[k] = n0(t[k]);
            next.set(t.id, cur);
            const p = this.prev.get(t.id);
            if (!p) continue; // first sight of this track: no delta yet
            const d = {} as Counters;
            let replaced = false;
            for (const k of COUNTERS) {
                d[k] = cur[k] - p[k];
                // packetsLost can legitimately fall (late arrivals); any other
                // counter going backwards means the track was replaced.
                if (d[k] < 0 && k !== 'packetsLost') replaced = true;
            }
            if (!replaced) deltas.push(d);
        }
        this.prev = next;
        if (deltas.length === 0) {
            this.decodeTicks = [];
            this.netTicks = [];
            return { decodeBound: false, networkBound: false, tick: null };
        }
        const tick = classifyReceiveTick(deltas, this.jbFloor, sample.rendererCpuPct);
        if (tick.jbMs !== null && !tick.network) this.jbFloor = this.jbFloor === null ? tick.jbMs : Math.min(this.jbFloor, tick.jbMs);
        const push = (arr: boolean[], v: boolean) => { arr.push(v); if (arr.length > WINDOW_TICKS) arr.shift(); };
        push(this.decodeTicks, tick.decode);
        push(this.netTicks, tick.network);
        const live = sample.at - this.since >= WARMUP_MS;
        const sustained = (arr: boolean[], now: boolean) => live && now && arr.filter(Boolean).length >= STRAINED_TICKS;
        return {
            decodeBound: sustained(this.decodeTicks, tick.decode),
            networkBound: sustained(this.netTicks, tick.network),
            tick,
        };
    }
}

/**
 * main's perf:get-process-cpu answer → the CPU the veto looks at: renderer
 * plus GPU process (hardware decode runs in the GPU process, so a renderer
 * that looks idle can still be decoding). null = unknown (never vetoes).
 */
export function parseProcessCpu(v: unknown): number | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as { renderer?: unknown; gpu?: unknown };
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
    const r = num(o.renderer);
    if (r === null) return null;
    return r + (num(o.gpu) ?? 0);
}

/** The first inbound video entry of one remote track's stats report. */
export function inboundVideoStats(
    id: string,
    report: { forEach(cb: (s: Record<string, unknown>) => void): void },
): InboundVideoStats | null {
    let out: InboundVideoStats | null = null;
    report.forEach(s => {
        if (out || s.type !== 'inbound-rtp' || s.kind !== 'video') return;
        const num = (k: string) => (typeof s[k] === 'number' ? s[k] as number : undefined);
        out = {
            id,
            framesDecoded: num('framesDecoded'), framesDropped: num('framesDropped'), totalDecodeTime: num('totalDecodeTime'),
            packetsReceived: num('packetsReceived'), packetsLost: num('packetsLost'), nackCount: num('nackCount'),
            freezeCount: num('freezeCount'), jitterBufferDelay: num('jitterBufferDelay'), jitterBufferEmittedCount: num('jitterBufferEmittedCount'),
        };
    });
    return out;
}
