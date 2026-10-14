import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    HandshakeBackoff,
    Pacer,
    DeliveryLedger,
    KeyedMutex,
    SingleFlight,
    ResumeTimers,
    runKeyDistribution,
    MAX_DISTRIBUTION_RESUMES,
    KEY_HANDSHAKE_POST_TIMEOUT_MS,
    type DistributionOutcome,
    type DistributionRecipient,
    type OwedServe,
} from './keyDistributionThrottle';
import {
    serveKeyRequestsPass,
    runMemberJoinDistribution,
    pickServeJitterMs,
    walkOffsetFor,
    type PendingKeyRequest,
    type ServePassDeps,
} from './keyServePass';
import { KeyReaskScheduler, ReaskBudget, ReaskTargets, runReaskTick } from './keyReask';

/**
 * Join → keys, simulated end to end with fake timers: one joining device and
 * N holder devices, each running the REAL holder code (serveKeyRequestsPass,
 * runMemberJoinDistribution, runKeyDistribution with its Pacer / back-off /
 * ledger / single-flight) and the REAL keyless-side code (KeyReaskScheduler +
 * runReaskTick), against an in-memory model of the API's key-request /
 * key-handshake / pending / ack semantics (requests close when the device
 * ACKs the channel's newest epoch; envelopes upsert per device; every request
 * is pushed to online holders; every handshake pushes envelopes_ready).
 *
 * What is modelled rather than run: the Dashboard glue (identical calls,
 * pinned by the wiring tests), the network (a fixed RTT, plus injected
 * faults), and crypto (envelopes are opaque strings — wrapping is not what is
 * slow).
 *
 * `OLD` reproduces what 1.0.21 / origin-main does today for the parts this
 * change touches: holders back off up to 5 min with no POST timeout, answer a
 * key_requested push after 0.5–3.5 s, each push their own member_join
 * distribution at once, never re-list mid-pass; the keyless device re-asks only
 * on the 75 s retry timer. (1.0.20's extra defects — history-first order, the
 * keep-first resume timer, the 10-minute re-ask skip — make it slower still;
 * they were fixed in 691f2950 and are covered by keyDistributionThrottle.test.)
 */

const SID = 'server-1';
const JOINER = 'joiner';
const JOINER_DEVICE = 'joiner-dev';

/** Deterministic randomness (mulberry32). */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, headers: {} } });

type Fault = 'ok' | 'hang' | { status: number };

interface Logic {
    name: 'old' | 'new';
    backoffMaxMs: number;
    postTimeoutMs: number | null;
    serveJitter: (r: () => number) => number;
    memberJoinHandoff: boolean;
    relist: boolean;
    /** Each holder starts its walk at its own point (walkOffsetFor). */
    rotateWalk: boolean;
    reask: boolean;
}

const NEW: Logic = {
    name: 'new',
    backoffMaxMs: 30_000,
    postTimeoutMs: KEY_HANDSHAKE_POST_TIMEOUT_MS,
    serveJitter: r => pickServeJitterMs(r),
    memberJoinHandoff: true,
    relist: true,
    rotateWalk: true,
    reask: true,
};

const OLD: Logic = {
    name: 'old',
    backoffMaxMs: 5 * 60_000,
    postTimeoutMs: null,
    serveJitter: r => 500 + Math.floor(r() * 3_000), // pickJitterMs
    memberJoinHandoff: false,
    relist: false,
    rotateWalk: false,
    reask: false,
};

interface HolderSpec {
    id: string;
    /** When the holder's socket is up (ms from the join). null = never. */
    onlineAt: number | null;
    /** Background / unloaded are LABELS: with backgroundThrottling:false the
     *  renderer's timers run as in the foreground, and no holder path reads
     *  the UI's loaded channel list — the model gives them nothing to read. */
    state?: 'foreground' | 'background' | 'unloaded';
}

