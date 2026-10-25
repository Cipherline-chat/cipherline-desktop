/**
 * Proactive channel-key acquisition: the REQUESTER side, for every channel the
 * member can see, whether or not it has ever been opened.
 *
 * Before this module a device filed its key requests from inside
 * requestMissingChannelKeys with a fixed 150 ms gap between POSTs (400/min)
 * against an API bucket of 60/min, ignored the 429 it got back (and stamped the
 * channel "asked" anyway, so the 60 s dedup then suppressed the retry), and
 * only ever re-evaluated stale-epoch channels on a connect / permission /
 * channel-list event. A member of several servers therefore ended a join or a
 * new-device sweep with the head of the list keyed and the TAIL silently never
 * asked for; the tail stayed keyless until the channel was OPENED, which re-asks
 * and then waits for a holder round trip: "keys don't load until I go into the
 * chat, and then I have to wait".
 *
 * Three pure/injectable pieces, all unit-tested without React or Electron:
 *
 *  • planKeyPrefetch  — which channels of a server need a request RIGHT NOW,
 *    given what the API says exists (the VIEW-filtered channel list with each
 *    channel's newest epoch), what this device holds, and what it already asked.
 *  • KeyAskLimiter    — one account-wide view of the key-request bucket: a
 *    sliding 60 s window over EVERY path that POSTs a request, plus a 429
 *    back-off (the existing HandshakeBackoff, Retry-After honoured).
 *  • KeyAskQueue      — a single background worker that sends planned asks
 *    paced under the limiter, in priority order (a forced re-ask jumps the
 *    queue), and puts a throttled ask BACK instead of dropping it.
 *
 * Anti-storm properties kept (2026-10-07 / 10-09 / 10-14 incidents):
 *  • an ask is only ever planned for a channel the device does not hold the
 *    newest epoch of; a held-newest channel is forgotten;
 *  • an unchanged ask for the same newest epoch is not repeated inside the
 *    60 s dedup, and a stale-epoch channel is re-asked by the periodic tick on
 *    the same exponential back-off the history-gap path uses (5 min → 2 h);
 *    the connect / permission / channel-list triggers keep the 60 s dedup they
 *    always had;
 *  • a genuine re-ask (a key envelope that would not install) is `forced`: it
 *    jumps the queue and may use the bucket's last headroom, but it still
 *    waits out a 429;
 *  • an ask names what it is missing (2026-10-19): a stale channel asks for
 *    the epochs above the newest it holds, the repair sweep for its gap; only
 *    a keyless channel asks for "everything". Holders send just those, and an
 *    API that understands it keeps the request open until each is acked —
 *    an unanswerable gap no longer costs every online holder a full re-send
 *    of epochs the device already has, on every re-ask;
 *  • nothing is asked for a channel the member cannot hold a key for (no
 *    VIEW_CHANNEL, or no CONNECT on a Calls channel) or one that has never been
 *    minted (latest_epoch 0: a request would be unanswerable — the mint path
 *    owns that case).
 */

import { Permissions } from '@cipherline/shared';
import { channelCarriesSenderKeys, gapReaskDelayMs, isCallsChannelKind } from './channelKeyDistribution';
import { HandshakeBackoff, classifyHandshakeError, parseRetryAfterMs } from './keyDistributionThrottle';

// ── Constants ───────────────────────────────────────────────────────────────

/** The API's budget for POST …/key-request (a fixed window per user). Mirrors
 *  `@Throttle({ default: { limit: 60, ttl: 60000 } })` on createKeyRequest;
 *  the bucket is per USER, so a second device of the account spends from it too. */
export const KEY_REQUEST_API_LIMIT_PER_MIN = 60;
/** Background (planned) asks stop at this many in any 60 s window… */
export const KEY_ASK_SOFT_CEILING = 50;
/** …and even a forced / interactive ask stops at this, leaving the last few
 *  slots to the other device(s) of the account. */
