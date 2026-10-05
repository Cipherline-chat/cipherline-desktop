/**
 * Scheduling primitives shared by every avatar preload path.
 *
 * Both exist for the same reason: an encrypted avatar is expensive. A cold one
 * costs TWO REST calls (`/attachments/:id/key` + `/attachments/:id/download`)
 * plus a blob download and an AES-256-GCM decrypt, and those two calls land on
 * the API's `default` throttle bucket — 300 requests per 60 s, per user, in a
 * FIXED window whose `blockDuration` defaults to the same 60 s. Burning the
 * budget does not gently slow avatars down; it 429s the whole account off the
 * entire API for the rest of the minute.
 *
 * `preloadAvatars` used to cap concurrency at 6 with a local worker pool, which
 * bounds one CALL but not the process: Home's deck warm, ChatPane's member warm
 * and the background warmer each spun their own six. And concurrency is the
 * wrong knob anyway — six workers at ~250 ms an avatar is ~48 requests/second,
 * which drains a 300/min budget in under seven seconds. So:
 *
 *   - `PrioritySemaphore` makes the 6-cap process-wide, with foreground work
 *     (something is on screen waiting) jumping the queue ahead of background
 *     warming.
 *   - `TokenBucket` paces the part that actually costs requests. It gates only
 *     background loads that MISS both caches, so a returning user whose avatars
 *     are already in IndexedDB warms at full speed for zero requests.
 *
 * Both are plain classes with injectable time so their behaviour is pinned by
 * tests rather than by sleeping in them.
 */

/**
 * A counting semaphore with two priority lanes.
 *
 * Foreground waiters are inserted ahead of every queued background waiter (but
 * behind other foreground waiters, so foreground stays FIFO among itself). A
 * released slot is handed directly to the next waiter rather than decremented
 * and re-incremented, so `activeCount` never dips below the true in-flight
 * count and a waiter can never be starved by a later `acquire` fast-path.
 */
export class PrioritySemaphore {
    private active = 0;
    private readonly waiting: Array<{ background: boolean; resolve: () => void }> = [];
    private readonly max: number;

    constructor(max: number) {
        if (max < 1) throw new Error('PrioritySemaphore: max must be >= 1');
        this.max = max;
    }

    /** In-flight holders. Never exceeds `max`. */
    get activeCount(): number { return this.active; }
    /** Queued acquirers still waiting for a slot. */
    get waitingCount(): number { return this.waiting.length; }

    acquire(background = false): Promise<void> {
        if (this.active < this.max) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            const entry = { background, resolve };
            if (background) {
                this.waiting.push(entry);
                return;
            }
            // Foreground: slot in ahead of the first queued background waiter.
            const firstBackground = this.waiting.findIndex(w => w.background);
            if (firstBackground === -1) this.waiting.push(entry);
            else this.waiting.splice(firstBackground, 0, entry);
        });
    }

    release(): void {
        const next = this.waiting.shift();
        // Hand the slot straight over — `active` is unchanged because the
        // holder count did not drop.
        if (next) { next.resolve(); return; }
        this.active = Math.max(0, this.active - 1);
    }

    /** Run `fn` holding a slot, releasing it even if `fn` throws. */
    async run<T>(background: boolean, fn: () => Promise<T>): Promise<T> {
        await this.acquire(background);
        try { return await fn(); } finally { this.release(); }
    }
}

export interface TokenBucketOptions {
    /** Injectable clock — tests pin it instead of sleeping. */
    now?: () => number;
    /** Injectable delay — tests resolve it immediately. */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * A refilling token bucket: `capacity` tokens available as a burst, then one
 * more every `refillMs`.
 */
export class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly capacity: number;
    private readonly refillMs: number;

    constructor(
        capacity: number,
        refillMs: number,
        opts: TokenBucketOptions = {},
    ) {
        if (capacity < 1) throw new Error('TokenBucket: capacity must be >= 1');
        if (refillMs < 1) throw new Error('TokenBucket: refillMs must be >= 1');
        this.capacity = capacity;
        this.refillMs = refillMs;
        this.now = opts.now ?? (() => Date.now());
        this.sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
        this.tokens = capacity;
        this.lastRefill = this.now();
    }

    /** Tokens available right now, after accounting for elapsed refills. */
    get available(): number { this.refill(); return this.tokens; }

    private refill(): void {
        const t = this.now();
        const elapsed = t - this.lastRefill;
        if (elapsed < this.refillMs) return;
        const gained = Math.floor(elapsed / this.refillMs);
        const next = Math.min(this.capacity, this.tokens + gained);
        // When the bucket saturates, snap the clock to NOW rather than
        // advancing it by `gained * refillMs`. The two differ by
        // `elapsed % refillMs`, which is carried forward as credit the caller
        // did not wait for: drain a bucket that just saturated and the next
        // token arrives up to one interval early. Bounded (the lag can never
        // exceed refillMs, so it does not accumulate into a second burst) but
        // still time the pacing was supposed to charge for.
        this.lastRefill = next === this.capacity ? t : this.lastRefill + gained * this.refillMs;
        this.tokens = next;
    }

    /** Take a token if one is free. Never waits. */
    tryTake(): boolean {
        this.refill();
        if (this.tokens <= 0) return false;
        this.tokens--;
        return true;
    }

    /** Take a token, waiting for the next refill if the bucket is empty. */
    async take(): Promise<void> {
        for (;;) {
            if (this.tryTake()) return;
            const waitMs = Math.max(1, this.refillMs - (this.now() - this.lastRefill));
            await this.sleep(waitMs);
        }
    }
}