interface Scenario {
    logic: Logic;
    channels: number;
    epochs: number;
    holders: HolderSpec[];
    halfRttMs?: number;
    /** Fault for a key-handshake POST (time from the join, holder id). */
    handshakeFault?: (t: number, holderId: string) => Fault;
    seed?: number;
    limitMs: number;
}

interface Result {
    /** ms from the join until the joiner held each channel's newest epoch. */
    newestAt: Map<string, number>;
    firstKeyMs: number | null;
    allNewestMs: number | null;
    handshakePosts: number;
    envelopesStored: number;
    keyRequests: number;
    listPendingCalls: number;
}

/** In-memory API: just the key-request / key-handshake / pending / ack rules. */
class FakeApi {
    readonly channels: { id: string; latest: number }[];
    private readonly requests = new Map<string, PendingKeyRequest & { open: boolean }>();
    private readonly envelopes = new Map<string, { envelope_id: string; channel_id: string; epoch: number; acked: boolean }>();
    private seq = 0;
    handshakePosts = 0;
    envelopesStored = 0;
    keyRequests = 0;
    listPendingCalls = 0;
    holders: SimHolder[] = [];
    joiner: SimJoiner | null = null;

    private readonly t0: number;
    private readonly halfRtt: number;
    private readonly fault?: Scenario['handshakeFault'];

    constructor(channels: number, epochs: number, t0: number, halfRtt: number, fault?: Scenario['handshakeFault']) {
        this.t0 = t0;
        this.halfRtt = halfRtt;
        this.fault = fault;
        this.channels = Array.from({ length: channels }, (_, i) => ({ id: `ch-${i + 1}`, latest: epochs }));
    }

    /** One HTTP round trip: half the RTT out, the handler, half back. */
    async call<T>(fn: () => T | Promise<T>): Promise<T> {
        await sleep(this.halfRtt);
        try {
            return await fn();
        } finally {
            await sleep(this.halfRtt);
        }
    }

    private push(fn: () => void) {
        setTimeout(fn, this.halfRtt);
    }

    latestOf(channelId: string): number {
        return this.channels.find(c => c.id === channelId)!.latest;
    }

    createKeyRequest(channelId: string) {
        this.keyRequests += 1;
        const k = `${channelId}:${JOINER_DEVICE}`;
        const created_at = `${new Date(Date.now()).toISOString()}#${++this.seq}`;
        const existing = this.requests.get(k);
        if (existing?.open) existing.created_at = created_at;
        else this.requests.set(k, { request_id: `req-${++this.seq}`, channel_id: channelId, requester_user_id: JOINER, requester_device_id: JOINER_DEVICE, created_at, open: true });
        for (const h of this.holders) if (h.online) this.push(() => h.onKeyRequested(SID));
        return { ok: true, latest_epoch: this.latestOf(channelId) };
    }

    listPending(): PendingKeyRequest[] {
        this.listPendingCalls += 1;
        return [...this.requests.values()].filter(r => r.open).map(r => ({ request_id: r.request_id, channel_id: r.channel_id, requester_user_id: r.requester_user_id, requester_device_id: r.requester_device_id, created_at: r.created_at }));
    }

    submitHandshake(holderId: string, body: { channel_id: string; epoch: number; envelopes: { device_id: string }[] }): Promise<unknown> | unknown {
        this.handshakePosts += 1;
        const f = this.fault?.(Date.now() - this.t0, holderId) ?? 'ok';
        if (f === 'hang') {
            // Origin never answers; Cloudflare gives up after ~100 s (524).
            return new Promise((_, reject) => setTimeout(() => reject(httpError(524)), 100_000));
        }
        if (f !== 'ok') throw httpError(f.status);
        for (const env of body.envelopes) {
            const k = `${body.channel_id}:${body.epoch}:${env.device_id}`;
            const prev = this.envelopes.get(k);
            if (!prev || prev.acked) this.envelopes.set(k, { envelope_id: `env-${++this.seq}`, channel_id: body.channel_id, epoch: body.epoch, acked: false });
            this.envelopesStored += 1;
        }
        const j = this.joiner;
        if (j) this.push(() => j.onEnvelopesReady());
        return { ok: true };
    }

