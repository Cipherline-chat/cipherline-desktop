/**
 * Flow control for channel Sender-Key distribution (POST /key-handshake).
 *
 * The 2026-10-09 storm: a few clients re-POSTed key-handshake at ~55–65 req/s
 * per account, ignoring 429s, and pinned the API autoscaler at max. Root
 * causes on this side, each answered by one piece below:
 *
 *  • distributeChannelKeys swallowed every POST failure (429 included) and
 *    kept looping epochs × recipients × chunks with a fixed 100 ms sleep —
 *    a 429 cost nothing and slowed nothing.
 *      → HandshakeBackoff + DistributionDeferred: a 429 (or a 5xx/network
 *        failure) STOPS the pass; the next attempt waits out Retry-After (when
 *        the server exposes it) or an exponential, jittered back-off.
 *  • Several loops ran at once per account — the connect sweep, one jittered
 *    serve per `server:key_requested`, member_joined, rotations — each with
 *    its own 100 ms pacing, so their rates added up.
 *      → Pacer: ONE account-wide minimum interval between POST starts,
 *        shared by every caller, sized just under the server's
 *        `keyHandshake` bucket (30 / 10 s).
 *      → SingleFlight (serve passes, per server) and KeyedMutex (any
 *        distribution, per server+channel): no two loops ever walk the same
 *        server's requests or the same channel's recipients concurrently.
 *  • serveKeyRequests re-sent EVERY held epoch for EVERY open request on
 *    every sweep / push / reconnect, and a request whose newest epoch nobody
 *    holds never closes — so the same epochs went to the same devices
 *    forever.
 *      → DeliveryLedger: an epoch delivered to a device is not re-sent for the
 *        same request version (request_id + its created_at, which the server
 *        bumps whenever the device asks again), nor within a cool-down even
 *        if the device re-asks — that re-ask loop is the storm.
 *      → a per-pass submission cap, so one pass is bounded and the rest
 *        continues in a later pass rather than in one unbounded burst.
 *
 * Everything is injectable (clock, randomness, sleep, network, IPC) so the
 * behaviour is unit-tested without React, Electron or a live API. Nothing
 * here touches key material beyond handing it from `getChannelKey` to `wrap`
 * — the crypto is the caller's, unchanged.
 */

import { chunkEnvelopes } from './channelKeyDistribution';

/** Account-wide minimum spacing between key-handshake POST starts. 350 ms ≈
 *  2.9/s, just under the API's `keyHandshake` bucket (30 per 10 s), so a
 *  well-behaved client never trips it by itself. */
export const KEY_HANDSHAKE_MIN_INTERVAL_MS = 350;

/** Max key-handshake POSTs one serve pass may make before yielding and
 *  continuing in a later pass. */
export const SERVE_PASS_SUBMISSION_CAP = 40;

/** Delay before a pass that hit its submission cap continues. */
export const PASS_CONTINUATION_DELAY_MS = 5_000;

/** An epoch delivered to a device is not re-sent to it within this window,
 *  even for a re-filed request. Matches the recipient's own give-up cool-off
 *  (CHANNEL_KEY_COOL_OFF_MS): a device that genuinely failed to install a key
 *  only re-asks after that window anyway. */
export const REDELIVERY_COOLDOWN_MS = 10 * 60 * 1000;

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;

/** Upper bound on automatic resumptions of a one-shot distribution
 *  (bootstrap / rotation / member_join / recovery) after deferrals. The
 *  protocol's key-request path covers anything still missing after that. */
export const MAX_DISTRIBUTION_RESUMES = 8;

export type DeferReason = 'throttled' | 'unavailable' | 'budget';

export type DistributionOutcome =
    | { status: 'done'; posted: number }
    | { status: 'deferred'; reason: DeferReason; retryInMs: number; posted: number };

// ── Errors / Retry-After ────────────────────────────────────────────────────

interface HttpErrorLike {
    response?: { status?: number; headers?: Record<string, unknown> };
}

