/**
 * Room-level lifecycle of a remote CAMERA, as `rx_video_gap` call events.
 *
 * A viewer's "friend's camera goes grey / disappears and comes back" has several
 * different causes that look the same on screen - the sender unpublished and republished
 * (codec fallback, layering change), the subscription dropped, the sender muted. Without
 * the lifecycle a report cannot tell them apart. One event per gap, written when the
 * camera is back: reason enum + how long it was away. Nothing identifying: the track is
 * the per-call `remote-video-N` placeholder.
 *
 * A gap longer than GAP_MAX_LOG_MS is a deliberate camera-off, not a glitch: not logged.
 * (The tile's own held-frame swap events are logged by hooks/useCameraSwapHold.)
 */
export type GapReason = 'unpublished' | 'unsubscribed' | 'muted';

export const GAP_MAX_LOG_MS = 30_000;

export interface GapEvent { track: string; reason: GapReason; ms: number }

interface Open { reason: GapReason; at: number; track: string }

export class RemoteCameraGapTracker {
    private readonly open = new Map<string, Open>();
    private readonly now: () => number;
    private readonly emit: (e: GapEvent) => void;
    constructor(now: () => number, emit: (e: GapEvent) => void) { this.now = now; this.emit = emit; }

    /** The camera of `who` went away. The FIRST reason of a gap wins (unpublish precedes the unsubscribe it causes). */
    lost(who: string, reason: GapReason, track: string): void {
        if (!this.open.has(who)) this.open.set(who, { reason, at: this.now(), track });
    }

    /** The camera of `who` is back (a track subscribed, or unmuted). */
    back(who: string): void {
        const g = this.open.get(who);
        if (!g) return;
        this.open.delete(who);
        const ms = Math.max(0, Math.round(this.now() - g.at));
        if (ms <= GAP_MAX_LOG_MS) this.emit({ track: g.track, reason: g.reason, ms });
    }

    /** The participant left: whatever was open is not a gap. */
    drop(who: string): void { this.open.delete(who); }

    clear(): void { this.open.clear(); }
}