    pullPending() {
        return [...this.envelopes.values()].filter(e => !e.acked).map(e => ({ ...e }));
    }

    ack(ids: string[]) {
        for (const e of this.envelopes.values()) {
            if (!ids.includes(e.envelope_id) || e.acked) continue;
            e.acked = true;
            // The API closes a request once its device ACKs the newest epoch.
            if (e.epoch >= this.latestOf(e.channel_id)) {
                const r = this.requests.get(`${e.channel_id}:${JOINER_DEVICE}`);
                if (r) r.open = false;
            }
        }
    }

    memberJoined() {
        for (const h of this.holders) if (h.online) this.push(() => h.onMemberJoined(SID, JOINER));
    }
}

class SimHolder {
    online = false;
    private readonly backoff: HandshakeBackoff;
    private readonly pacer = new Pacer();
    private readonly ledger = new DeliveryLedger();
    private readonly mutex = new KeyedMutex();
    private readonly flight = new SingleFlight();
    private readonly resumeTimers = new ResumeTimers();
    private readonly answered = new Set<string>();
    private readonly seenAt = new Map<string, number>();
    private readonly owed = new Map<string, OwedServe<PendingKeyRequest>>();
    private readonly serveTimers = new Map<string, ReturnType<typeof setTimeout>>();

    readonly spec: HolderSpec;
    private readonly api: FakeApi;
    private readonly logic: Logic;
    private readonly random: () => number;

    constructor(spec: HolderSpec, api: FakeApi, logic: Logic, random: () => number) {
        this.spec = spec;
        this.api = api;
        this.logic = logic;
        this.random = random;
        this.backoff = new HandshakeBackoff({ random, maxMs: logic.backoffMaxMs });
    }

    connect(fromJoin: number) {
        setTimeout(() => {
            this.online = true;
            // Connect sweep (jittered, every joined server).
            setTimeout(() => { void this.serve(SID); }, 500 + Math.floor(this.random() * 3_000));
        }, Math.max(0, fromJoin));
    }

