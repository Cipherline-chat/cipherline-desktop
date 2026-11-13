/**
 * annotationRate - receiver-side rate limiting per sender.
 *
 * The codec bounds what one packet may contain; this bounds how many a peer
 * may send. A token bucket per (sender): capacity `burst`, refilled at
 * `perSecond`. Over budget -> the packet is DROPPED, never queued: buffering
 * a flood just delays the flood. Independent of the transport so it can be
 * unit-tested with a fake clock.
 */

export interface RateLimiterOptions {
    /** Sustained packets per second per sender. */
    perSecond: number;
    /** Max packets accepted at once after a quiet spell. */
    burst: number;
}

/**
 * Receiver budget per sender. Sized from what ordinary drawing really produces, not from the
 * design doc's idealised "30 Hz batches": before OUTBOUND_MIN_INTERVAL_MS existed (and still, for
 * peers on older builds) every pointermove past MIN_STEP became its own packet, so a fast stroke
 * on a 144-240 Hz display is 144-240 packets/s from one person. The old 60/s, burst 90 dropped
 * those (owner report: `annot_rx_drop reason:rate`, repeat 26 and 45, on a 3-monitor desktop).
 * 400/s sustained covers a 240 Hz pen plus control messages with headroom; burst 600 absorbs a
 * second stroke starting mid-batch and a reconnect's snapshot chunks. It stays a hard cap: a
 * hostile peer is held to 400 cheap decodes/s (each already bounded by the codec: 64 points per
 * append, strokes and points per stroke capped in the store), and over budget is DROPPED, never queued.
 */
export const DEFAULT_RATE: RateLimiterOptions = { perSecond: 400, burst: 600 };

/**
 * Sender side: stroke packets are sent at most this often (a trailing flush carries everything
 * that changed meanwhile). 30 Hz is plenty for a line that is drawn and fades, and it keeps our
 * own traffic far below any receiver's budget whatever the display refresh rate.
 */
export const OUTBOUND_MIN_INTERVAL_MS = 33;

/**
 * Leading + trailing throttle: the first request runs now, requests inside the interval collapse
 * into ONE run when it elapses. The run reads current state itself, so nothing is lost by waiting.
 */
export class LeadingTrailingGate {
    private last = Number.NEGATIVE_INFINITY;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly minIntervalMs: number;
    private readonly run: () => void;
    private readonly clock: () => number;
    constructor(minIntervalMs: number, run: () => void, clock: () => number = Date.now) {
        this.minIntervalMs = minIntervalMs;
        this.run = run;
        this.clock = clock;
    }
    request(): void {
        if (this.timer) return;
        const wait = this.last + this.minIntervalMs - this.clock();
        if (wait <= 0) { this.fire(); return; }
        this.timer = setTimeout(() => { this.timer = null; this.fire(); }, wait);
    }
    private fire(): void { this.last = this.clock(); this.run(); }
    /** Run a pending trailing run now (teardown: nothing may be left unsent). */
    flush(): void { if (this.timer) { this.cancel(); this.fire(); } }
    /** Drop a pending trailing run (the owner is going away or has already synced). */
    cancel(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}

export class PerSenderRateLimiter {
    private buckets = new Map<string, { tokens: number; at: number }>();
    private opts: RateLimiterOptions;
    constructor(opts: RateLimiterOptions = DEFAULT_RATE) { this.opts = opts; }

    /** Returns true if the packet may be processed; false to drop it. */
    allow(sender: string, now: number = Date.now()): boolean {
        let b = this.buckets.get(sender);
        if (!b) { b = { tokens: this.opts.burst, at: now }; this.buckets.set(sender, b); }
        const elapsed = Math.max(0, now - b.at) / 1000;
        b.tokens = Math.min(this.opts.burst, b.tokens + elapsed * this.opts.perSecond);
        b.at = now;
        if (b.tokens < 1) return false;
        b.tokens -= 1;
        return true;
    }

    /** Forget a sender (they left) so the map cannot grow without bound. */
    forget(sender: string) { this.buckets.delete(sender); }
}
