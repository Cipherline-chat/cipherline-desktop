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

/** media-source `frames` summed over the sender's video sources; undefined when the report has none. */
export function capturedFrames(report: { forEach(cb: (s: Record<string, unknown>) => void): void }): number | undefined {
    let total: number | undefined;
    report.forEach(s => {
        if (s.type === 'media-source' && s.kind === 'video' && typeof s.frames === 'number' && Number.isFinite(s.frames)) total = (total ?? 0) + s.frames;
    });
    return total;
}

// ── A camera whose CAPTURE has stopped delivering ───────────────────────────
//
// CallLoadDetector above deliberately ignores capture rate ("a slow camera" is
// not the encoder's fault), so a camera that nominally runs at 30 fps but
// really hands the encoder 0-14 frames a second is invisible to every
// detector we have: the encoder is healthy (encoded_fps follows the capture,
// `limit=none`), nothing is lost, nothing "stalls" (EncoderStallDetector only
// fires when capture flows and encoding does not), and the start-time
// settleCaptureMode() reads the NOMINAL frameRate, which stays 30.
//
// Owner report 884b6045 (1.0.24-staging.178): "my camera freezes for me and
// for everyone when playing a game" - HEVC hardware camera next to a 2560x1440
// H.265 share and BeamNG on one RTX 2080 Ti; the camera's media-source rate
// over a minute of 5 s samples was 14, 0, 10, 10, 4, 0, 2, 0, 0, 1, 0, 0, 10
// (target 30), encoded_fps 9, sent 6, no bandwidth or CPU limitation.
// The local self-view froze too, which is why it is the capture and not the
// network or the viewers' decoders.

/** Delivered below this share of the camera's nominal frame rate ... */
export const CAPTURE_STARVE_FRACTION = 0.5;
/** ... and below this absolute rate, is a starved tick. */
export const CAPTURE_STARVE_MAX_FPS = 20;

export interface CaptureSample {
    /** Monotonic ms. */
    at: number;
    /** media-source `frames`, cumulative; null/undefined = the report did not carry it. */
    framesCaptured: number | null | undefined;
    /** The capture's negotiated frame rate (track.getSettings().frameRate); 30 when unknown. */
    nominalFps: number;
}

export interface CaptureVerdict {
    starved: boolean;
    /** Delivered rate over the last tick, when measurable. */
    fps?: number;
}

/**
 * Sustained capture starvation: at least STRAINED_TICKS of the last
 * WINDOW_TICKS one-second ticks delivered under min(50 % of nominal, 20 fps),
 * the newest one included, after WARMUP_MS (a camera opening delivers nothing
 * for a moment). A reset counter, a gap in sampling > GAP_RESET_MS (hidden
 * window, sleep) or a sample without a frame counter restarts the baseline
 * rather than bridging it.
 */
export class CameraCaptureStarveDetector {
    private since: number | null = null;
    private prev: { at: number; frames: number } | null = null;
    private ticks: boolean[] = [];

    reset(): void { this.since = null; this.prev = null; this.ticks = []; }

    observe(s: CaptureSample): CaptureVerdict {
        const frames = typeof s.framesCaptured === 'number' && Number.isFinite(s.framesCaptured) ? s.framesCaptured : null;
        if (frames === null) { this.reset(); return { starved: false }; }
        if (this.prev && s.at - this.prev.at > GAP_RESET_MS) { this.since = null; this.prev = null; this.ticks = []; }
        if (this.since === null) this.since = s.at;
        const prev = this.prev;
        this.prev = { at: s.at, frames };
        if (!prev || frames < prev.frames) {
            // First sample, or the counter restarted (a new track): a new baseline.
            this.ticks = [];
            if (prev) this.since = s.at;
            return { starved: false };
        }
        const dt = (s.at - prev.at) / 1000;
        if (!(dt > 0.2)) return { starved: false };
        const fps = (frames - prev.frames) / dt;
        const nominal = Number.isFinite(s.nominalFps) && s.nominalFps > 0 ? s.nominalFps : 30;
        const low = fps < Math.min(CAPTURE_STARVE_FRACTION * nominal, CAPTURE_STARVE_MAX_FPS);
        this.ticks.push(low);
        if (this.ticks.length > WINDOW_TICKS) this.ticks.shift();
        const live = s.at - this.since >= WARMUP_MS;
        const count = this.ticks.filter(Boolean).length;
        return { starved: live && low && count >= STRAINED_TICKS, fps: Math.round(fps * 10) / 10 };
    }
}