export const KEY_ASK_HARD_CEILING = 58;
export const KEY_ASK_WINDOW_MS = 60_000;
/** Minimum spacing between two key-request POST starts (an ask burst is
 *  smooth, not simultaneous). */
export const KEY_ASK_MIN_GAP_MS = 150;
/** Cadence of the all-servers background re-evaluation (see Dashboard). */
export const PREFETCH_TICK_MS = 5 * 60_000;
/** A channel asked about inside this window is not asked again by an event
 *  trigger (the dedup that has always been there). */
export const PREFETCH_REASK_DEDUP_MS = 60_000;
/** A newer newest-epoch than the one last asked about is asked at once — but
 *  not twice inside this gap. */
export const PREFETCH_NEWER_EPOCH_MIN_GAP_MS = 10_000;
/** A planned ask whose channel was asked about by ANOTHER path (opening it, the
 *  fast re-ask schedule) while it waited in the queue is moot if that was this
 *  recently; forced asks are exempt. */
export const KEY_ASK_DUP_GUARD_MS = 10_000;
/** Key-request POSTs in flight at once. One at a time, a joiner of a
 *  20-channel server needed 16 s just to FILE its asks whenever the API
 *  answered in ~0.8 s (2026-10-20 harness, ten joiners at once); the bucket
 *  limits (KeyAskLimiter) and the 150 ms start spacing are unchanged. */
export const KEY_ASK_MAX_IN_FLIGHT = 4;
/** A throttled ask goes back in the queue at most this many times. */
export const KEY_ASK_QUEUE_MAX_TRIES = 8;
/** The worker sleeps in slices no longer than this, so a forced ask that
 *  arrives while it waits is picked up promptly. */
export const KEY_ASK_QUEUE_SLEEP_SLICE_MS = 1_000;

// ── Who may hold a key ──────────────────────────────────────────────────────

/**
 * May this member hold the channel's Sender Key? Mirrors the API's
 * requiredKeyPermissionsForKind: VIEW_CHANNEL for text, VIEW_CHANNEL | CONNECT
 * for a Calls channel. `undefined` (permissions not on the row) → true: the
 * server stays the authority and an unknown must not strand a channel.
 */
export function mayHoldChannelKey(kind: string, myPermissions: bigint | string | undefined): boolean {
    if (myPermissions === undefined) return true;
    let bits: bigint;
    try { bits = typeof myPermissions === 'bigint' ? myPermissions : BigInt(myPermissions); } catch { return true; }
    const need = isCallsChannelKind(kind)
        ? Permissions.VIEW_CHANNEL | Permissions.CONNECT
        : Permissions.VIEW_CHANNEL;
    return (bits & need) === need;
}

// ── The ledger ──────────────────────────────────────────────────────────────

export interface AskLedgerEntry {
    /** The server's newest epoch when the ask was made. */
    targetEpoch: number;
    at: number;
    /** Asks made for this (or an older) target without it being satisfied. */
    count: number;
}

/** What this device last asked for, per channel. Cleared on account change. */
export class PrefetchLedger {
    private readonly byChannel = new Map<string, AskLedgerEntry>();

    get(channelId: string): AskLedgerEntry | undefined {
        return this.byChannel.get(channelId);
    }

    /** A request for `targetEpoch` reached the API. */
    noteSent(channelId: string, targetEpoch: number, now: number): void {
        const prev = this.byChannel.get(channelId);
        const count = prev && prev.targetEpoch >= targetEpoch ? prev.count + 1 : 1;
        this.byChannel.set(channelId, { targetEpoch: Math.max(targetEpoch, prev?.targetEpoch ?? 0), at: now, count });
    }

    delete(channelId: string): void {
        this.byChannel.delete(channelId);
    }

    clear(): void {
        this.byChannel.clear();
    }

    get size(): number {
        return this.byChannel.size;
    }
}

// ── The planner ─────────────────────────────────────────────────────────────

