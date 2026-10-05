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

/** Design-doc defaults: 30 Hz point batches plus control messages, with
 *  headroom for a second stroke starting mid-batch. */
export const DEFAULT_RATE: RateLimiterOptions = { perSecond: 60, burst: 90 };

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