/**
 * How a key-handshake POST failure should be treated:
 *  • 'throttled' — 429: stop the pass, honour Retry-After / back off.
 *  • 'refused'   — a definitive 4xx (403 no access / historical epoch
 *                  without READ_MESSAGE_HISTORY, 400, 404): retrying the same
 *                  envelope can only fail the same way. Not retried for this
 *                  request version / cool-down; the pass continues.
 *  • 'transient' — 5xx, or no response at all (network): the server is
 *                  struggling or unreachable; stop the pass and back off
 *                  rather than keep hammering it.
 */
export function classifyHandshakeError(e: unknown): 'throttled' | 'refused' | 'transient' {
    const status = (e as HttpErrorLike)?.response?.status;
    if (status === 429) return 'throttled';
    if (typeof status === 'number' && status >= 400 && status < 500) return 'refused';
    return 'transient';
}

/**
 * Milliseconds the server asked us to wait, from `Retry-After` (or the
 * throttler's per-bucket `Retry-After-<name>`), in seconds or as an HTTP date.
 * Undefined when absent or unreadable — the response header is only visible
 * cross-origin because the API lists it in CORS `exposedHeaders`; an older
 * API build simply leaves us on the exponential back-off.
 */
export function parseRetryAfterMs(e: unknown, nowMs: number = Date.now()): number | undefined {
    const headers = (e as HttpErrorLike)?.response?.headers;
    if (!headers || typeof headers !== 'object') return undefined;
    let best: number | undefined;
    for (const [rawName, rawValue] of Object.entries(headers)) {
        if (!/^retry-after(-|$)/i.test(rawName)) continue;
        const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
        if (value == null) continue;
        const str = String(value).trim();
        let ms: number | undefined;
        if (/^\d+(\.\d+)?$/.test(str)) ms = Math.ceil(Number(str) * 1000);
        else {
            const at = Date.parse(str);
            if (!Number.isNaN(at)) ms = Math.max(0, at - nowMs);
        }
        if (ms !== undefined && (best === undefined || ms > best)) best = ms;
    }
    return best;
}

// ── Back-off ────────────────────────────────────────────────────────────────

/**
 * Shared, account-wide back-off for key-handshake POSTs. One instance per
 * signed-in session: a 429 on ANY distribution path pauses ALL of them, since
 * the server's bucket is per user, not per loop.
 */
export class HandshakeBackoff {
    private blockedUntil = 0;
    private failures = 0;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly baseMs: number;
    private readonly maxMs: number;

    constructor(opts: { now?: () => number; random?: () => number; baseMs?: number; maxMs?: number } = {}) {
        this.now = opts.now ?? Date.now;
        this.random = opts.random ?? Math.random;
        this.baseMs = opts.baseMs ?? BACKOFF_BASE_MS;
        this.maxMs = opts.maxMs ?? BACKOFF_MAX_MS;
    }

    remainingMs(): number {
        return Math.max(0, this.blockedUntil - this.now());
    }

    isBlocked(): boolean {
        return this.remainingMs() > 0;
    }

    /** Consecutive failures since the last success (for diagnostics/tests). */
    get consecutiveFailures(): number {
        return this.failures;
    }

    /**
     * Record a throttle / transient failure and return how long to wait.
     * The wait is max(Retry-After, exponential) plus up to +50 % jitter (so
     * several devices of one account, or several accounts released by the
     * same window, do not resume in lock-step), capped at maxMs.
     */
    onFailure(retryAfterMs?: number): number {
        this.failures += 1;
        const exp = Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - 1));
        const floor = Math.min(this.maxMs, Math.max(retryAfterMs ?? 0, exp));
        const jitter = Math.floor(this.random() * floor * 0.5);
        const wait = Math.min(this.maxMs, floor + jitter);
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + wait);
        return this.remainingMs();
    }

    onSuccess(): void {
        this.failures = 0;
    }
}