export interface PrefetchChannelInput {
    channel_id: string;
    kind: string;
    /** MAX(epoch) the API holds for the channel (0 = never minted). */
    latest_epoch?: number;
    /** The member's resolved permissions on the channel (decimal string). */
    my_permissions?: string | bigint;
}

export type AskReason = 'new' | 'newer_epoch' | 'reask' | 'stale_backoff';
export type SkipReason = 'no_hold_permission' | 'unknown_epoch' | 'queued' | 'recently_asked' | 'backoff';

export interface PlannedAsk {
    serverId: string;
    channelId: string;
    /** The newest epoch the API names; the ask is satisfied once it is held. */
    targetEpoch: number;
    /** The device holds no key at all (vs an older epoch). */
    keyless: boolean;
    reason: AskReason;
    /**
     * The epochs to ask for. Absent for a keyless channel (it wants every
     * epoch — history included); for a stale one, exactly the epochs above
     * the newest it holds (askableEpochRange). The history BELOW that is the
     * repair sweep's gap ask, never this one.
     */
    epochs?: number[];
}

/** Most epochs one request names — the API's KEY_REQUEST_EPOCHS_MAX. */
export const KEY_REQUEST_EPOCHS_MAX = 100;

/**
 * The epochs a device that holds `heldNewest` must ask for to reach `latest`:
 * heldNewest+1 … latest, newest-first-capped at KEY_REQUEST_EPOCHS_MAX (the
 * newest are the ones sending and reading depend on).
 */
export function askableEpochRange(heldNewest: number, latest: number): number[] {
    const lo = Math.max(heldNewest + 1, latest - KEY_REQUEST_EPOCHS_MAX + 1, 1);
    const out: number[] = [];
    for (let e = lo; e <= latest; e++) out.push(e);
    return out;
}

/** A precise epoch list for a request body: positive integers, deduped,
 *  ascending, at most KEY_REQUEST_EPOCHS_MAX (the newest kept). Empty → undefined. */
export function requestEpochList(epochs: readonly number[] | undefined): number[] | undefined {
    if (!epochs) return undefined;
    const clean = [...new Set(epochs.filter(e => Number.isInteger(e) && e >= 1))].sort((a, b) => a - b);
    if (!clean.length) return undefined;
    return clean.slice(-KEY_REQUEST_EPOCHS_MAX);
}

/** Two asks for one channel: absent ("everything") absorbs a list; lists union. */
export function mergeAskEpochs(a: readonly number[] | undefined, b: readonly number[] | undefined): number[] | undefined {
    if (!a || !b) return undefined;
    return requestEpochList([...a, ...b]);
}

export interface PrefetchPlan {
    /** In the order they should be sent: keyless channels first. */
    asks: PlannedAsk[];
    /** Channels whose newest epoch is already held (forget their ledger entry). */
    satisfied: string[];
    /** Keyed channels at epoch 0 that this device holds nothing for (mint, not ask). */
    unminted: string[];
    skipped: { channelId: string; reason: SkipReason }[];
}

export interface PlanArgs {
    serverId: string;
    /** The VIEW-filtered channel list for the server (GET /servers/:sid/channels). */
    channels: readonly PrefetchChannelInput[];
    /** channel_id → highest epoch held locally (null / absent = none). */
    held: Readonly<Record<string, number | null | undefined>>;
    ledger: PrefetchLedger;
    /** When a request was last POSTed for the channel, by ANY path. */
    lastAskedAt: (channelId: string) => number | undefined;
    /** Is the channel already waiting in the ask queue? */
    isQueued: (channelId: string) => boolean;
    now: number;
    /**
     * 'event' — connect / reconnect / permission or channel-list change / join /
     *           open: an unchanged ask is repeated after the 60 s dedup, as it
     *           always was.
     * 'tick'  — the periodic safety net: a channel that holds an OLDER epoch is
     *           re-asked only on the exponential back-off (the 2026-10-07 storm).
     */
    mode: 'event' | 'tick';
}

