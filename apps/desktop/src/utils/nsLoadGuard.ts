/**
 * Strong noise suppression (RNNoise) under CPU starvation — detect it, and
 * fall back to Light (Speex) for the rest of the call.
 *
 * ── Where the cost is
 *
 * Strong runs RNNoise's WASM synchronously inside an AudioWorklet
 * (rnnoiseInWorkletSource.ts), on the AudioContext's render thread. Measured
 * with the real worklet processors (dev box, i7-8700T, V8 as in Chromium 150):
 *   Strong  122 ms of CPU per second of audio (12 % of a core); a quantum
 *           that runs a 480-sample RNNoise frame takes up to ~1.9 ms of its
 *           2.67 ms budget;
 *   Light   5.2 ms per second (0.5 % of a core), worst quantum 0.04 ms —
 *           ~23x cheaper.
 * That thread is already the best the platform gives a non-admin app:
 * Chromium 150 runs a top-level page's AudioWorklet on its "Realtime
 * AudioWorklet" thread (verified in Electron 43: the thread exists by default,
 * no feature switch needed), which on Windows is THREAD_PRIORITY_TIME_CRITICAL,
 * and the renderer process is already ABOVE_NORMAL during calls
 * (electron/gaming-video-mode.ts) — TIME_CRITICAL in any non-realtime class is
 * priority 15, so a higher process class gains nothing. When a game still
 * starves it, the only lever left is doing less work on it.
 *
 * ── Why the existing auto-bypass never fired
 *
 * NsOutputRing's underrun auto-bypass (nsKernel.js) counts samples the
 * PRODUCER failed to deliver. With the inline (synchronous) producer it can
 * never fall behind — a slow frame just makes the whole render callback late,
 * and the glitch happens downstream of every worklet. The signal for that is
 * the context's own `playbackStats` (Chromium's AudioContext.playbackStats:
 * underrunEvents / underrunDuration / totalDuration, cumulative seconds;
 * verified present in Electron 43 and counting — a worklet burning 4 ms per
 * quantum for ~3 s produced 239 events / 2.78 s of underrun).
 *
 * ── The rule
 *
 * One tick per second. A bad tick = ≥ BAD_UNDERRUN_MS of underrun in it.
 * TRIP_BAD bad ticks within the last WINDOW ticks while Strong is the running
 * engine → fall back to Light, latched until the user picks a mode again (a
 * clean run AFTER the switch says nothing about whether RNNoise would fit, so
 * there is no automatic way back). Light rather than Chromium's own (WebRTC)
 * noise suppression: Light is already in the graph and switches with one
 * message, while the WebRTC suppressor lives in the capture and can only be
 * changed by re-opening the microphone (micDeviceSync.captureFlagMismatches:
 * Chromium ignores applyConstraints for it), which restarts the whole voice
 * processor — on a machine that is already starved, mid-sentence.
 */

export const NS_LOAD_TICK_MS = 1000;
/** Underrun in one tick that counts as bad (2 % of the tick). */
export const NS_LOAD_BAD_UNDERRUN_MS = 20;
export const NS_LOAD_WINDOW = 10;
export const NS_LOAD_TRIP_BAD = 3;

/** Chromium's AudioContext.playbackStats (seconds / counts, cumulative). */
export interface PlaybackStatsLike {
    underrunDuration: number;
    underrunEvents: number;
    totalDuration: number;
}

export type NsEngineRunning = 'strong' | 'light' | 'off';

export interface NsLoadTick {
    /** Underrun over this tick, ms. */
    underrunMs: number;
    underrunEvents: number;
    /** Audio rendered over this tick, ms (≈ 1000 while healthy). */
    renderedMs: number;
}

export interface NsLoadDecision {
    tick: NsLoadTick | null;
    /** Fall back to Light now (fires once). */
    trip: boolean;
}

/** Read a context's playbackStats, or null where the API is missing. */
export function readPlaybackStats(ctx: unknown): PlaybackStatsLike | null {
    try {
        const p = (ctx as { playbackStats?: Partial<PlaybackStatsLike> } | null)?.playbackStats;
        if (!p || typeof p.underrunDuration !== 'number' || typeof p.underrunEvents !== 'number' || typeof p.totalDuration !== 'number') return null;
        return { underrunDuration: p.underrunDuration, underrunEvents: p.underrunEvents, totalDuration: p.totalDuration };
    } catch {
        return null;
    }
}

export class NsLoadGuard {
    private prev: PlaybackStatsLike | null = null;
    private recent: boolean[] = [];
    private tripped = false;

    get hasTripped(): boolean { return this.tripped; }

    /** The user chose a mode again: forget the trip. */
    reset(): void {
        this.tripped = false;
        this.recent = [];
    }

    observe(stats: PlaybackStatsLike | null, engine: NsEngineRunning): NsLoadDecision {
        if (!stats) return { tick: null, trip: false };
        const prev = this.prev;
        this.prev = stats;
        if (!prev) return { tick: null, trip: false };
        const tick: NsLoadTick = {
            // Counters only grow; a reset (a context the stats were reset on) reads as 0.
            underrunMs: Math.max(0, Math.round((stats.underrunDuration - prev.underrunDuration) * 1000)),
            underrunEvents: Math.max(0, stats.underrunEvents - prev.underrunEvents),
            renderedMs: Math.max(0, Math.round((stats.totalDuration - prev.totalDuration) * 1000)),
        };
        if (engine !== 'strong' || this.tripped) {
            this.recent = [];
            return { tick, trip: false };
        }
        this.recent.push(tick.underrunMs >= NS_LOAD_BAD_UNDERRUN_MS);
        if (this.recent.length > NS_LOAD_WINDOW) this.recent.shift();
        if (this.recent.filter(Boolean).length >= NS_LOAD_TRIP_BAD) {
            this.tripped = true;
            this.recent = [];
            return { tick, trip: true };
        }
        return { tick, trip: false };
    }
}

/** Sums ticks into a reporting window (the call-event telemetry). */
export class UnderrunWindow {
    private ms = 0;
    private events = 0;
    private ticks = 0;
    add(t: NsLoadTick): void { this.ms += t.underrunMs; this.events += t.underrunEvents; this.ticks++; }
    /** Every `windowTicks` ticks: the window's totals when it had any underrun, else null. Resets. */
    take(windowTicks: number): { underrunMs: number; underrunEvents: number; windowS: number } | null {
        if (this.ticks < windowTicks) return null;
        const out = this.ms > 0 || this.events > 0 ? { underrunMs: this.ms, underrunEvents: this.events, windowS: this.ticks } : null;
        this.ms = 0; this.events = 0; this.ticks = 0;
        return out;
    }
}