// ── Pacing ──────────────────────────────────────────────────────────────────

/** Serialises POST starts account-wide to at most one per `intervalMs`,
 *  however many loops are calling `wait()` concurrently. */
export class Pacer {
    private nextAt = 0;
    private readonly intervalMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(opts: { intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
        this.intervalMs = opts.intervalMs ?? KEY_HANDSHAKE_MIN_INTERVAL_MS;
        this.now = opts.now ?? Date.now;
        this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    }

    async wait(): Promise<void> {
        const now = this.now();
        // Reserve a slot synchronously, so concurrent callers queue up
        // behind each other instead of all seeing the same `nextAt`.
        const at = Math.max(now, this.nextAt);
        this.nextAt = at + this.intervalMs;
        if (at > now) await this.sleep(at - now);
    }
}

// ── Delivery ledger ─────────────────────────────────────────────────────────

/** The version of a pending key request: the server bumps `created_at` each
 *  time the device asks again, so a new value means a genuinely new ask. */
export function keyRequestVersion(req: { request_id: string; created_at: string | Date }): string {
    const at = req.created_at instanceof Date ? req.created_at.toISOString() : String(req.created_at);
    return `${req.request_id}@${at}`;
}

interface LedgerEntry { at: number; version?: string }

/**
 * What this device has already handed to whom: (channel, epoch, recipient
 * device) → when, and for which request version. In-memory, per session —
 * a restart forgets it, which costs at most one redundant re-serve (and the
 * server's own idempotency suppresses even that write).
 */
export class DeliveryLedger {
    private readonly map = new Map<string, LedgerEntry>();
    private readonly now: () => number;
    private readonly cooldownMs: number;
    private static readonly MAX_ENTRIES = 20_000;
    private static readonly VERSION_TTL_MS = 24 * 60 * 60 * 1000;

    constructor(opts: { now?: () => number; cooldownMs?: number } = {}) {
        this.now = opts.now ?? Date.now;
        this.cooldownMs = opts.cooldownMs ?? REDELIVERY_COOLDOWN_MS;
    }

    private static key(channelId: string, epoch: number, deviceId: string): string {
        return `${channelId}:${epoch}:${deviceId}`;
    }

    record(channelId: string, epoch: number, deviceId: string, version?: string): void {
        if (this.map.size >= DeliveryLedger.MAX_ENTRIES) this.prune();
        this.map.set(DeliveryLedger.key(channelId, epoch, deviceId), { at: this.now(), version });
    }

    /**
     * Skip when this exact request version was already answered with this
     * epoch for this device, or when we delivered it within the cool-down —
     * a re-filed request inside that window is the storm's loop, not a new
     * need. After the cool-down a re-ask is served again.
     */
    shouldSkip(channelId: string, epoch: number, deviceId: string, version?: string): boolean {
        const e = this.map.get(DeliveryLedger.key(channelId, epoch, deviceId));
        if (!e) return false;
        if (version !== undefined && e.version === version) return true;
        return this.now() - e.at < this.cooldownMs;
    }

    /** True iff every one of `epochs` would be skipped for this device. */
    allDelivered(channelId: string, epochs: number[], deviceId: string, version?: string): boolean {
        return epochs.length > 0 && epochs.every(ep => this.shouldSkip(channelId, ep, deviceId, version));
    }

    get size(): number {
        return this.map.size;
    }

    prune(): void {
        const now = this.now();
        for (const [k, e] of this.map) {
            const ttl = e.version ? DeliveryLedger.VERSION_TTL_MS : this.cooldownMs;
            if (now - e.at >= ttl) this.map.delete(k);
        }
    }
}

// ── Concurrency ─────────────────────────────────────────────────────────────

/**
 * At most one run per key. A call while a run is in flight does not start a
 * second, concurrent loop — it asks for exactly ONE trailing re-run once the
 * current one finishes (so a trigger that lands mid-pass is not lost), and
 * every caller awaits the same promise.
 */
export class SingleFlight {
    private readonly running = new Map<string, Promise<void>>();
    private readonly rerun = new Set<string>();