export function planKeyPrefetch(args: PlanArgs): PrefetchPlan {
    const { serverId, channels, held, ledger, lastAskedAt, isQueued, now, mode } = args;
    const plan: PrefetchPlan = { asks: [], satisfied: [], unminted: [], skipped: [] };
    const keyless: PlannedAsk[] = [];
    const stale: PlannedAsk[] = [];

    for (const c of channels) {
        if (!channelCarriesSenderKeys(c.kind)) continue;
        const cid = c.channel_id;
        if (!mayHoldChannelKey(c.kind, c.my_permissions)) {
            plan.skipped.push({ channelId: cid, reason: 'no_hold_permission' });
            continue;
        }
        const latest = c.latest_epoch;
        if (latest === undefined) { plan.skipped.push({ channelId: cid, reason: 'unknown_epoch' }); continue; }
        const mine = held[cid] ?? null;
        if (latest === 0) {
            if (mine === null) plan.unminted.push(cid);
            continue;
        }
        if (mine !== null && mine >= latest) {
            plan.satisfied.push(cid);
            continue;
        }
        if (isQueued(cid)) { plan.skipped.push({ channelId: cid, reason: 'queued' }); continue; }

        const isKeyless = mine === null;
        const entry = ledger.get(cid);
        const last = Math.max(lastAskedAt(cid) ?? 0, entry?.at ?? 0);
        let reason: AskReason | null = null;

        if (!entry) {
            if (now - last >= PREFETCH_REASK_DEDUP_MS) reason = 'new';
            else plan.skipped.push({ channelId: cid, reason: 'recently_asked' });
        } else if (entry.targetEpoch < latest) {
            if (now - last >= PREFETCH_NEWER_EPOCH_MIN_GAP_MS) reason = 'newer_epoch';
            else plan.skipped.push({ channelId: cid, reason: 'recently_asked' });
        } else if (now - last < PREFETCH_REASK_DEDUP_MS) {
            plan.skipped.push({ channelId: cid, reason: 'recently_asked' });
        } else if (mode === 'tick' && !isKeyless) {
            if (now - entry.at >= gapReaskDelayMs(entry.count)) reason = 'stale_backoff';
            else plan.skipped.push({ channelId: cid, reason: 'backoff' });
        } else {
            reason = 'reask';
        }

        if (reason) {
            (isKeyless ? keyless : stale).push({
                serverId, channelId: cid, targetEpoch: latest, keyless: isKeyless, reason,
                ...(isKeyless ? {} : { epochs: askableEpochRange(mine!, latest) }),
            });
        }
    }
    plan.asks = [...keyless, ...stale];
    return plan;
}

// ── The limiter ─────────────────────────────────────────────────────────────

/**
 * Account-wide pacing for POST …/key-request. EVERY path that sends one
 * records here (the planned asks, the fast re-ask schedule, opening a channel,
 * a failed install's re-ask), so the window reflects what the API's bucket has
 * really been charged.
 */
export class KeyAskLimiter {
    private stamps: number[] = [];
    private readonly backoff: HandshakeBackoff;
    private readonly now: () => number;

    constructor(opts: { now?: () => number; backoff?: HandshakeBackoff } = {}) {
        this.now = opts.now ?? Date.now;
        // A fixed 60 s API window: a 429 with no readable Retry-After clears
        // within a minute, so back off 5 s, 10 s, … up to 60 s.
        this.backoff = opts.backoff ?? new HandshakeBackoff({ now: this.now, baseMs: 5_000, maxMs: 60_000 });
    }

    private prune(now: number): void {
        const cutoff = now - KEY_ASK_WINDOW_MS;
        while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
    }

    /** A request POST is starting. */
    record(now: number = this.now()): void {
        this.prune(now);
        this.stamps.push(now);
    }

    /** The API answered 429 (optionally with its Retry-After). */
    onThrottled(retryAfterMs?: number): number {
        return this.backoff.onFailure(retryAfterMs);
    }

    /** A request was accepted. */
    onAccepted(): void {
        this.backoff.onSuccess();
    }

