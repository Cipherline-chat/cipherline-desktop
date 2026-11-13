/**
 * What the COMPOSITOR did with a watched share, measured with
 * HTMLVideoElement.requestVideoFrameCallback (rVFC), to locate where frames
 * die between "decoded" (dec_fps) and "painted" (disp_fps).
 *
 * rVFC fires at most once per compositor frame for a new video frame, and its
 * metadata.presentedFrames is the element's own count of frames handed to the
 * compositor. So in a window:
 *   vf_fps    callbacks per second   - capped by the display's refresh rate
 *             (a 60 Hz output cannot report more than ~60 even when 88 fps arrive);
 *   pres_fps  presentedFrames delta  - frames the element presented;
 *   gap_p95_ms / gap_max_ms          - inter-callback gaps: a decoder that keeps
 *             its average (dec 88) but delivers in bursts shows long gaps here;
 *   late_pct  callbacks whose gap > 1.5x the median gap (a hitch each).
 * Read with `getVideoPlaybackQuality` (disp_fps) this separates the causes:
 *   vf_fps ~ refresh Hz < dec_fps  -> the display, not the pipeline, is the limit;
 *   vf_fps ~ dec_fps, disp_fps low -> the element dropped frames it was given;
 *   large gap_p95 with a healthy average -> burst delivery (decoder / jitter buffer).
 *
 * The callback chain is armed lazily by the first read for an element and ends
 * itself when the element is disconnected, the probe is stopped, or the
 * browser has no rVFC. Counters only; no content, ids or names.
 */

export interface PresentWindow { vf_fps: number; pres_fps?: number; gap_p95_ms: number; gap_max_ms: number; late_pct: number }

type RvfcEl = {
    isConnected?: boolean;
    requestVideoFrameCallback?: (cb: (now: number, meta: { presentedFrames?: number }) => void) => number;
    cancelVideoFrameCallback?: (h: number) => void;
};

const MAX_GAPS = 2048;

export class PresentProbe {
    private handle: number | null = null;
    private stopped = false;
    private gaps: number[] = [];
    private lastAt: number | null = null;
    private cb = 0;
    private presentedFirst: number | null = null;
    private presentedLast: number | null = null;
    private winStart: number;
    private readonly el: RvfcEl;
    private readonly clock: () => number;

    constructor(el: RvfcEl, clock: () => number = () => performance.now()) {
        this.el = el;
        this.clock = clock;
        this.winStart = clock();
        this.arm();
    }

    private arm(): void {
        if (this.stopped || typeof this.el.requestVideoFrameCallback !== 'function' || this.el.isConnected === false) return;
        try {
            this.handle = this.el.requestVideoFrameCallback((now, meta) => {
                this.handle = null;
                this.onFrame(now, meta?.presentedFrames);
                this.arm();
            });
        } catch { this.stopped = true; }
    }

    /** Exposed for tests (the real callback calls it). */
    onFrame(now: number, presented: number | undefined): void {
        this.cb++;
        if (this.lastAt !== null) {
            const g = now - this.lastAt;
            if (g >= 0 && this.gaps.length < MAX_GAPS) this.gaps.push(g);
        }
        this.lastAt = now;
        if (typeof presented === 'number' && Number.isFinite(presented)) {
            if (this.presentedFirst === null) this.presentedFirst = presented;
            this.presentedLast = presented;
        }
    }

    /** Stats since the previous drain (null: window too short or no callbacks); restarts the window. */
    drain(): PresentWindow | null {
        const at = this.clock();
        const dt = (at - this.winStart) / 1000;
        const gaps = this.gaps;
        const cb = this.cb;
        const pf = this.presentedFirst, pl = this.presentedLast;
        this.gaps = []; this.cb = 0; this.winStart = at; this.presentedFirst = null; this.presentedLast = null;
        // The next window's first callback has no predecessor inside it: do not count the idle time between windows as a gap.
        this.lastAt = null;
        if (!(dt >= 0.5) || cb === 0) return null;
        const sorted = [...gaps].sort((a, b) => a - b);
        const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
        const med = q(0.5);
        const r1 = (n: number) => Math.round(n * 10) / 10;
        const out: PresentWindow = {
            vf_fps: r1(cb / dt),
            gap_p95_ms: Math.round(q(0.95)),
            gap_max_ms: Math.round(sorted.length ? sorted[sorted.length - 1] : 0),
            late_pct: sorted.length ? Math.round((sorted.filter(g => g > med * 1.5).length / sorted.length) * 100) : 0,
        };
        if (pf !== null && pl !== null && pl >= pf && cb > 1) out.pres_fps = r1((pl - pf + 1) / dt);
        return out;
    }

    stop(): void {
        this.stopped = true;
        try { if (this.handle !== null) this.el.cancelVideoFrameCallback?.(this.handle); } catch { /* element gone */ }
        this.handle = null;
    }
}

const probes = new WeakMap<object, PresentProbe>();

/** The probe for an element (created, and armed, on first use). */
export function presentProbeFor(el: RvfcEl & object): PresentProbe | null {
    if (typeof el.requestVideoFrameCallback !== 'function') return null;
    let p = probes.get(el);
    if (!p) { p = new PresentProbe(el); probes.set(el, p); }
    return p;
}