    isRunning(key: string): boolean {
        return this.running.has(key);
    }

    run(key: string, fn: () => Promise<void>): Promise<void> {
        const inFlight = this.running.get(key);
        if (inFlight) {
            this.rerun.add(key);
            return inFlight;
        }
        const p = (async () => {
            try {
                do {
                    this.rerun.delete(key);
                    try { await fn(); } catch { /* the pass reports its own errors */ }
                } while (this.rerun.has(key));
            } finally {
                this.running.delete(key);
                this.rerun.delete(key);
            }
        })();
        this.running.set(key, p);
        return p;
    }
}

/** Serialises async work per key (FIFO); different keys run in parallel. */
export class KeyedMutex {
    private readonly tails = new Map<string, Promise<void>>();

    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const tail = prev.then(() => gate);
        this.tails.set(key, tail);
        await prev;
        try {
            return await fn();
        } finally {
            release();
            if (this.tails.get(key) === tail) this.tails.delete(key);
        }
    }
}

/** One pending timer per key; a second schedule for a key that already has
 *  one rides it (the earlier timer will re-check everything anyway). */
export class ResumeTimers {
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

    schedule(key: string, delayMs: number, fn: () => void): void {
        if (this.timers.has(key)) return;
        const t = setTimeout(() => {
            this.timers.delete(key);
            fn();
        }, Math.max(0, delayMs));
        this.timers.set(key, t);
    }

    has(key: string): boolean {
        return this.timers.has(key);
    }

    clearAll(): void {
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
    }
}

// ── The distribution loop ───────────────────────────────────────────────────

export interface DistributionRecipient {
    user_id: string;
    device_id: string;
    spk_pub_b64: string;
    sig_b64: string;
    identity_pub_b64: string;
}

export interface KeyDistributionDeps {
    backoff: HandshakeBackoff;
    pacer: Pacer;
    ledger: DeliveryLedger;
    mutex: KeyedMutex;
    /** The locally held key for (channel, epoch), or null if pruned. */
    getChannelKey: (channelId: string, epoch: number) => Promise<string | null>;
    /** Wrap the key for ONE device (the caller's existing E2EE path). */
    wrap: (args: { channelId: string; epoch: number; keyB64: string; device: Omit<DistributionRecipient, 'user_id'> }) => Promise<string>;
    /** POST /servers/:sid/key-handshake. Throws an axios-shaped error on failure. */
    post: (serverId: string, body: { recipient_user_id: string; channel_id: string; epoch: number; envelopes: { device_id: string; ciphertext_b64: string }[] }) => Promise<unknown>;
    onWrapError?: (e: unknown, ctx: { epoch: number; recipientUserId: string; deviceId: string }) => void;
    onNothingWrapped?: (ctx: { epoch: number; recipientUserId: string; devices: number }) => void;
    onPostError?: (e: unknown, ctx: { epoch: number; recipientUserId: string; envelopes: number }) => void;
}

export interface KeyDistributionArgs {
    serverId: string;
    channelId: string;
    epochs: number[];
    recipients: DistributionRecipient[];
    /** Set when answering a key request — see DeliveryLedger. */
    requestVersion?: string;
    /** Shared, mutable per-pass POST budget (serve passes only). */
    budget?: { remaining: number };
}

/**
 * Wrap and POST the given epochs to the given recipient devices, skipping
 * anything already delivered (DeliveryLedger), pacing every POST through the
 * shared Pacer, and STOPPING — returning 'deferred' with a retry delay — on a
 * 429, a transient failure, an active back-off, or an exhausted pass budget.
 * Serialised per (server, channel) so two callers never interleave the same
 * channel's fan-out.
 */