    isBlocked(): boolean {
        return this.backoff.isBlocked();
    }

    blockedForMs(): number {
        return this.backoff.remainingMs();
    }

    inWindow(now: number = this.now()): number {
        this.prune(now);
        return this.stamps.length;
    }

    /**
     * How long until a request of this class may start (0 = now).
     * `urgent` (forced / interactive) may use the bucket up to the hard ceiling;
     * background asks stop at the soft one.
     */
    waitMs(urgent: boolean, now: number = this.now()): number {
        const blocked = this.backoff.remainingMs();
        if (blocked > 0) return blocked;
        this.prune(now);
        let wait = 0;
        const last = this.stamps.length ? this.stamps[this.stamps.length - 1] : undefined;
        if (last !== undefined && now - last < KEY_ASK_MIN_GAP_MS) wait = KEY_ASK_MIN_GAP_MS - (now - last);
        const ceiling = urgent ? KEY_ASK_HARD_CEILING : KEY_ASK_SOFT_CEILING;
        if (this.stamps.length >= ceiling) {
            // The slot that frees the ceiling is `length - ceiling` places from the oldest.
            const frees = this.stamps[this.stamps.length - ceiling] + KEY_ASK_WINDOW_MS - now;
            wait = Math.max(wait, frees);
        }
        return Math.max(0, wait);
    }
}

/** Classify a failed key-request POST for the limiter: a 429 pauses the account. */
export function noteKeyRequestError(limiter: KeyAskLimiter, e: unknown): 'throttled' | 'failed' {
    if (classifyHandshakeError(e) === 'throttled') {
        limiter.onThrottled(parseRetryAfterMs(e));
        return 'throttled';
    }
    return 'failed';
}

// ── The queue ───────────────────────────────────────────────────────────────

export type AskPriority = 'forced' | 'keyless' | 'stale' | 'gap';
const PRIORITY_RANK: Record<AskPriority, number> = { forced: 0, keyless: 1, stale: 2, gap: 3 };

export type KeyAskOutcome = 'sent' | 'throttled' | 'failed' | 'skipped';

export interface QueuedAsk {
    serverId: string;
    channelId: string;
    priority: AskPriority;
    /** The newest epoch to be held for the ask to be moot. */
    targetEpoch?: number;
    /** The epochs to ask for (see PlannedAsk.epochs); absent = every epoch. */
    epochs?: number[];
}

interface QueueEntry extends QueuedAsk {
    seq: number;
    tries: number;
}

