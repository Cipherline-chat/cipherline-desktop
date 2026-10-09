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
 *        shared by every caller (≈2.9 POSTs/s, well inside the API's
 *        per-user `default` bucket).
 *      → SingleFlight (serve passes, per server) and KeyedMutex (any
 *        distribution, per server+channel): no two loops ever walk the same
 *        server's requests or the same channel's recipients concurrently.
 *  • serveKeyRequests re-sent EVERY held epoch for EVERY open request on
 *    every sweep / push / reconnect, and a request whose newest epoch nobody
 *    holds never closes — so the same epochs went to the same devices
 *    forever.
 *      → DeliveryLedger: an epoch delivered to a device is not re-sent for the
 *        same request version (request_id + its created_at, which the server
 *        bumps whenever the device asks again). A NEW version — the device
 *        asked again after our delivery — is ALWAYS served, at once. A
 *        delivery is never treated as "received": the only proof is that the
 *        device stops asking. Its re-ask is the protocol's one signal that
 *        what it got did not work (undecryptable — wrapped to a bundle it no
 *        longer has — purged, refused), and skipping it is exactly how calls
 *        broke on 2026-10-09: participants re-asked for the epoch their call
 *        key derives from, kept being told "already sent", and ended up on
 *        different epochs.
 *
 *        (1.0.20 skipped ANY re-ask for 10 minutes after a delivery and marked
 *        it answered — the same failure mode, client side.) What bounds the
 *        cost of a device that keeps re-asking is its own cadence (60 s
 *        per-channel dedup, the API's key-request throttle) and the Pacer /
 *        back-off below — not a refusal to answer.
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
 *  2.9/s (≈171/min). The route shares the API's per-user `default` bucket
 *  (300/min), so a distribution burst leaves headroom for everything else
 *  the user is doing; a 429 still stops the pass (HandshakeBackoff). */
export const KEY_HANDSHAKE_MIN_INTERVAL_MS = 350;

/** Max key-handshake POSTs one serve pass may make before yielding and
 *  continuing in a later pass. */
export const SERVE_PASS_SUBMISSION_CAP = 40;

/** Delay before a pass that hit its submission cap continues. The Pacer is
 *  what bounds the POST rate; this only yields so the continuation re-lists
 *  the pending requests (dropping any another holder answered meanwhile).
 *  Was 5 s, which added 5 s of dead air to every join burst > 40 POSTs. */
export const PASS_CONTINUATION_DELAY_MS = 1_000;

/** ONE-SHOT distributions (member_join / create / rotation / recovery) carry
 *  no request version, so nothing tells a repeat apart from a duplicate
 *  trigger: an epoch already handed to a device by one of them is not handed
 *  to it again by ANOTHER ONE-SHOT within this window. It never applies to a
 *  key request — a device that needs the key again asks, and an ask is always
 *  answered (see DeliveryLedger.decide). */
export const REDELIVERY_COOLDOWN_MS = 10 * 60 * 1000;

/** Consecutive HTTP 500s for the same POST after which it is treated like a
 *  definitive refusal (skipped for this ask) so one deterministically failing
 *  submission cannot hold every other recipient behind a growing back-off.
 *  502/503/504 (a rollout, an overloaded ingress) never count. */
export const SERVER_ERROR_GIVE_UP = 3;

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

/** What the ledger says about handing (channel, epoch) to a device now. */
export type LedgerDecision =
    | { action: 'send' }
    /** Already delivered for this exact ask (or, for a one-shot, recently). */
    | { action: 'skip' };

/**
 * What this device has already handed to whom: (channel, epoch, recipient
 * device) → when, and for which request version. In-memory, per session — a
 * restart forgets it, which costs at most one redundant re-serve.
 *
 * It only ever suppresses a REPEAT of the same thing: the same ask answered
 * again, or a one-shot repeated by another one-shot. It never suppresses an
 * answer to a new ask (see decide).
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
     * • Nothing delivered yet → send.
     * • One-shot (no version) → skip within the one-shot cool-down.
     * • This exact request version already answered → skip (the storm's
     *   same-ask re-serve on every sweep / push / reconnect).
     * • A different version that this device first SAW at or before our
     *   delivery (`askSeenAt <= delivered at`) → skip: our delivery came AFTER
     *   that ask, so it is the answer to it (the join race — the joiner's
     *   requests land while member_join is still posting the same epochs). If
     *   that answer did not work, the device asks again, and that new version
     *   is first seen after our delivery.
     * • Otherwise — the device asked again after our delivery → SEND, now.
     */
    decide(channelId: string, epoch: number, deviceId: string, version?: string, askSeenAt?: number): LedgerDecision {
        const e = this.map.get(DeliveryLedger.key(channelId, epoch, deviceId));
        if (!e) return { action: 'send' };
        if (version === undefined) {
            return this.now() - e.at < this.cooldownMs ? { action: 'skip' } : { action: 'send' };
        }
        if (e.version === version) return { action: 'skip' };
        if (askSeenAt !== undefined && askSeenAt <= e.at) return { action: 'skip' };
        return { action: 'send' };
    }

    shouldSkip(channelId: string, epoch: number, deviceId: string, version?: string, askSeenAt?: number): boolean {
        return this.decide(channelId, epoch, deviceId, version, askSeenAt).action === 'skip';
    }

    /** True iff every one of `epochs` was already answered for this ask. */
    allDelivered(channelId: string, epochs: number[], deviceId: string, version?: string, askSeenAt?: number): boolean {
        return epochs.length > 0 && epochs.every(ep => this.shouldSkip(channelId, ep, deviceId, version, askSeenAt));
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

    /** A trigger arrived while this run was in flight: a trailing re-run is
     *  already queued. A long run can use this to YIELD early (it re-runs at
     *  once) — e.g. a serve pass stops sending history so the new asks'
     *  newest epochs go out first. */
    hasPendingRerun(key: string): boolean {
        return this.rerun.has(key);
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

/** One pending timer per key. A second schedule for a key that already has
 *  one keeps whichever fires EARLIER: every resume re-checks everything, so
 *  the earliest is enough — but riding a LATER one (1.0.20) let a 5-minute
 *  back-off resume swallow a 1-second continuation scheduled after it. */
export class ResumeTimers {
    private readonly timers = new Map<string, { t: ReturnType<typeof setTimeout>; at: number }>();
    private readonly now: () => number;

    constructor(opts: { now?: () => number } = {}) {
        this.now = opts.now ?? Date.now;
    }

    schedule(key: string, delayMs: number, fn: () => void): void {
        const at = this.now() + Math.max(0, delayMs);
        const existing = this.timers.get(key);
        if (existing && existing.at <= at) return;
        if (existing) clearTimeout(existing.t);
        const t = setTimeout(() => {
            this.timers.delete(key);
            fn();
        }, Math.max(0, delayMs));
        this.timers.set(key, { t, at });
    }

    has(key: string): boolean {
        return this.timers.has(key);
    }

    clearAll(): void {
        for (const { t } of this.timers.values()) clearTimeout(t);
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
    /** When this device first saw that request version (see DeliveryLedger.decide). */
    requestSeenAt?: number;
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
    const { serverId, channelId, epochs, recipients, requestVersion, requestSeenAt, budget } = args;
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
                const need = devices.filter(d => !deps.ledger.shouldSkip(channelId, epoch, d.device_id, requestVersion, requestSeenAt));
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
                    const failKey = `${channelId}:${epoch}:${chunk.map(env => env.device_id).join(',')}`;
                    try {
                        await deps.post(serverId, { recipient_user_id: recipientUserId, channel_id: channelId, epoch, envelopes: chunk });
                        posted += 1;
                        deps.backoff.onSuccess();
                        serverErrorCounts.delete(failKey);
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
                        if ((e as HttpErrorLike)?.response?.status === 500) {
                            const n = (serverErrorCounts.get(failKey) ?? 0) + 1;
                            if (n >= SERVER_ERROR_GIVE_UP) {
                                // Deterministic for THIS submission: stop it
                                // holding every other recipient behind a
                                // growing back-off. Recorded like a refusal,
                                // so a re-ask still gets it re-tried.
                                serverErrorCounts.delete(failKey);
                                for (const env of chunk) deps.ledger.record(channelId, epoch, env.device_id, requestVersion);
                                continue;
                            }
                            serverErrorCounts.set(failKey, n);
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

/** Consecutive HTTP-500 counts per (channel, epoch, device set). Module-wide:
 *  one renderer is one signed-in session, and entries are removed on success
 *  or on give-up, so it stays tiny. */
const serverErrorCounts = new Map<string, number>();

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Order a set of per-channel distributions so every channel's NEWEST epoch
 * goes out before ANY channel's history: [latest of #1, latest of #2, …,
 * then #1's older epochs newest-first, #2's, …].
 *
 * The newest epoch is what makes a channel usable — it is the key to send
 * with and to read everything from now on. Walking channel by channel and
 * sending each one's whole history first (1.0.20) left the LAST channel of a
 * 20-channel server unusable until ~60 POSTs (~21 s at the pacer's rate) had
 * gone out for the others' history. The Pacer, ledger and cap are untouched:
 * this only changes the ORDER, never the volume.
 */
export function latestFirstPhases<T extends { epochs: number[] }>(items: T[]): { item: T; epochs: number[] }[] {
    const latest: { item: T; epochs: number[] }[] = [];
    const history: { item: T; epochs: number[] }[] = [];
    for (const item of items) {
        const sorted = [...new Set(item.epochs)].sort((a, b) => b - a);
        if (!sorted.length) continue;
        latest.push({ item, epochs: [sorted[0]] });
        if (sorted.length > 1) history.push({ item, epochs: sorted.slice(1) });
    }
    return [...latest, ...history];
}

// ── Finishing what a stopped serve pass started ─────────────────────────────

/** How long a holder keeps owing the rest of a request it started serving. */
export const OWED_SERVE_TTL_MS = 15 * 60 * 1000;

export interface ServeRequestLike {
    channel_id: string;
    requester_device_id: string;
}

export interface OwedServe<R extends ServeRequestLike> {
    req: R;
    version: string;
    seenAt: number;
    epochs: number[];
    until: number;
}

/**
 * A serve pass stopped part-way (429, transient failure, its POST budget):
 * remember what it still owed, per request version.
 *
 * Needed because of latest-first: the API closes a key request as soon as
 * the requesting device ACKs the channel's NEWEST epoch, which is now the
 * first thing sent. A pass that stops after the newest epochs but before
 * the history therefore finds those requests GONE when it resumes and
 * re-lists the pending set — and the history would never go out from this
 * holder (the device, no longer gated, has no timer that asks again).
 */
export function recordOwed<R extends ServeRequestLike>(
    owed: Map<string, OwedServe<R>>,
    remaining: { item: { req: R; version: string; seenAt: number }; epochs: number[] }[],
    now: number,
): void {
    for (const { item, epochs } of remaining) {
        const prev = owed.get(item.version);
        owed.set(item.version, {
            req: item.req,
            version: item.version,
            seenAt: item.seenAt,
            epochs: [...new Set([...(prev?.epochs ?? []), ...epochs])].sort((a, b) => b - a),
            until: now + OWED_SERVE_TTL_MS,
        });
    }
}

/**
 * The owed entries a new pass should serve alongside what it just listed:
 * not answered, not expired, and not superseded by a LISTED request for the
 * same (channel, device) — a listed request is the server's current view
 * and so is always the better source. Expired,
 * answered and superseded entries are removed from `owed`.
 */
export function takeOwed<R extends ServeRequestLike>(
    owed: Map<string, OwedServe<R>>,
    listed: { req: R; version: string }[],
    answered: Set<string>,
    now: number,
): { req: R; version: string; seenAt: number; epochs: number[] }[] {
    const listedVersions = new Set(listed.map(l => l.version));
    const listedTargets = new Set(listed.map(l => `${l.req.channel_id}:${l.req.requester_device_id}`));
    const out: { req: R; version: string; seenAt: number; epochs: number[] }[] = [];
    for (const [version, o] of owed) {
        if (answered.has(version) || now > o.until || listedVersions.has(version)
            || listedTargets.has(`${o.req.channel_id}:${o.req.requester_device_id}`)) {
            owed.delete(version);
            continue;
        }
        out.push({ req: o.req, version, seenAt: o.seenAt, epochs: o.epochs });
    }
    return out;
}