export async function runKeyDistribution(
    deps: KeyDistributionDeps,
    args: KeyDistributionArgs,
): Promise<DistributionOutcome> {
    const { serverId, channelId, epochs, recipients, requestVersion, budget } = args;
    if (!epochs.length || !recipients.length) return { status: 'done', posted: 0 };

    return deps.mutex.run(`${serverId}:${channelId}`, async (): Promise<DistributionOutcome> => {
        let posted = 0;
        const deferred = (reason: DeferReason, retryInMs: number): DistributionOutcome =>
            ({ status: 'deferred', reason, retryInMs, posted });
        const stopIfBlocked = (): DistributionOutcome | null => {
            if (deps.backoff.isBlocked()) return deferred('throttled', deps.backoff.remainingMs());
            if (budget && budget.remaining <= 0) return deferred('budget', PASS_CONTINUATION_DELAY_MS);
            return null;
        };

        const byUser = new Map<string, Omit<DistributionRecipient, 'user_id'>[]>();
        for (const r of recipients) {
            const list = byUser.get(r.user_id) ?? [];
            list.push({ device_id: r.device_id, spk_pub_b64: r.spk_pub_b64, sig_b64: r.sig_b64, identity_pub_b64: r.identity_pub_b64 });
            byUser.set(r.user_id, list);
        }

        for (const epoch of epochs) {
            // Who still needs THIS epoch — decided before any IPC.
            const pending: [string, Omit<DistributionRecipient, 'user_id'>[]][] = [];
            for (const [uid, devices] of byUser) {
                const need = devices.filter(d => !deps.ledger.shouldSkip(channelId, epoch, d.device_id, requestVersion));
                if (need.length) pending.push([uid, need]);
            }
            if (!pending.length) continue;

            const stop = stopIfBlocked();
            if (stop) return stop;

            const keyB64 = await deps.getChannelKey(channelId, epoch);
            if (!keyB64) continue; // pruned locally — another holder may still cover it

            for (const [recipientUserId, devices] of pending) {
                const early = stopIfBlocked();
                if (early) return early;

                const envelopes: { device_id: string; ciphertext_b64: string }[] = [];
                for (const device of devices) {
                    try {
                        envelopes.push({ device_id: device.device_id, ciphertext_b64: await deps.wrap({ channelId, epoch, keyB64, device }) });
                    } catch (e) {
                        deps.onWrapError?.(e, { epoch, recipientUserId, deviceId: device.device_id });
                    }
                }
                if (devices.length && !envelopes.length) {
                    deps.onNothingWrapped?.({ epoch, recipientUserId, devices: devices.length });
                }

                for (const chunk of chunkEnvelopes(envelopes)) {
                    const blocked = stopIfBlocked();
                    if (blocked) return blocked;
                    await deps.pacer.wait();
                    // Re-check: another loop may have hit a 429 while we waited.
                    const blockedAfterWait = stopIfBlocked();
                    if (blockedAfterWait) return blockedAfterWait;
                    if (budget) budget.remaining -= 1;
                    try {
                        await deps.post(serverId, { recipient_user_id: recipientUserId, channel_id: channelId, epoch, envelopes: chunk });
                        posted += 1;
                        deps.backoff.onSuccess();
                        for (const env of chunk) deps.ledger.record(channelId, epoch, env.device_id, requestVersion);
                    } catch (e) {
                        deps.onPostError?.(e, { epoch, recipientUserId, envelopes: chunk.length });
                        const kind = classifyHandshakeError(e);
                        if (kind === 'refused') {
                            // Same answer next time; don't re-send it for
                            // this ask / cool-down. The pass goes on.
                            for (const env of chunk) deps.ledger.record(channelId, epoch, env.device_id, requestVersion);
                            continue;
                        }
                        const retryInMs = deps.backoff.onFailure(kind === 'throttled' ? parseRetryAfterMs(e) : undefined);
                        return deferred(kind === 'throttled' ? 'throttled' : 'unavailable', retryInMs);
                    }
                }
            }
        }
        return { status: 'done', posted };
    });
}
