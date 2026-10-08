/**
 * "Is this PC keeping up?" — detects SUSTAINED encoder CPU starvation on
 * what we send (camera and screen share) during a call.
 *
 * The signal is WebRTC's own verdict, per outgoing layer:
 * `qualityLimitationReason === 'cpu'` and the cumulative
 * `qualityLimitationDurations.cpu`. That is the encoder telling us it is
 * shedding resolution/frames because it cannot finish on time — the exact
 * thing the "Lower to 720p" offer fixes. It is NOT the network (that is
 * 'bandwidth', ignored here) and NOT a slow camera (capture fps is not
 * looked at), which are the two classic false positives of a plain
 * "fps is low" rule.
 *
 * Sustained = at least STRAINED_TICKS of the last WINDOW_TICKS one-second
 * samples were CPU-limited, the newest one included, and the source has been
 * live for WARMUP_MS (an encoder's first seconds — first keyframes, the
 * bandwidth estimate ramping, a camera opening — routinely trip the CPU flag
 * briefly). A gap in sampling longer than GAP_RESET_MS (the window was
 * hidden and timers were throttled, the machine slept) restarts the window
 * instead of bridging it.
 *
 * Whole-machine load is not used for the SEND side: it does not say the
 * CALL is the thing suffering — a game at 100% CPU with our encoder keeping
 * up is not a problem to offer anything for.
 *
 * The RECEIVE side (ReceiveLoadDetector below) answers the other question:
 * is decoding everyone else's video what is bogging this PC down?
 *
 * Pure: the caller feeds samples (CallPerformanceGuard.tsx).
 */

export const SAMPLE_INTERVAL_MS = 1000;
export const WINDOW_TICKS = 12;
export const STRAINED_TICKS = 10;
export const WARMUP_MS = 15_000;
export const GAP_RESET_MS = 3_000;

export type LoadSource = 'camera' | 'share';

export interface LayerLimitStats {
    /** Simulcast rid ('q'/'h'/'f'); the counters are matched across samples by it. */
    rid?: string;
    /** outbound-rtp qualityLimitationReason. */
    reason?: string;
    /** outbound-rtp qualityLimitationDurations.cpu, SECONDS, cumulative. */
    cpuSeconds?: number;
}

export interface SourceSample {
    /** Every outbound layer of the source (simulcast camera: up to three). */
    layers: readonly LayerLimitStats[];
}

export interface LoadSample {
    /** Monotonic ms (performance.now()). */
    at: number;
    camera?: SourceSample | null;
    share?: SourceSample | null;
}

interface SourceState {
    since: number;
    lastCpu: Map<string, number>;
    ticks: boolean[];
}

export interface LoadVerdict {
    struggling: boolean;
    sources: LoadSource[];
}

export class CallLoadDetector {
    private lastAt: number | null = null;
    private state: Partial<Record<LoadSource, SourceState>> = {};

    reset(): void {
        this.lastAt = null;
        this.state = {};
    }

    /** Feed one sample; returns the verdict after it. */
    observe(sample: LoadSample): LoadVerdict {
        if (this.lastAt !== null && sample.at - this.lastAt > GAP_RESET_MS) this.state = {};
        const dtS = this.lastAt === null ? SAMPLE_INTERVAL_MS / 1000 : Math.max(0.001, (sample.at - this.lastAt) / 1000);
        this.lastAt = sample.at;
        const sources: LoadSource[] = [];
        for (const key of ['camera', 'share'] as const) {
            const s = sample[key];
            if (!s || s.layers.length === 0) { delete this.state[key]; continue; }
            let st = this.state[key];
            if (!st) { st = { since: sample.at, lastCpu: new Map(), ticks: [] }; this.state[key] = st; }
            const cpuNow = new Map<string, number>();
            // Strained this tick: any layer CPU-limited for most of it, or
            // reporting 'cpu' right now when no duration counter is available.
            let strained = false;
            s.layers.forEach((l, i) => {
                const id = l.rid ?? String(i);
                const cur = typeof l.cpuSeconds === 'number' && Number.isFinite(l.cpuSeconds) ? l.cpuSeconds : NaN;
                if (Number.isFinite(cur)) cpuNow.set(id, cur);
                const prev = st!.lastCpu.get(id);
                if (prev !== undefined && Number.isFinite(cur) && cur >= prev) {
                    if (cur - prev >= 0.5 * dtS) strained = true;
                } else if (l.reason === 'cpu') {
                    strained = true;
                }
            });
            st.lastCpu = cpuNow;
            st.ticks.push(strained);
            if (st.ticks.length > WINDOW_TICKS) st.ticks.shift();
            const live = sample.at - st.since >= WARMUP_MS;
            const count = st.ticks.filter(Boolean).length;
            if (live && strained && count >= STRAINED_TICKS) sources.push(key);
        }
        return { struggling: sources.length > 0, sources };
    }
}

/** Read the limitation stats of every outbound video layer from a sender's report. */
export function layerLimitStats(report: { forEach(cb: (s: Record<string, unknown>) => void): void }): LayerLimitStats[] {
    const out: LayerLimitStats[] = [];
    report.forEach(s => {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
        const d = s.qualityLimitationDurations as { cpu?: unknown } | undefined;
        out.push({
            rid: typeof s.rid === 'string' ? s.rid : undefined,
            reason: typeof s.qualityLimitationReason === 'string' ? s.qualityLimitationReason : undefined,
            cpuSeconds: typeof d?.cpu === 'number' ? d.cpu : undefined,
        });
    });
    return out;
}
