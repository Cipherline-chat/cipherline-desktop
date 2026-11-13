/**
 * The refresh rate of the display THIS window is on, estimated with a short
 * requestAnimationFrame measurement - for a viewer's report ("a 90 fps share
 * on a 60 Hz screen can never show more than 60"). Run once per watched share;
 * there is no continuous rAF loop: a measurement is ~MEASURE_FRAMES frames
 * (about half a second at 60 Hz) and then stops scheduling.
 *
 * rAF is throttled (or stopped) for a hidden / unfocused window, which would
 * read as a slow display: a measurement is only started when the page is
 * visible, and it gives up (null) after TIMEOUT_MS rather than report a
 * throttled rate. The caller retries on a later sample.
 *
 * The sharer side does not use this: the main process already reports the
 * captured display's displayFrequency (screenShareDiagnostics `main.displayHz`).
 */

/** Frames timed per measurement (the first delta is discarded). */
export const MEASURE_FRAMES = 31;
export const MEASURE_TIMEOUT_MS = 2_500;

/** Common panel refresh rates; an estimate within SNAP_TOLERANCE of one snaps to it. */
const COMMON_HZ = [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 200, 240, 360];
const SNAP_TOLERANCE = 0.04;

/** Typical inter-frame delta (ms, trimmed mean) -> Hz; null with too little data. Pure. */
export function estimateHzFromTimestamps(stamps: readonly number[]): number | null {
    if (stamps.length < 8) return null;
    const deltas: number[] = [];
    for (let i = 2; i < stamps.length; i++) { // [1] - [0] is skipped: the first frame lands mid-interval
        const d = stamps[i] - stamps[i - 1];
        if (d > 0 && Number.isFinite(d)) deltas.push(d);
    }
    if (deltas.length < 5) return null;
    // Mean of the middle 60%: a missed vsync (a double-length delta) falls in the
    // discarded top tail, and plain rAF jitter averages out - a bare median of a
    // bimodal jitter pattern would land on one of its two modes.
    deltas.sort((a, b) => a - b);
    const cut = Math.floor(deltas.length * 0.2);
    const mid = deltas.slice(cut, deltas.length - cut);
    const typical = mid.reduce((n, d) => n + d, 0) / mid.length;
    const hz = 1000 / typical;
    if (!Number.isFinite(hz) || hz < 10 || hz > 1000) return null;
    const snap = COMMON_HZ.find(c => Math.abs(hz - c) / c <= SNAP_TOLERANCE);
    return snap ?? Math.round(hz);
}

export interface MeasureDeps {
    raf?: (cb: (t: number) => void) => number;
    caf?: (id: number) => void;
    visible?: () => boolean;
    now?: () => number;
    timeoutMs?: number;
    frames?: number;
}

/** Measure now. Resolves null when the window is hidden or the rAF stream is too slow/short. Never rejects. */
export function measureDisplayHz(deps: MeasureDeps = {}): Promise<number | null> {
    const raf = deps.raf ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : undefined);
    if (!raf) return Promise.resolve(null);
    const caf = deps.caf ?? (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame.bind(globalThis) : undefined);
    const visible = deps.visible ?? (() => (typeof document === 'undefined' ? true : !document.hidden));
    const now = deps.now ?? (() => performance.now());
    if (!visible()) return Promise.resolve(null);
    const want = deps.frames ?? MEASURE_FRAMES;
    const timeout = deps.timeoutMs ?? MEASURE_TIMEOUT_MS;
    return new Promise<number | null>(resolve => {
        const stamps: number[] = [];
        const started = now();
        let id = 0;
        let done = false;
        const finish = (v: number | null) => { if (done) return; done = true; try { caf?.(id); } catch { /* gone */ } resolve(v); };
        const tick = (t: number) => {
            if (done) return;
            stamps.push(t);
            if (stamps.length >= want) { finish(estimateHzFromTimestamps(stamps)); return; }
            if (now() - started > timeout || !visible()) { finish(null); return; }
            id = raf(tick);
        };
        try { id = raf(tick); } catch { finish(null); }
    });
}