    /** Dashboard.distributeChannelKeys: runKeyDistribution + bounded one-shot resume. */
    distribute = async (
        serverId: string, channelId: string, epochs: number[], recipients: DistributionRecipient[], reason: string,
        opts: { requestVersion?: string; requestSeenAt?: number; budget?: { remaining: number }; resumeAttempt?: number } = {},
    ): Promise<DistributionOutcome> => {
        const outcome = await runKeyDistribution({
            backoff: this.backoff,
            pacer: this.pacer,
            ledger: this.ledger,
            mutex: this.mutex,
            getChannelKey: async () => 'key',
            wrap: async ({ epoch, device }) => `wrapped:${channelId}:${epoch}:${device.device_id}`,
            post: (_sid, body) => {
                const p = this.api.call(() => this.api.submitHandshake(this.spec.id, body));
                const timeout = this.logic.postTimeoutMs;
                if (timeout === null) return p;
                return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })), timeout))]);
            },
        }, { serverId, channelId, epochs, recipients, requestVersion: opts.requestVersion, requestSeenAt: opts.requestSeenAt, budget: opts.budget });
        if (outcome.status === 'deferred' && opts.requestVersion === undefined && opts.budget === undefined) {
            const attempt = (opts.resumeAttempt ?? 0) + 1;
            if (attempt <= MAX_DISTRIBUTION_RESUMES) {
                this.resumeTimers.schedule(`dist:${channelId}:${reason}:${epochs.join(',')}`, outcome.retryInMs, () => {
                    void this.distribute(serverId, channelId, epochs, recipients, reason, { resumeAttempt: attempt });
                });
            }
        }
        return outcome;
    };

    private passDeps(): ServePassDeps {
        return {
            listPending: () => this.api.call(() => this.api.listPending()),
            listHeldEpochs: async () => Array.from({ length: this.api.channels[0].latest }, (_, i) => i + 1),
            getMemberDevices: () => this.api.call(() => [{ device_id: JOINER_DEVICE, spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' }]),
            refreshProtectedEpochs: () => this.api.call(() => new Map<string, number[]>()),
            distribute: this.distribute,
            backoff: this.backoff,
            ledger: this.ledger,
            flight: this.flight,
            scheduleResume: (sid, delayMs) => this.resumeTimers.schedule(`serve:${sid}`, delayMs, () => { void this.serve(sid); }),
            answered: this.answered,
            seenAt: this.seenAt,
            owed: this.owed,
            now: () => Date.now(),
            relist: this.logic.relist,
            walkOffset: this.logic.rotateWalk ? walkOffsetFor(`${this.spec.id}-device`) : 0,
        };
    }

    serve(serverId: string): Promise<void> {
        return serveKeyRequestsPass(this.passDeps(), serverId);
    }

    onKeyRequested(serverId: string) {
        if (this.serveTimers.has(serverId)) return;
        this.serveTimers.set(serverId, setTimeout(() => {
            this.serveTimers.delete(serverId);
            void this.serve(serverId);
        }, this.logic.serveJitter(this.random)));
    }

    onMemberJoined(serverId: string, newUserId: string) {
        const handoff = this.logic.memberJoinHandoff;
        void runMemberJoinDistribution({
            // OLD: no hand-off — distribute at once (an empty list never hands off).
            sleep: handoff ? sleep : async () => {},
            random: this.random,
            listPending: handoff ? () => this.api.call(() => this.api.listPending()) : async () => [],
            serve: sid => this.serve(sid),
            getMemberDevices: () => this.api.call(() => [{ device_id: JOINER_DEVICE, spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' }]),
            listChannels: () => this.api.call(() => this.api.channels.map(c => ({ channel_id: c.id, kind: 'text' }))),
            carriesSenderKeys: () => true,
            refreshProtectedEpochs: () => this.api.call(() => new Map<string, number[]>()),
            listHeldEpochs: async () => Array.from({ length: this.api.channels[0].latest }, (_, i) => i + 1),
            distribute: this.distribute,
        }, serverId, newUserId);
    }
}

class SimJoiner {
    readonly held = new Map<string, Set<number>>();
    readonly gated = new Set<string>();
    readonly newestAt = new Map<string, number>();
    private readonly dedup = new Map<string, number>();
    private readonly pullFlight = new SingleFlight();
    private readonly budget = new ReaskBudget();
    private readonly targets = new ReaskTargets();
    private readonly scheduler: KeyReaskScheduler;
    private retryTimer: ReturnType<typeof setInterval> | null = null;

    private readonly api: FakeApi;
    private readonly logic: Logic;
    private readonly t0: number;

    constructor(api: FakeApi, logic: Logic, t0: number) {
        this.api = api;
        this.logic = logic;
        this.t0 = t0;
        this.scheduler = new KeyReaskScheduler({
            onExhausted: sid => this.targets.clearServer(sid),
            tick: sid => runReaskTick({
                pull: () => this.pull(),
                wantedChannels: sid2 => this.targets.forServer(sid2),
                hasNewest: async c => Math.max(0, ...(this.held.get(c) ?? [])) >= (this.targets.latestOf(c) ?? 1),
                onSatisfied: c => { this.targets.delete(c); this.gated.delete(c); },
                lastAskedAt: c => this.dedup.get(c),
                activeChannelId: () => this.api.channels[0].id,
                fileKeyRequest: (_s, c) => this.fileKeyRequest(c),
                sleep,
                now: () => Date.now(),
                budget: this.budget,
            }, sid),
        });
    }

    private hasKey(c: string) { return (this.held.get(c)?.size ?? 0) > 0; }

    pull(): Promise<void> {
        return this.pullFlight.run(SID, async () => {
            const envs = await this.api.call(() => this.api.pullPending());
            if (!envs.length) return;
            for (const e of envs) {
                const set = this.held.get(e.channel_id) ?? new Set<number>();
                set.add(e.epoch);
                this.held.set(e.channel_id, set);
                if (e.epoch === this.api.latestOf(e.channel_id) && !this.newestAt.has(e.channel_id)) {
                    this.newestAt.set(e.channel_id, Date.now() - this.t0);
                }
            }
            await this.api.call(() => this.api.ack(envs.map(e => e.envelope_id)));
            for (const c of [...this.gated]) if (this.hasKey(c)) this.gated.delete(c);
        });
    }

    /** Dashboard.fileKeyRequest (the parts on this path). */
    async fileKeyRequest(channelId: string) {
        this.dedup.set(channelId, Date.now());
        const keyless = !this.hasKey(channelId);
        let latest: number | undefined;
        try {
            latest = (await this.api.call(() => this.api.createKeyRequest(channelId))).latest_epoch;
        } catch { /* recorded in the app */ }
        if (this.logic.reask && keyless && latest !== 0) {
            this.targets.add(SID, channelId, latest ?? 1);
            this.scheduler.arm(SID);
        }
    }

    /** Dashboard.requestMissingChannelKeys (the parts on this path). */
    async requestMissing() {
        await this.pull();
        for (const c of this.api.channels) if (!this.hasKey(c.id)) this.gated.add(c.id);
        for (const c of this.api.channels) {
            if (this.hasKey(c.id)) continue;
            if (Date.now() - (this.dedup.get(c.id) ?? 0) < 60_000) continue;
            await this.fileKeyRequest(c.id);
            await sleep(150);
        }
    }

    join() {
        void this.requestMissing();
        setTimeout(() => { void this.requestMissing(); }, 3_000);
        // The 75 s retry timer (gated channels only).
        this.retryTimer = setInterval(() => { if (this.gated.size) void this.requestMissing(); }, 75_000);
    }

    onEnvelopesReady() { void this.pull(); }

    stop() {
        if (this.retryTimer) clearInterval(this.retryTimer);
        this.scheduler.disarmAll();
    }
}

async function simulate(s: Scenario): Promise<Result> {
    const random = rng(s.seed ?? 7);
    const t0 = Date.now();
    const api = new FakeApi(s.channels, s.epochs, t0, s.halfRttMs ?? 50, s.handshakeFault);
    const joiner = new SimJoiner(api, s.logic, t0);
    api.joiner = joiner;
    api.holders = s.holders.map(spec => new SimHolder(spec, api, s.logic, random));
    for (const h of api.holders) {
        if (h.spec.onlineAt === 0) h.online = true;
        else if (h.spec.onlineAt !== null) h.connect(h.spec.onlineAt);
    }
    // The join: the API emits member_joined to online holders; the joining
    // client sweeps right after its join POST returns.
    api.memberJoined();
    setTimeout(() => joiner.join(), 2 * (s.halfRttMs ?? 50));

    const step = 100;
    for (let t = 0; t < s.limitMs; t += step) {
        await vi.advanceTimersByTimeAsync(step);
        if (joiner.newestAt.size === s.channels) break;
    }
    // Let in-flight history finish (for the volume counts), bounded.
    for (let t = 0; t < 60_000; t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
    joiner.stop();

    const times = [...joiner.newestAt.values()];
    return {
        newestAt: joiner.newestAt,
        firstKeyMs: times.length ? Math.min(...times) : null,
        allNewestMs: joiner.newestAt.size === s.channels ? Math.max(...times) : null,
        handshakePosts: api.handshakePosts,
        envelopesStored: api.envelopesStored,
        keyRequests: api.keyRequests,
        listPendingCalls: api.listPendingCalls,
    };
}

const holder = (id: string, state: HolderSpec['state'] = 'foreground', onlineAt: number | null = 0): HolderSpec => ({ id, onlineAt, state });

describe('join → keys simulation (one joiner, N holders, fake timers)', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T20:00:00Z')); });
    afterEach(() => { vi.useRealTimers(); });

    describe('healthy API: keys within 5 s whenever a holder is online', () => {
        for (const state of ['foreground', 'background', 'unloaded'] as const) {
            it(`owner's two-account test — B joins, A online (${state}): every channel's newest key < 5 s`, async () => {
                const r = await simulate({ logic: NEW, channels: 5, epochs: 3, holders: [holder('A', state)], limitMs: 120_000 });
                expect(r.allNewestMs).not.toBeNull();
                expect(r.firstKeyMs!).toBeLessThan(3_000);
                expect(r.allNewestMs!).toBeLessThan(5_000);
                // Exactly one full set of envelopes, no duplicates.
                expect(r.envelopesStored).toBe(5 * 3);
            });
        }

        it('one holder, 20 channels × 3 epochs, prod-like 300 ms RTT: every channel usable well before a minute', async () => {
            const r = await simulate({ logic: NEW, channels: 20, epochs: 3, holders: [holder('A', 'background')], halfRttMs: 150, limitMs: 300_000 });
            expect(r.firstKeyMs!).toBeLessThan(5_000);
            expect(r.allNewestMs!).toBeLessThan(20_000);
        });

        it('nobody online at the join; a holder connects at 60 s: keys within 5 s of it connecting', async () => {
            const r = await simulate({ logic: NEW, channels: 5, epochs: 3, holders: [holder('A', 'background', 60_000)], limitMs: 300_000 });
            expect(r.firstKeyMs!).toBeGreaterThanOrEqual(60_000);
            expect(r.allNewestMs!).toBeLessThan(65_000);
            // The keyless side kept asking while nobody could answer, but
            // within its budget: initial 5 + capped re-asks (≤ 30/min).
            expect(r.keyRequests).toBeLessThanOrEqual(5 + 30 + 6);
        });
    });

    describe('no storm: bounded envelopes and requests per join', () => {
        // What "bounded" means here: every holder answers each request VERSION
        // at most once (ledger), nothing loops, the keyless side's re-asks are
        // budgeted, and the total is never more than the old logic's — which
        // pushed N full sets (member_join, all at t=0) plus duplicate serves.
        // It is NOT exactly one set with several holders online: the joiner's
        // requests trickle in one per channel, so holders that start together
        // overlap on the first channels, and a holder that delivered a
        // channel's newest epoch also sends its history (no client-visible
        // signal says whose envelope the joiner installed). Measured below.

        it('5 holders online, 5 channels × 4 epochs: fewer envelopes than the old logic, keys still < 5 s', async () => {
            const C = 5, E = 4, N = 5;
            const holders = () => Array.from({ length: N }, (_, i) => holder(`H${i}`));
            const fresh = await simulate({ logic: NEW, channels: C, epochs: E, holders: holders(), limitMs: 120_000 });
            const old = await simulate({ logic: OLD, channels: C, epochs: E, holders: holders(), limitMs: 120_000 });

            expect(fresh.allNewestMs!).toBeLessThan(5_000);
            // Control: every holder pushed every epoch of every channel itself.
            expect(old.envelopesStored).toBeGreaterThanOrEqual(N * C * E);
            expect(fresh.envelopesStored).toBeGreaterThanOrEqual(C * E);
            expect(fresh.envelopesStored).toBeLessThan(old.envelopesStored);
            expect(fresh.envelopesStored).toBeLessThanOrEqual(N * C * E);
            // Requests: one per channel at the join; no re-asks needed.
            expect(fresh.keyRequests).toBe(C);
        });

        it('10 holders, 20 channels × 6 epochs, 200 ms RTT: well under half the old volume; list calls O(holders × passes)', async () => {
            const C = 20, E = 6, N = 10;
            const holders = () => Array.from({ length: N }, (_, i) => holder(`H${i}`));
            const fresh = await simulate({ logic: NEW, channels: C, epochs: E, holders: holders(), halfRttMs: 100, limitMs: 300_000 });
            const old = await simulate({ logic: OLD, channels: C, epochs: E, holders: holders(), halfRttMs: 100, limitMs: 300_000 });
            expect(fresh.allNewestMs!).toBeLessThan(15_000);
            expect(old.envelopesStored).toBeGreaterThanOrEqual(N * C * E);
            expect(fresh.envelopesStored).toBeLessThan(0.6 * old.envelopesStored);
            expect(fresh.keyRequests).toBe(C);
            expect(fresh.listPendingCalls).toBeLessThan(N * 25);
        }, 60_000);

        it('one holder: exactly one set — nothing is sent twice', async () => {
            const r = await simulate({ logic: NEW, channels: 20, epochs: 6, holders: [holder('A')], halfRttMs: 100, limitMs: 300_000 });
            expect(r.envelopesStored).toBe(20 * 6);
            expect(r.handshakePosts).toBe(20 * 6);
            expect(r.keyRequests).toBe(20);
        }, 60_000);
    });

    describe('negative controls: the minutes-long waits of the old logic', () => {
        it('the holder\'s first answers are REFUSED (403 — fail-closed permission check during a DB-pool stall): old waits for the 75 s timer, new re-asks in seconds', async () => {
            const refusedEarly = (t: number): Fault => (t < 4_000 ? { status: 403 } : 'ok');
            const old = await simulate({ logic: OLD, channels: 5, epochs: 3, holders: [holder('A', 'background')], handshakeFault: refusedEarly, limitMs: 300_000 });
            const fresh = await simulate({ logic: NEW, channels: 5, epochs: 3, holders: [holder('A', 'background')], handshakeFault: refusedEarly, limitMs: 300_000 });
            // Old: the refused NEWEST epochs are only re-asked by a timer if the
            // channel holds no key at all — here history landed after the
            // refusal, so the channel is "stale" and nothing timer-driven asks
            // again (in the app: only re-opening it, or undecryptable rows
            // feeding the 75 s timer). Not within 5 minutes in this model.
            expect(old.allNewestMs === null || old.allNewestMs >= 75_000).toBe(true);
            expect(fresh.allNewestMs).not.toBeNull();
            expect(fresh.allNewestMs!).toBeLessThan(15_000);
        });

        it('a key-handshake POST the origin never answers (Cloudflare 524 after 100 s): old holds every key for 100 s, new times out and retries', async () => {
            let hung = false;
            const firstHangs = (): Fault => { if (!hung) { hung = true; return 'hang'; } return 'ok'; };
            const old = await simulate({ logic: OLD, channels: 5, epochs: 3, holders: [holder('A')], handshakeFault: firstHangs, limitMs: 300_000 });
            hung = false;
            const fresh = await simulate({ logic: NEW, channels: 5, epochs: 3, holders: [holder('A')], handshakeFault: firstHangs, limitMs: 300_000 });
            expect(old.firstKeyMs!).toBeGreaterThanOrEqual(100_000);
            expect(fresh.allNewestMs!).toBeLessThan(25_000);
        });

        it('REPRODUCES ~5 min: the API recovers just after a holder\'s 8th consecutive failed key-handshake — old resumes ~5 min AFTER recovery, new within 30 s', async () => {
            // A brown-out of the key-handshake route (502s), ending 1 s after
            // the holder's 8th failed POST — i.e. long enough for the
            // exponential back-off to have reached its cap.
            const outage = () => {
                let failures = 0;
                let recoveredAt: number | null = null;
                const fault = (t: number): Fault => {
                    if (recoveredAt !== null && t >= recoveredAt) return 'ok';
                    failures += 1;
                    if (failures === 8) recoveredAt = t + 1_000;
                    return { status: 502 };
                };
                return { fault, recovered: () => recoveredAt! };
            };
            const o1 = outage();
            const old = await simulate({ logic: OLD, channels: 5, epochs: 3, holders: [holder('A', 'background')], handshakeFault: o1.fault, limitMs: 1_500_000 });
            const o2 = outage();
            const fresh = await simulate({ logic: NEW, channels: 5, epochs: 3, holders: [holder('A', 'background')], handshakeFault: o2.fault, limitMs: 1_500_000 });
            // Old: exponential back-off 2 s → 5 min, account-wide; the next
            // attempt after the outage lands ~5 minutes after it ended.
            expect(old.allNewestMs! - o1.recovered()).toBeGreaterThanOrEqual(4 * 60_000);
            // New: capped at 30 s (+ the pass itself).
            expect(fresh.allNewestMs! - o2.recovered()).toBeLessThan(35_000);
            // …and the lower cap did not turn the outage into a storm: one
            // probe per back-off, then one clean pass.
            expect(fresh.handshakePosts).toBeLessThanOrEqual(8 + 5 * 3 + 2);
        });
    });
});

describe.runIf(!!process.env.SIM_METRICS)('metrics (print only)', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T20:00:00Z')); });
    afterEach(() => { vi.useRealTimers(); });
    const cases: [string, Omit<Scenario, 'logic'>][] = [
        ['1h 5x3', { channels: 5, epochs: 3, holders: [holder('A')], limitMs: 120_000 }],
        ['5h 5x4', { channels: 5, epochs: 4, holders: [0, 1, 2, 3, 4].map(i => holder(`H${i}`)), limitMs: 120_000 }],
        ['3h 20x6 rtt200', { channels: 20, epochs: 6, holders: [0, 1, 2].map(i => holder(`H${i}`)), halfRttMs: 100, limitMs: 300_000 }],
        ['10h 20x6 rtt200', { channels: 20, epochs: 6, holders: Array.from({ length: 10 }, (_, i) => holder(`H${i}`)), halfRttMs: 100, limitMs: 300_000 }],
    ];
    const faultCases: [string, () => Omit<Scenario, 'logic'>][] = [
        ['refused<4s', () => ({ channels: 5, epochs: 3, holders: [holder('A', 'background')], handshakeFault: (t: number): Fault => (t < 4_000 ? { status: 403 } : 'ok'), limitMs: 300_000 })],
        ['first POST hangs', () => { let hung = false; return { channels: 5, epochs: 3, holders: [holder('A')], handshakeFault: (): Fault => { if (!hung) { hung = true; return 'hang'; } return 'ok'; }, limitMs: 300_000 }; }],
        ['nobody online, holder at 60s', () => ({ channels: 5, epochs: 3, holders: [holder('A', 'background', 60_000)], limitMs: 300_000 })],
        ['8 failures then recover', () => {
            let failures = 0; let rec: number | null = null;
            return { channels: 5, epochs: 3, holders: [holder('A', 'background')], limitMs: 1_500_000, handshakeFault: (t: number): Fault => {
                if (rec !== null && t >= rec) return 'ok';
                failures += 1; if (failures === 8) { rec = t + 1_000; process.stderr.write(`RECOVERED_AT ${rec}\n`); }
                return { status: 502 };
            } };
        }],
    ];
    for (const [name, mk] of faultCases) {
        it(name, async () => {
            for (const logic of [OLD, NEW]) {
                const r = await simulate({ ...mk(), logic });
                process.stderr.write(`METRIC ${name} ${logic.name} first=${r.firstKeyMs} all=${r.allNewestMs} env=${r.envelopesStored} posts=${r.handshakePosts} reqs=${r.keyRequests} lists=${r.listPendingCalls}\n`);
            }
        }, 600_000);
    }
    for (const [name, c] of cases) {
        it(name, async () => {
            for (const logic of [OLD, NEW]) {
                for (const seed of [1, 2, 3]) {
                    const r = await simulate({ ...c, logic, seed });
                    process.stderr.write(`METRIC ${name} ${logic.name} seed=${seed} first=${r.firstKeyMs} all=${r.allNewestMs} env=${r.envelopesStored} posts=${r.handshakePosts} reqs=${r.keyRequests} lists=${r.listPendingCalls}\n`);
                }
            }
        }, 600_000);
    }
});