export interface KeyAskQueueDeps {
    limiter: KeyAskLimiter;
    /**
     * POST the request. MUST record into `limiter` (it is shared with paths that
     * do not go through this queue) and report a 429 to it (noteKeyRequestError).
     */
    send: (ask: QueuedAsk) => Promise<KeyAskOutcome>;
    /** Re-check just before sending: the key may have arrived while it waited. */
    stillWanted?: (ask: QueuedAsk) => Promise<boolean> | boolean;
    /**
     * POST several asks of ONE server in one call (POST /servers/:sid/key-requests)
     * — one outcome per ask, in order — or null when the API has no such
     * route (404/405): the queue then sends one at a time from then on. Like
     * `send`, MUST record into `limiter` (once: it is one call) and report a 429.
     */
    sendMany?: (asks: QueuedAsk[]) => Promise<KeyAskOutcome[] | null>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * The last look at a queued ask before it is sent (Dashboard's stillWanted):
 * is it still wanted, and exactly which epochs should it name?
 *
 *  - A PRECISE ask (it names epochs) is judged on what it names: whatever of
 *    it is still missing is sent, however recently something else was asked
 *    for the channel. (A recent "everything" ask does not cover it once that
 *    request has closed on the newest epoch.)
 *  - An "everything" ask is moot if another path asked within
 *    KEY_ASK_DUP_GUARD_MS (forced asks exempt), as before.
 *  - An "everything" ask whose newest epoch ARRIVED while it waited used to
 *    be dropped — and with it the history gap a repair sweep had merged into
 *    it. Now it becomes an ask for that gap (`knownGap`, still missing).
 *    2026-10-20, harness: a member joining 1 s after a leave got the rotated
 *    newest epoch from the rotation itself, its queued asks were all dropped
 *    as moot, and 13 of 20 channels never received their history.
 */
export function refineQueuedAsk(
    ask: QueuedAsk,
    ctx: { heldEpochs: readonly number[]; knownGap?: readonly number[]; lastAskedAt?: number; now: number },
): { send: boolean; epochs?: number[] } {
    const held = new Set(ctx.heldEpochs);
    if (ask.epochs) {
        const left = requestEpochList(ask.epochs.filter(e => !held.has(e)));
        return left ? { send: true, epochs: left } : { send: false };
    }
    if (ask.priority !== 'forced' && ctx.lastAskedAt !== undefined && ctx.now - ctx.lastAskedAt < KEY_ASK_DUP_GUARD_MS) {
        return { send: false };
    }
    const newest = held.size ? Math.max(...held) : null;
    if (ask.targetEpoch !== undefined && newest !== null && newest >= ask.targetEpoch) {
        const gap = requestEpochList((ctx.knownGap ?? []).filter(e => !held.has(e)));
        return gap ? { send: true, epochs: gap } : { send: false };
    }
    return { send: true };
}

/** Most asks one batch call carries (the API's KEY_REQUEST_BATCH_MAX). */
export const KEY_ASK_BATCH_MAX = 100;

export class KeyAskQueue {
    private readonly items = new Map<string, QueueEntry>();
    /** The API answered the batch route with 404/405: one ask per call. */
    private batchUnsupported = false;
    private seq = 0;
    private worker: Promise<void> | null = null;
    /** Resolves the worker's wait for "a send finished OR an ask arrived". */
    private wakeWorker: (() => void) | null = null;
    private epochGen = 0;
    private readonly deps: KeyAskQueueDeps;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(deps: KeyAskQueueDeps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    }

    get size(): number {
        return this.items.size;
    }

    has(channelId: string): boolean {
        return this.items.has(channelId);
    }

    /** Add an ask; one entry per channel (a second ask merges: best priority,
     *  newest target, and the union of the epochs — "every epoch" absorbs a list). */
    enqueue(ask: QueuedAsk): 'added' | 'merged' {
        const existing = this.items.get(ask.channelId);
        if (existing) {
            if (PRIORITY_RANK[ask.priority] < PRIORITY_RANK[existing.priority]) existing.priority = ask.priority;
            existing.targetEpoch = Math.max(existing.targetEpoch ?? 0, ask.targetEpoch ?? 0) || undefined;
            const epochs = mergeAskEpochs(existing.epochs, ask.epochs);
            if (epochs) existing.epochs = epochs; else delete existing.epochs;
            return 'merged';
        }
        this.items.set(ask.channelId, { ...ask, seq: this.seq++, tries: 0 });
        this.kick();
        this.wakeWorker?.();
        return 'added';
    }

    /** Drop everything (sign-out / account switch). In-flight work finishes. */
    clear(): void {
        this.items.clear();
        this.epochGen += 1;
    }

    /** Resolves when the queue has drained (for tests and shutdown). */
    async whenIdle(): Promise<void> {
        while (this.worker) await this.worker;
    }

    private kick(): void {
        if (this.worker) return;
        this.worker = this.run().finally(() => { this.worker = null; if (this.items.size) this.kick(); });
    }

    private next(): QueueEntry | undefined {
        let best: QueueEntry | undefined;
        for (const e of this.items.values()) {
            if (!best || PRIORITY_RANK[e.priority] < PRIORITY_RANK[best.priority]
                || (e.priority === best.priority && e.seq < best.seq)) best = e;
        }
        return best;
    }

    private async run(): Promise<void> {
        const gen = this.epochGen;
        const inflight = new Set<Promise<void>>();
        while ((this.items.size || inflight.size) && gen === this.epochGen) {
            if (!this.items.size || inflight.size >= KEY_ASK_MAX_IN_FLIGHT) {
                // Wait for a send to finish — or, with room left, for an ask to arrive.
                const arrived = this.items.size ? null : new Promise<void>(r => { this.wakeWorker = r; });
                await Promise.race(arrived ? [...inflight, arrived] : [...inflight]);
                this.wakeWorker = null;
                continue;
            }
            const item = this.next()!;
            const wait = this.deps.limiter.waitMs(item.priority === 'forced', this.now());
            if (wait > 0) {
                await this.sleep(Math.min(wait, KEY_ASK_QUEUE_SLEEP_SLICE_MS));
                continue;
            }
            this.items.delete(item.channelId);
            try {
                if (this.deps.stillWanted && !(await this.deps.stillWanted(item))) continue;
            } catch { /* ask anyway */ }
            if (this.deps.sendMany && !this.batchUnsupported) {
                // Everything else queued for this server goes in the same call,
                // best first (a joiner's whole server is ONE request, not 20).
                // Yield once first: a planner enqueues a server's asks in one
                // synchronous loop, and the first enqueue starts this worker.
                await Promise.resolve();
                const batch: QueueEntry[] = [item];
                const rest = [...this.items.values()]
                    .filter(e => e.serverId === item.serverId)
                    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.seq - b.seq);
                for (const e of rest) {
                    if (batch.length >= KEY_ASK_BATCH_MAX) break;
                    this.items.delete(e.channelId);
                    try {
                        if (this.deps.stillWanted && !(await this.deps.stillWanted(e))) continue;
                    } catch { /* ask anyway */ }
                    batch.push(e);
                }
                if (batch.length > 1) {
                    const sendingMany = (async () => {
                        let outcomes: KeyAskOutcome[] | null;
                        try { outcomes = await this.deps.sendMany!(batch); } catch { outcomes = batch.map(() => 'failed' as const); }
                        if (gen !== this.epochGen) return;
                        if (outcomes === null) {
                            // No batch route on this API: put them back, one per call from now on.
                            this.batchUnsupported = true;
                            for (const e of batch) if (!this.items.has(e.channelId)) this.items.set(e.channelId, e);
                            return;
                        }
                        batch.forEach((e, i) => {
                            if (outcomes![i] !== 'throttled') return;
                            e.tries += 1;
                            if (e.tries >= KEY_ASK_QUEUE_MAX_TRIES) return;
                            const again = this.items.get(e.channelId);
                            if (again) again.tries = Math.max(again.tries, e.tries);
                            else this.items.set(e.channelId, e);
                        });
                    })();
                    inflight.add(sendingMany);
                    void sendingMany.finally(() => inflight.delete(sendingMany));
                    if (this.items.size) await this.sleep(KEY_ASK_MIN_GAP_MS);
                    continue;
                }
            }
            const sending = (async () => {
                let outcome: KeyAskOutcome;
                try { outcome = await this.deps.send(item); } catch { outcome = 'failed'; }
                if (outcome === 'throttled' && gen === this.epochGen) {
                    // The API refused it: it goes BACK, it is not lost. (send() may
                    // already have re-enqueued it as forced; enqueue merges.)
                    item.tries += 1;
                    if (item.tries < KEY_ASK_QUEUE_MAX_TRIES) {
                        const again = this.items.get(item.channelId);
                        if (again) { again.tries = Math.max(again.tries, item.tries); }
                        else this.items.set(item.channelId, item);
                    }
                }
            })();
            inflight.add(sending);
            void sending.finally(() => inflight.delete(sending));
            // Keep the starts spaced (send() records into the limiter only once
            // it is under way, so the next waitMs could not see this one yet).
            if (this.items.size) await this.sleep(KEY_ASK_MIN_GAP_MS);
        }
        await Promise.all(inflight);
    }
}
