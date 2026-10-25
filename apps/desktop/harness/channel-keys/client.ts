/* eslint-disable @typescript-eslint/no-explicit-any -- the harness drives the
   modules of TWO source trees (base and this branch) through one file, so it
   reaches their exports through namespace objects and feature detection;
   typing them would pin it to one tree's signatures. */
/**
 * One headless desktop device for the channel-key harness (run.mjs forks one
 * process per device).
 *
 * REAL, imported from the source tree being measured (@desk / @elec aliases,
 * see bundle.mjs): the API it talks to (HTTP + WebSocket, real Postgres and
 * Redis); the desktop crypto (electron/e2ee-engine.ts wraps and opens every
 * key envelope, electron/channel-keys.ts stores keys, electron/signal-identity
 * makes the device's identity + prekeys — only the OS keychain is swapped for
 * memory); every decision/flow-control module of the key protocol:
 * keyServePass (serve pass, member_join hand-off), keyDistributionThrottle
 * (pacer, back-off, ledger, single-flight, mutex), channelKeyPrefetch (ask
 * planner, ask queue, limiter), keyReask (fast re-ask), channelKeyDistribution
 * (install validation, gap re-ask, rotation decisions), channelKeyEnvelopes,
 * channelKeyDistributorCheck, deviceDirectory, senderTrust and channelKeyWait
 * (the banner/layer signals).
 *
 * MIRRORED: Dashboard.tsx's glue — which effect calls what, on which event —
 * function by function (each names the Dashboard function it mirrors). Where
 * this branch changed the glue, the mirror follows the tree it was built from
 * by FEATURE DETECTION on the real modules (see `features`), so the same file
 * measures the base commit and this branch.
 *
 * Simplifications (stated in the report): no React/UI; own-device ("self")
 * envelopes are accepted without the own-device ledger (no harness device
 * distributes to its own account); the on-screen channel's history is a
 * modelled row list (one row per message, keyed by the epoch it was sent
 * under). The F1 directory attribution, the TOFU pin store (secureLocalStore
 * in memory) and the distributor membership check all run.
 */
import * as nodeCrypto from 'crypto';
import { ensureSignalIdentity } from '@elec/signal-identity';
import { encryptForDevices, decryptWithRetainedSpks } from '@elec/e2ee-engine';
import { SpkCandidateOrder } from '@elec/spk-candidates';
import {
    setChannelKey, getChannelKey, getLatestEpoch, listChannelEpochs, rotateChannelKey,
    getChannelKeyFingerprint, discardChannelKey,
} from '@elec/channel-keys';
import * as KDT from '@desk/utils/keyDistributionThrottle';
import * as KSP from '@desk/utils/keyServePass';
import * as CKD from '@desk/utils/channelKeyDistribution';
import * as CKP from '@desk/utils/channelKeyPrefetch';
import * as CKE from '@desk/utils/channelKeyEnvelopes';
import * as RQ from '@desk/utils/keyReask';
import * as DIR from '@desk/utils/deviceDirectory';
import * as TRUST from '@desk/utils/senderTrust';
import * as KV from '@desk/utils/keyVerification';
import * as DCHK from '@desk/utils/channelKeyDistributorCheck';
import * as CKW from '@desk/utils/channelKeyWait';
import { channelPlaceholderContent } from '@desk/utils/channelDecryptFailure';

const A = KDT as any; const S = KSP as any; const D = CKD as any; const E = CKE as any; const W = CKW as any;

/** Which parts of this branch's change the source tree has (null-safe on the base). */
const features = {
    installOrder: typeof E.orderEnvelopesForInstall === 'function',
    heldMaxReserve: String(S.serveKeyRequestsPass).includes('answeredHeldMax'),
    rotationStandDown: typeof D.rotationAlreadyDone === 'function',
    bannerLatch: typeof W.nextKeyWaitBanner === 'function',
    batchHandshake: typeof A.chunkBatchItems === 'function',
    manyChannels: typeof A.runKeyDistributionMany === 'function',
    batchAsk: typeof (CKP as any).KEY_ASK_BATCH_MAX === 'number',
};
const batchSupport = { unsupported: false };

const API = process.env.CKH_API ?? 'http://127.0.0.1:3197/v1';
const WS_URL = API.replace(/^http/, 'ws') + '/ws';

let NAME = '';
let userId = '';
let token = '';
let deviceId = '';
let identityPub = '';
let online = false;
let ws: WebSocket | null = null;

// ── observation ───────────────────────────────────────────────────────────
const stats = {
    handshakePosts: 0, handshake429: 0, handshakeErr: 0, handshakeSkippedDevices: 0,
    keyRequests: 0, keyRequestsByChannel: {} as Record<string, number[]>,
    pulls: 0, envelopesProcessed: 0, envelopesRejected: 0, rotationsMinted: 0, rotationsStoodDown: 0,
    postsByRecipientDevice: {} as Record<string, number[]>,
    postMs: [] as number[], listMs: [] as number[], passes: 0,
    rejectReasons: {} as Record<string, number>,
    postsByReason: {} as Record<string, number>,
    passesBy: {} as Record<string, number>,
    pushesIn: 0,
    /** Every API call's duration by route template (ids → :id), with its start time. */
    httpMs: {} as Record<string, [number, number][]>,
};
const routeOf = (method: string, path: string) => `${method} ${path.replace(/\?.*$/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`;
// Dashboard.heldBackKeysRef: an envelope decrypted but not installed yet
// (distributor data stale, conflict unresolved) — the decrypt spent its
// ephemeral key, so the next pull must reuse this result, not decrypt again.
const heldBack = new (E.HeldBackEnvelopes)();
function emit(msg: unknown) { process.send?.(msg); }
function log(...a: unknown[]) { if (process.env.CKH_VERBOSE) console.log(`[${NAME} ${new Date().toISOString()}]`, ...a); }

// ── http (axios-shaped errors so the throttle modules classify them) ──────
async function http(method: string, path: string, body?: unknown, withDevice = true, timeoutMs = 30_000): Promise<{ data: any; headers: Record<string, string> }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'x-cipherline-version': '9.9.9', 'content-type': 'application/json' };
    if (withDevice && deviceId) headers['x-device-id'] = deviceId;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const started = Date.now();
    try {
        const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
        const text = await res.text();
        let data: any; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
        const h: Record<string, string> = {}; res.headers.forEach((v, k) => { h[k] = v; });
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${method} ${path}: ${typeof data === 'string' ? data : JSON.stringify(data)}`), { response: { status: res.status, headers: h, data } });
        return { data, headers: h };
    } finally { clearTimeout(t); (stats.httpMs[routeOf(method, path)] ??= []).push([started, Date.now() - started]); }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── flow-control instances (Dashboard: useState(() => new …)) ─────────────
let backoff: any, pacer: any, ledger: any, mutex: any, serveFlight: any, resumeTimers: any, pullFlight: any;
let askLimiter: any, askQueue: any, prefetchLedger: any, reaskTargets: any, reaskScheduler: any, reaskBudget: any;
const answered = new Set<string>();
const answeredHeldMax = new Map<string, number>();
const answeredOpenChannels = new Map<string, Set<string>>();
const seenAtMap = new Map<string, number>();
const owed = new Map<string, any>();
const keyRequestDedup = new Map<string, number>();
const gapAsk = new Map<string, any>();
const coolOff = new Map<string, number>();
const envelopeFailureCount = new Map<string, number>();
const distributorRefreshCount = new Map<string, number>();
const firstKeyRequestTime = new Map<string, number>();
const keyRequestServeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const rotationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const rotationInFlight = new Set<string>();
const rotationSignalEpoch = new Map<string, number | undefined>();
const timers = new Set<ReturnType<typeof setTimeout>>();
const spkOrder = new SpkCandidateOrder();
let intervals: ReturnType<typeof setInterval>[] = [];

function initFlow() {
    backoff = new A.HandshakeBackoff();
    pacer = new A.Pacer();
    ledger = new A.DeliveryLedger();
    mutex = new A.KeyedMutex();
    serveFlight = new A.SingleFlight();
    resumeTimers = new A.ResumeTimers();
    pullFlight = new A.SingleFlight();
    askLimiter = new (CKP as any).KeyAskLimiter();
    prefetchLedger = new (CKP as any).PrefetchLedger();
    askQueue = new (CKP as any).KeyAskQueue({
        limiter: askLimiter,
        send: (ask: any) => fileKeyRequest(ask.serverId, ask.channelId, ask.epochs),
        ...(features.batchAsk ? { sendMany: (asks: any[]) => fileKeyRequests(asks[0].serverId, asks) } : {}),
        stillWanted: async (ask: any) => {
            if (!servers.some(s => s.server_id === ask.serverId)) return false;
            if (typeof (CKP as any).refineQueuedAsk === 'function') {
                const r = (CKP as any).refineQueuedAsk(ask, {
                    heldEpochs: listChannelEpochs(ask.channelId), knownGap: gapAsk.get(ask.channelId)?.epochs,
                    lastAskedAt: keyRequestDedup.get(ask.channelId), now: Date.now(),
                });
                if (r.send && r.epochs) ask.epochs = r.epochs;
                if (!r.send) log('ask dropped', ask.channelId.slice(0, 8), ask.priority, ask.epochs, 'held', listChannelEpochs(ask.channelId).length);
                return r.send;
            }
            if (ask.priority !== 'forced' && Date.now() - (keyRequestDedup.get(ask.channelId) ?? 0) < (CKP as any).KEY_ASK_DUP_GUARD_MS) return false;
            if (ask.targetEpoch !== undefined) {
                const held = getLatestEpoch(ask.channelId);
                if (held === null || held < ask.targetEpoch) return true;
                if (!ask.epochs) return false;
            }
            if (!ask.epochs) return true;
            const held = new Set(listChannelEpochs(ask.channelId));
            return ask.epochs.some((e: number) => !held.has(e));
        },
    });
    reaskTargets = new (RQ as any).ReaskTargets();
    reaskBudget = new (RQ as any).ReaskBudget();
    reaskScheduler = new (RQ as any).KeyReaskScheduler({
        tick: (sid: string) => (RQ as any).runReaskTick({
            pull: (s: string) => pullChannelKeys(s),
            wantedChannels: (s: string) => reaskTargets.forServer(s),
            hasNewest: async (cid: string) => { const h = getLatestEpoch(cid); return h !== null && h >= (reaskTargets.latestOf(cid) ?? 1); },
            onSatisfied: (cid: string) => { reaskTargets.delete(cid); firstKeyRequestTime.delete(cid); (CKW as any).noteNewestKeyPending?.(cid, false); },
            lastAskedAt: (cid: string) => keyRequestDedup.get(cid),
            activeChannelId: () => view?.channelId ?? null,
            fileKeyRequest: (s: string, cid: string) => fileKeyRequest(s, cid),
            sleep, now: Date.now, budget: reaskBudget,
        }, sid),
        onExhausted: (sid: string) => { for (const cid of reaskTargets.forServer(sid)) (CKW as any).noteNewestKeyPending?.(cid, false); reaskTargets.clearServer(sid); },
    });
}

// ── state ─────────────────────────────────────────────────────────────────
let servers: { server_id: string }[] = [];
const serverChannels = new Map<string, any[]>();       // Dashboard serverChannelsRef
const roster = new Map<string, { ids: Set<string>; at: number }>();

function later(ms: number, fn: () => void) {
    const t = setTimeout(() => { timers.delete(t); if (online) fn(); }, ms);
    timers.add(t);
}

// ── Dashboard.distributeChannelKeys ─────────────────────────────────────────
async function distributeChannelKeys(serverId: string, channelId: string, epochs: number[], recipients: any[], rotationReason: string, opts: any = {}): Promise<any> {
    if (!epochs.length || !recipients.length) return { status: 'done', posted: 0 };
    stats.postsByReason[rotationReason] = (stats.postsByReason[rotationReason] ?? 0) + 1;
    const outcome = await A.runKeyDistribution({
        backoff, pacer, ledger, mutex,
        getChannelKey: async (cid: string, ep: number) => { const b = getChannelKey(cid, ep); return b ? b.toString('base64') : null; },
        wrap: async ({ epoch, keyB64, device }: any) => {
            const content = D.buildChannelKeyContent({ channelId, epoch, keyB64, deviceId: device.device_id, rotationReason });
            const r: any = await encryptForDevices(JSON.stringify(content), userId, [device], deviceId);
            return r.envelope_b64 ?? r;
        },
        post: async (sid: string, body: any) => {
            stats.handshakePosts++;
            for (const env of body.envelopes) (stats.postsByRecipientDevice[env.device_id] ??= []).push(Date.now());
            try {
                const t0 = Date.now();
                const r = await http('POST', `/servers/${sid}/key-handshake`, body, false, A.KEY_HANDSHAKE_POST_TIMEOUT_MS ?? 15_000);
                stats.postMs.push(Date.now() - t0);
                stats.handshakeSkippedDevices += (r.data?.skipped_device_ids ?? []).length;
                return r;
            } catch (e: any) { if (e?.response?.status === 429) stats.handshake429++; else stats.handshakeErr++; throw e; }
        },
        ...(features.batchHandshake ? {
            postBatch: async (sid: string, body: any) => {
                stats.handshakePosts++;
                for (const it of body.items) for (const env of it.envelopes) (stats.postsByRecipientDevice[env.device_id] ??= []).push(Date.now());
                try {
                    const t0 = Date.now();
                    const r = await http('POST', `/servers/${sid}/key-handshake/batch`, body, false, A.KEY_HANDSHAKE_POST_TIMEOUT_MS ?? 15_000);
                    stats.postMs.push(Date.now() - t0);
                    stats.handshakeSkippedDevices += (r.data?.skipped ?? []).length;
                    return r;
                } catch (e: any) { if (e?.response?.status === 429) stats.handshake429++; else stats.handshakeErr++; throw e; }
            },
            batchSupport,
        } : {}),
    }, { serverId, channelId, epochs, recipients, requestVersion: opts.requestVersion, requestSeenAt: opts.requestSeenAt, budget: opts.budget });
    if (outcome.status === 'deferred' && opts.requestVersion === undefined && opts.budget === undefined) {
        const attempt = (opts.resumeAttempt ?? 0) + 1;
        if (attempt <= A.MAX_DISTRIBUTION_RESUMES) {
            const key = `dist:${serverId}:${channelId}:${rotationReason}:${epochs.join(',')}:${recipients.map((r: any) => r.device_id).sort().join(',')}`;
            resumeTimers.schedule(key, outcome.retryInMs, () => { if (online) void distributeChannelKeys(serverId, channelId, epochs, recipients, rotationReason, { resumeAttempt: attempt }); });
        }
    }
    return outcome;
}

// ── Dashboard.distributeChannelKeysMany ─────────────────────────────────────
async function distributeChannelKeysMany(serverId: string, recipient: any[], entries: any[], opts: any = {}): Promise<any> {
    stats.postsByReason.many = (stats.postsByReason.many ?? 0) + 1;
    return A.runKeyDistributionMany({
        backoff, pacer, ledger, mutex,
        getChannelKey: async (cid: string, ep: number) => { const b = getChannelKey(cid, ep); return b ? b.toString('base64') : null; },
        wrap: async ({ channelId, epoch, keyB64, device }: any) => {
            const content = D.buildChannelKeyContent({ channelId, epoch, keyB64, deviceId: device.device_id, rotationReason: 'backfill' });
            const r: any = await encryptForDevices(JSON.stringify(content), userId, [device], deviceId);
            return r.envelope_b64 ?? r;
        },
        post: async (sid: string, body: any) => {
            stats.handshakePosts++;
            const t0 = Date.now();
            const r = await http('POST', `/servers/${sid}/key-handshake`, body, false, A.KEY_HANDSHAKE_POST_TIMEOUT_MS ?? 15_000);
            stats.postMs.push(Date.now() - t0);
            return r;
        },
        postBatch: async (sid: string, body: any) => {
            stats.handshakePosts++;
            for (const it of body.items) for (const env of it.envelopes) (stats.postsByRecipientDevice[env.device_id] ??= []).push(Date.now());
            try {
                const t0 = Date.now();
                const r = await http('POST', `/servers/${sid}/key-handshake/batch`, body, false, A.KEY_HANDSHAKE_POST_TIMEOUT_MS ?? 15_000);
                stats.postMs.push(Date.now() - t0);
                stats.handshakeSkippedDevices += (r.data?.skipped ?? []).length;
                return r;
            } catch (e: any) { if (e?.response?.status === 429) stats.handshake429++; else stats.handshakeErr++; throw e; }
        },
        batchSupport,
    }, { serverId, recipient, entries, budget: opts.budget });
}

// ── distributor checks (Dashboard.pullChannelKeysOnce's F1 / distributor gate) ─
async function fetchRoster(serverId: string) {
    try {
        const r = await http('GET', `/servers/${serverId}/members`, undefined, false);
        const rows: any[] = Array.isArray(r.data) ? r.data : (r.data?.members ?? []);
        roster.set(serverId, { ids: new Set(rows.map(m => m.user_id)), at: Date.now() });
    } catch { /* stays as is */ }
}
async function fetchIdentityKeys(uid: string) {
    return (await http('GET', `/keys/identity_keys?user_id=${uid}`, undefined, false)).data ?? [];
}

// ── Dashboard.pullChannelKeysOnce ───────────────────────────────────────────
async function pullChannelKeysOnce(serverId: string) {
    stats.pulls++;
    try {
        const res = await http('GET', `/servers/${serverId}/channel-keys/pending`);
        const envelopes: any[] = res.data ?? [];
        if (!envelopes.length) return;
        const ackIds: string[] = [];
        const registeredLatest = new Map<string, number | null>();
        const registeredLatestEpoch = async (cid: string) => {
            if (!registeredLatest.has(cid)) {
                try { const r = await http('GET', `/channels/${cid}/epoch`, undefined, false); registeredLatest.set(cid, Number(r.data?.epoch ?? 0)); }
                catch { registeredLatest.set(cid, null); }
            }
            return registeredLatest.get(cid) ?? null;
        };
        let refreshAfter = false;
        const installed = new Set<string>();
        const postAcks = (batch: string[]) => http('POST', `/servers/${serverId}/channel-keys/ack`, { envelope_ids: batch }, false);
        const ackAll = async (ids: string[]) => {
            if (E.ackInBatches) await E.ackInBatches(ids, postAcks);
            else if (ids.length) await postAcks(ids).catch(() => undefined);
        };
        let order = envelopes; let newestCount = -1;
        if (features.installOrder) ({ ordered: order, newestCount } = E.orderEnvelopesForInstall(envelopes));
        for (let i = 0; i < order.length; i++) {
            const env = order[i];
            if (i === newestCount && ackIds.length) { await ackAll(ackIds.splice(0, ackIds.length)); }
            stats.envelopesProcessed++;
            try {
                const dec: any = heldBack.take(env.envelope_id, env.ciphertext_b64, Date.now()) ?? await decryptWithRetainedSpks(env.ciphertext_b64, deviceId, spkOrder);
                const su = dec.senderUserId; const sp = dec.senderPub; const sd = dec.senderDeviceId;
                if (su && su !== userId) await (DIR as any).ensureUser(su, fetchIdentityKeys);
                const content = JSON.parse(dec.contentJson);
                if (content?.type === 'channel_key' && content.key_b64) {
                    if (!D.channelKeyContentMatchesEnvelope(content, env)) throw new Error('[E2EE:KEY_ENVELOPE_MISMATCH]');
                    // Dashboard.pinAndDetect: F1 directory attribution + the TOFU pin store.
                    const verdict = su === userId ? 'ok' : (TRUST as any).evaluateSender({
                        myUserId: userId, theirUserId: su, senderPub: sp, senderDeviceId: sd,
                        directory: (DIR as any).status(su, sp, sd),
                    });
                    if (su !== userId && !(TRUST as any).isWarnable(verdict)) (KV as any).recordFirstSeen(userId, su, sp, sd);
                    if ((TRUST as any).actionFor(verdict, 'key_material') !== 'accept') throw new Error(`[E2EE:KEY_DISTRIBUTOR_REJECTED] ${verdict}`);
                    const ch = (serverChannels.get(serverId) ?? []).find(c => c.channel_id === env.channel_id) ?? null;
                    const r = roster.get(serverId);
                    let dv = (DCHK as any).judgeKeyDistributor({
                        distributorUserId: su, selfUserId: userId, channel: ch,
                        historicalEpoch: (DCHK as any).isHistoricalEpoch(env.epoch, ch?.latest_epoch),
                        roster: r ? { memberIds: r.ids, fresh: Date.now() - r.at < 10_000 } : null,
                        viewers: null,
                    });
                    const rk = `${env.channel_id}:${env.epoch}:${su}`;
                    if (dv === 'refresh') {
                        const n = distributorRefreshCount.get(rk) ?? 0;
                        dv = (DCHK as any).resolveRefreshVerdict(n);
                        if (dv === 'refresh') { distributorRefreshCount.set(rk, n + 1); refreshAfter = true; heldBack.hold(env.envelope_id, env.ciphertext_b64, dec, Date.now()); continue; }
                    }
                    if (dv === 'reject') throw new Error('[E2EE:KEY_DISTRIBUTOR_NOT_AUTHORIZED]');
                    if (D.channelKeyInstallProblem) {
                        const p = D.channelKeyInstallProblem(content, env);
                        if (p) throw new Error(`[E2EE:KEY_MALFORMED] ${p}`);
                    }
                    if (D.needsRegistryEpochCheck?.(env.epoch, ch?.latest_epoch)) {
                        const reg = await registeredLatestEpoch(env.channel_id);
                        if (reg === null || !D.epochWithinRegistry(env.epoch, reg)) throw new Error('[E2EE:EPOCH_IMPLAUSIBLE]');
                    }
                    const stored = setChannelKey(env.channel_id, env.epoch, content.key_b64, new Date(content.rotates_at ?? Date.now() + 7 * 864e5));
                    if (stored === 'conflict') {
                        const key = D.channelEpochKey(env.channel_id, env.epoch);
                        const n = (envelopeFailureCount.get(key) ?? 0) + 1;
                        envelopeFailureCount.set(key, n);
                        if (D.shouldGiveUpOnChannelKey(n)) { ackIds.push(env.envelope_id); coolOff.set(env.channel_id, D.computeCoolOffUntil(Date.now())); }
                        else heldBack.hold(env.envelope_id, env.ciphertext_b64, dec, Date.now());
                        continue;
                    }
                    emit({ event: 'key', channel: env.channel_id, epoch: env.epoch, t: Date.now(), stored, from: su });
                    log('key', env.channel_id.slice(0, 8), env.epoch, stored, su.slice(0, 8));
                    if (!features.heldMaxReserve || stored === 'stored') {
                        (CKW as any).noteChannelKeyReceived(env.channel_id);
                    }
                    if (stored === 'stored') installed.add(env.channel_id);
                }
                ackIds.push(env.envelope_id);
                envelopeFailureCount.delete(D.channelEpochKey(env.channel_id, env.epoch));
                coolOff.delete(env.channel_id);
            } catch (e) {
                stats.envelopesRejected++;
                const code = /\[E2EE:([A-Z_]+)\]/.exec(String(e))?.[1] ?? String(e).slice(0, 60);
                stats.rejectReasons[code] = (stats.rejectReasons[code] ?? 0) + 1;
                log('envelope failed', String(e));
                const key = D.channelEpochKey(env.channel_id, env.epoch);
                if (E.isEnvelopeReplay?.(e)) { ackIds.push(env.envelope_id); continue; }
                const n = (envelopeFailureCount.get(key) ?? 0) + 1;
                if (D.shouldGiveUpOnChannelKey(n)) { ackIds.push(env.envelope_id); envelopeFailureCount.delete(key); coolOff.set(env.channel_id, D.computeCoolOffUntil(Date.now())); }
                else { envelopeFailureCount.set(key, n); void maybeFileKeyRequest(serverId, env.channel_id); }
            }
        }
        if (refreshAfter) void fetchRoster(serverId).then(() => pullChannelKeys(serverId));
        if (ackIds.length) await ackAll(ackIds);
        if (features.heldMaxReserve) {
            const waiting = answeredOpenChannels.get(serverId);
            if (waiting && [...installed].some(c => waiting.has(c))) {
                resumeTimers.schedule(`serve:${serverId}`, S.pickServeJitterMs(), () => { if (online) void serveKeyRequests(serverId, 'installed'); });
            }
        }
    } catch (e) { log('pull failed', String(e)); }
}
function pullChannelKeys(serverId: string): Promise<void> {
    if (!online) return Promise.resolve();
    return pullFlight.run(serverId, () => pullChannelKeysOnce(serverId));
}

// ── Dashboard.fileKeyRequest / maybeFileKeyRequest ─────────────────────────
async function fileKeyRequest(serverId: string, channelId: string, epochs?: number[]): Promise<string> {
    if (!online) return 'skipped';
    if (D.isCoolingOff(coolOff.get(channelId), Date.now())) return 'skipped';
    let askEpochs = (CKP as any).requestEpochList?.(epochs);
    if (askEpochs) {
        const held = new Set(listChannelEpochs(channelId));
        askEpochs = (CKP as any).requestEpochList(askEpochs.filter((e: number) => !held.has(e)));
        if (!askEpochs) return 'skipped';
    }
    if (askLimiter.isBlocked()) { askQueue.enqueue({ serverId, channelId, priority: 'forced', ...(askEpochs ? { epochs: askEpochs } : {}) }); return 'throttled'; }
    askLimiter.record();
    keyRequestDedup.set(channelId, Date.now());
    if (!firstKeyRequestTime.has(channelId)) firstKeyRequestTime.set(channelId, Date.now());
    const keyless = getLatestEpoch(channelId) === null;
    let latestEpoch: number | undefined;
    let outcome = 'sent';
    stats.keyRequests++;
    (stats.keyRequestsByChannel[channelId] ??= []).push(Date.now());
    try {
        const r = await http('POST', `/servers/${serverId}/channels/${channelId}/key-request`, askEpochs ? { epochs: askEpochs } : {});
        latestEpoch = r.data?.latest_epoch;
        askLimiter.onAccepted();
        prefetchLedger.noteSent(channelId, typeof latestEpoch === 'number' ? latestEpoch : 1, Date.now());
        (CKW as any).noteKeyRequestAcked(channelId);
    } catch (e) {
        if ((CKP as any).noteKeyRequestError(askLimiter, e) === 'throttled') {
            outcome = 'throttled'; keyRequestDedup.delete(channelId);
            askQueue.enqueue({ serverId, channelId, priority: 'forced', ...(askEpochs ? { epochs: askEpochs } : {}) });
        } else outcome = 'failed';
    }
    log('ask', channelId.slice(0, 8), askEpochs ?? 'all', outcome, 'held', listChannelEpochs(channelId).length);
    if (keyless && latestEpoch !== 0) {
        reaskTargets.add(serverId, channelId, typeof latestEpoch === 'number' ? latestEpoch : 1);
        (CKW as any).noteNewestKeyPending?.(channelId, true);
        reaskScheduler.arm(serverId);
    }
    return outcome;
}
// ── Dashboard.fileKeyRequests (prepareKeyAsk / one POST / finishKeyAsk) ─────
async function fileKeyRequests(serverId: string, asks: { channelId: string; epochs?: number[] }[]): Promise<string[] | null> {
    if (!online) return asks.map(() => 'skipped');
    const out: string[] = asks.map(() => 'sent');
    const live: { i: number; channelId: string; askEpochs?: number[]; keyless: boolean }[] = [];
    asks.forEach((a, i) => {
        if (D.isCoolingOff(coolOff.get(a.channelId), Date.now())) { out[i] = 'skipped'; return; }
        let askEpochs = (CKP as any).requestEpochList(a.epochs);
        if (askEpochs) {
            const held = new Set(listChannelEpochs(a.channelId));
            askEpochs = (CKP as any).requestEpochList(askEpochs.filter((e: number) => !held.has(e)));
            if (!askEpochs) { out[i] = 'skipped'; return; }
        }
        if (askLimiter.isBlocked()) { askQueue.enqueue({ serverId, channelId: a.channelId, priority: 'forced', ...(askEpochs ? { epochs: askEpochs } : {}) }); out[i] = 'throttled'; return; }
        keyRequestDedup.set(a.channelId, Date.now());
        if (!firstKeyRequestTime.has(a.channelId)) firstKeyRequestTime.set(a.channelId, Date.now());
        live.push({ i, channelId: a.channelId, askEpochs, keyless: getLatestEpoch(a.channelId) === null });
    });
    if (!live.length) return out;
    askLimiter.record();
    const finish = (l: typeof live[number], latestEpoch: number | undefined, err?: unknown) => {
        stats.keyRequests++;
        (stats.keyRequestsByChannel[l.channelId] ??= []).push(Date.now());
        if (err === undefined) {
            prefetchLedger.noteSent(l.channelId, typeof latestEpoch === 'number' ? latestEpoch : 1, Date.now());
            (CKW as any).noteKeyRequestAcked(l.channelId);
        } else if (A.classifyHandshakeError(err) === 'throttled') {
            out[l.i] = 'throttled'; keyRequestDedup.delete(l.channelId);
            askQueue.enqueue({ serverId, channelId: l.channelId, priority: 'forced', ...(l.askEpochs ? { epochs: l.askEpochs } : {}) });
        } else out[l.i] = 'failed';
        log('ask', l.channelId.slice(0, 8), l.askEpochs ?? 'all', out[l.i], 'held', listChannelEpochs(l.channelId).length, '(batch)');
        if (l.keyless && latestEpoch !== 0) {
            reaskTargets.add(serverId, l.channelId, typeof latestEpoch === 'number' ? latestEpoch : 1);
            (CKW as any).noteNewestKeyPending?.(l.channelId, true);
            reaskScheduler.arm(serverId);
        }
    };
    try {
        const r = await http('POST', `/servers/${serverId}/key-requests`, { requests: live.map(l => ({ channel_id: l.channelId, ...(l.askEpochs ? { epochs: l.askEpochs } : {}) })) });
        askLimiter.onAccepted();
        const by = new Map<string, any>((r.data?.results ?? []).map((x: any) => [x.channel_id, x]));
        for (const l of live) {
            const x = by.get(l.channelId);
            if (x && !x.refused) finish(l, x.latest_epoch); else finish(l, undefined, new Error('refused'));
        }
    } catch (e: any) {
        const st = e?.response?.status;
        if (st === 404 || st === 405) { for (const l of live) keyRequestDedup.delete(l.channelId); return null; }
        (CKP as any).noteKeyRequestError(askLimiter, e);
        for (const l of live) finish(l, undefined, e);
    }
    return out;
}
async function maybeFileKeyRequest(serverId: string, channelId: string) {
    if (Date.now() - (keyRequestDedup.get(channelId) ?? 0) < 60_000) return;
    await fileKeyRequest(serverId, channelId);
}

// ── Dashboard.requestMissingChannelKeys ─────────────────────────────────────
async function requestMissingChannelKeys(serverId: string, opts: { background?: boolean } = {}) {
    if (!online) return;
    try {
        await pullChannelKeys(serverId);
        const res = await http('GET', `/servers/${serverId}/channels`, undefined, false);
        const channels: any[] = res.data ?? [];
        serverChannels.set(serverId, channels);
        const localLatest: Record<string, number | null> = {};
        for (const c of channels) if (D.channelCarriesSenderKeys(c.kind)) localLatest[c.channel_id] = getLatestEpoch(c.channel_id);
        const plan = (CKP as any).planKeyPrefetch({
            serverId, channels, held: localLatest, ledger: prefetchLedger,
            lastAskedAt: (cid: string) => keyRequestDedup.get(cid),
            isQueued: (cid: string) => askQueue.has(cid),
            now: Date.now(), mode: opts.background ? 'tick' : 'event',
        });
        for (const cid of plan.satisfied) prefetchLedger.delete(cid);
        for (const a of plan.asks) askQueue.enqueue({ serverId, channelId: a.channelId, priority: a.keyless ? 'keyless' : 'stale', targetEpoch: a.targetEpoch, ...(a.epochs ? { epochs: a.epochs } : {}) });
        try {
            const er = await http('GET', `/servers/${serverId}/key-epochs`, undefined, false);
            const byChannel = new Map<string, any[]>((er.data ?? []).map((e: any) => [e.channel_id, e.epochs]));
            for (const c of channels) {
                if (!D.channelCarriesSenderKeys(c.kind)) continue;
                const held = listChannelEpochs(c.channel_id);
                const list = byChannel.get(c.channel_id) ?? [];
                if (!held.length && !list.length) continue;
                const { missingEpochs } = D.computeMissingEpochsForChannel(list, held, Date.now());
                const gap = D.decideGapReask(missingEpochs, gapAsk.get(c.channel_id), Date.now());
                if (gap.next) gapAsk.set(c.channel_id, gap.next); else gapAsk.delete(c.channel_id);
                if (gap.ask && (typeof (CKP as any).refineQueuedAsk === 'function' || Date.now() - (keyRequestDedup.get(c.channel_id) ?? 0) >= 60_000)) {
                    askQueue.enqueue({ serverId, channelId: c.channel_id, priority: 'gap', epochs: [...missingEpochs] });
                }
            }
        } catch (e) { log('repair sweep failed', String(e)); }
    } catch (e) { log('requestMissing failed', String(e)); }
}

// ── Dashboard.serveKeyRequests ──────────────────────────────────────────────
function serveKeyRequests(serverId: string, why = 'other'): Promise<void> {
    if (!online) return Promise.resolve();
    stats.passes++;
    stats.passesBy[why] = (stats.passesBy[why] ?? 0) + 1;
    return S.serveKeyRequestsPass({
        listPending: async (sid: string) => { const t0 = Date.now(); const r = (await http('GET', `/servers/${sid}/key-requests/pending?epochs=1${features.batchHandshake ? '&routed=1' : ''}`)).data ?? []; stats.listMs.push(Date.now() - t0); return r; },
        listHeldEpochs: async (cid: string) => listChannelEpochs(cid),
        getMemberDevices: async (sid: string, uid: string) => (await http('GET', `/servers/${sid}/members/${uid}/devices`, undefined, false)).data ?? [],
        refreshProtectedEpochs: async () => new Map(),
        distribute: distributeChannelKeys,
        backoff, ledger, flight: serveFlight,
        scheduleResume: (sid: string, ms: number) => resumeTimers.schedule(`serve:${sid}`, ms, () => { if (online) void serveKeyRequests(sid, 'resume'); }),
        answered, seenAt: seenAtMap, owed, now: Date.now,
        walkOffset: S.walkOffsetFor ? S.walkOffsetFor(deviceId) : 0,
        answeredHeldMax,
        onAnsweredOpen: (chs: Set<string>) => { answeredOpenChannels.set(serverId, chs); },
        batched: () => features.batchHandshake && !batchSupport.unsupported,
        ...(features.manyChannels ? { distributeMany: distributeChannelKeysMany } : {}),
    }, serverId);
}

// ── Dashboard: server:member_joined effect ──────────────────────────────────
function onMemberJoined(serverId: string, newUserId: string) {
    if (!online || newUserId === userId) return;
    void S.runMemberJoinDistribution({
        sleep,
        listPending: async (sid: string, requester?: string) => {
            const summary = typeof S.joinCheckRows === 'function' && requester;
            const d = (await http('GET', `/servers/${sid}/key-requests/pending?epochs=1${features.batchHandshake ? '&all=1' : ''}${summary ? `&requester=${requester}&summary=1` : ''}`)).data;
            return summary ? S.joinCheckRows(d, requester) : (d ?? []);
        },
        serve: (sid: string) => serveKeyRequests(sid, 'handoff'),
        holdsNoKeys: async (sid: string) => {
            const mine = (serverChannels.get(sid) ?? []).filter((c: any) => D.channelCarriesSenderKeys(c.kind));
            return mine.length > 0 && mine.every((c: any) => listChannelEpochs(c.channel_id).length === 0);
        },
        getMemberDevices: async (sid: string, uid: string) => (await http('GET', `/servers/${sid}/members/${uid}/devices`, undefined, false)).data ?? [],
        listChannels: async (sid: string) => (await http('GET', `/servers/${sid}/channels`, undefined, false)).data ?? [],
        carriesSenderKeys: D.channelCarriesSenderKeys,
        refreshProtectedEpochs: async () => new Map(),
        listHeldEpochs: async (cid: string) => listChannelEpochs(cid),
        distribute: distributeChannelKeys,
        batched: () => features.batchHandshake && !batchSupport.unsupported,
    }, serverId, newUserId).catch((e: unknown) => log('member_join failed', String(e)));
}

// ── Dashboard: rotateCallsChannelKey + scheduleCallsChannelRotation ────────
async function rotate(serverId: string, channelId: string, reason: string) {
    const epochAtSignal = rotationSignalEpoch.get(channelId);
    rotationSignalEpoch.delete(channelId);
    const localLatest = getLatestEpoch(channelId);
    if (D.decideRotationAction({ channelKind: 'text', holdsLocalKey: localLatest != null }) !== 'rotate') return;
    rotationInFlight.add(channelId);
    try {
        const er = await http('GET', `/channels/${channelId}/epoch`, undefined, false);
        const serverLatest = er.data?.epoch ?? 0;
        if (features.rotationStandDown && D.rotationAlreadyDone(serverLatest, epochAtSignal)) {
            stats.rotationsStoodDown++;
            // Dashboard: verify the other holder's epoch reaches us, else rotate after all.
            if (typeof D.ROTATION_STAND_DOWN_VERIFY_MS === 'number') {
                later(D.ROTATION_STAND_DOWN_VERIFY_MS, () => {
                    const held = getLatestEpoch(channelId);
                    if (held != null && held >= serverLatest) return;
                    rotationSignalEpoch.set(channelId, rotationSignalEpoch.has(channelId) ? D.mergeEpochAtSignal(rotationSignalEpoch.get(channelId), serverLatest) : serverLatest);
                    onRotationNeeded({ server_id: serverId, channel_id: channelId, reason, epoch_at_signal: serverLatest });
                });
            }
            return;
        }
        const target = D.computeRotationEpoch(serverLatest, localLatest);
        if (target == null) return;
        const { epoch } = rotateChannelKey(channelId, target);
        const fp = getChannelKeyFingerprint(channelId, epoch);
        if (!fp) { discardChannelKey(channelId, epoch); return; }
        let claim: any = null;
        for (const d of [0, 500, 1500]) {
            if (d) await sleep(d);
            try { claim = (await http('POST', `/channels/${channelId}/epoch`, { epoch, fingerprint_b64: fp, rotation_reason: D.epochReasonForRotationSignal(reason) }, false)).data; break; } catch { /* retry */ }
        }
        const outcome = D.resolveRotationClaim({ claim, localFingerprintB64: fp });
        if (outcome !== 'distribute') {
            discardChannelKey(channelId, epoch);
            if (outcome === 'discard_and_request') await fileKeyRequest(serverId, channelId, features.rotationStandDown ? [epoch] : undefined);
            return;
        }
        stats.rotationsMinted++;
        emit({ event: 'rotated', channel: channelId, epoch, t: Date.now() });
        const rd = await http('GET', `/servers/${serverId}/channels/${channelId}/recipient-devices`);
        await distributeChannelKeys(serverId, channelId, [epoch], rd.data ?? [], D.normalizeRotationReason(reason));
    } catch (e) { log('rotation failed', String(e)); }
    finally { rotationInFlight.delete(channelId); }
}
function onRotationNeeded(d: any) {
    const ep = typeof d.epoch_at_signal === 'number' ? d.epoch_at_signal : undefined;
    if (features.rotationStandDown) {
        rotationSignalEpoch.set(d.channel_id, rotationSignalEpoch.has(d.channel_id) ? D.mergeEpochAtSignal(rotationSignalEpoch.get(d.channel_id), ep) : ep);
    }
    if (rotationTimers.has(d.channel_id) || rotationInFlight.has(d.channel_id)) return;
    const t = setTimeout(() => { rotationTimers.delete(d.channel_id); if (online) void rotate(d.server_id, d.channel_id, d.reason); }, D.pickJitterMs());
    rotationTimers.set(d.channel_id, t);
}

// ── connect-time sweep ──────────────────────────────────────────────────────
async function connectSweep() {
    const list = [...servers];
    await Promise.all([
        (async () => { for (const s of list) await requestMissingChannelKeys(s.server_id); })(),
        (async () => { for (const s of list) await serveKeyRequests(s.server_id, 'sweep'); })(),
    ]);
}
async function loadServers() {
    const r = await http('GET', '/servers', undefined, false);
    servers = (r.data ?? []).map((s: any) => ({ server_id: s.server_id }));
}

// ── the on-screen channel: modelled history + the real key-wait signals ────
interface ViewRow { id: string; epoch: number }
let view: { serverId: string; channelId: string; rows: ViewRow[]; mountedAt: number } | null = null;
const bannerTimeline: { t: number; banner: boolean; newestHeld: boolean; layer: boolean }[] = [];
const layer = { phase: 'hidden' as 'hidden' | 'shown', shownAt: null as number | null, gaveUp: false, done: false };
let bannerLatched = false;
let waitingSince: number | null = null;
function rowsNow(): any[] {
    if (!view) return [];
    const held = new Set(listChannelEpochs(view.channelId));
    return view.rows.map(r => held.has(r.epoch)
        ? { id: r.id, content: { type: 'text', text: 'x' }, sender_device_id: 'd' }
        : { id: r.id, content: channelPlaceholderContent('key_missing', r.epoch), sender_device_id: 'd' });
}
function bannerTick() {
    if (!view) return;
    const now = Date.now();
    const rows = rowsNow();
    const sig = W.getKeyWaitSignals(view.channelId);
    // The layer (useChannelKeyWait's shown → give-up path, condensed).
    const wants = W.needsKeyWaitState(rows, undefined, { newestKeyPending: !!sig.newestKeyPending });
    if (layer.phase === 'hidden' && !layer.done && wants) { layer.phase = 'shown'; layer.shownAt = now; }
    else if (layer.phase === 'hidden' && !layer.done && !wants && W.hasEncryptedRows(rows)) layer.done = true;
    else if (layer.phase === 'shown') {
        if (!wants) { layer.phase = 'hidden'; layer.done = true; }
        else if (!W.isDecrypting(sig) && now >= W.keyWaitGiveUpAt(sig, layer.shownAt!)) { layer.phase = 'hidden'; layer.done = true; layer.gaveUp = true; }
    }
    const layerUp = layer.phase === 'shown';
    let banner: boolean;
    if (features.bannerLatch) {
        const wanted = W.needsKeyWaitBanner(rows);
        waitingSince = wanted ? (waitingSince ?? now) : null;
        bannerLatched = W.nextKeyWaitBanner({ wanted, layerUp, gaveUp: layer.gaveUp, waitingSince, now, signals: sig, latched: bannerLatched });
        banner = bannerLatched;
    } else {
        const waitingCount = W.summarizeNewestPage(rows).keyMissing;
        const unanswered = W.deriveKeyWaitStage(sig, view.mountedAt, now) === 'stalled';
        banner = waitingCount > 0 && !layerUp && (layer.gaveUp || unanswered);
    }
    const newest = view.rows.length ? view.rows[view.rows.length - 1].epoch : 0;
    const newestHeld = listChannelEpochs(view.channelId).includes(newest);
    const last = bannerTimeline[bannerTimeline.length - 1];
    if (!last || last.banner !== banner || last.newestHeld !== newestHeld || last.layer !== layerUp) bannerTimeline.push({ t: now, banner, newestHeld, layer: layerUp });
}
/** Dashboard's envelopes-ready effect for the ACTIVE channel: re-read its page. */
function rereadView() {
    if (!view) return;
    const end = W.beginChannelPageDecrypt(view.channelId);
    setTimeout(end, 300);
}

// ── websocket ───────────────────────────────────────────────────────────────
function connect(): Promise<void> {
    online = true;
    intervals.push(setInterval(() => { for (const s of servers) void requestMissingChannelKeys(s.server_id, { background: true }); }, (CKP as any).PREFETCH_TICK_MS ?? 300_000));
    intervals.push(setInterval(() => { if (view) bannerTick(); }, 250));
    return new Promise((resolve, reject) => {
        const sock = new WebSocket(`${WS_URL}?token=${token}&version=9.9.9&device_id=${deviceId}`);
        ws = sock;
        sock.onopen = () => {
            const hb = () => { try { sock.send(JSON.stringify({ event: 'presence:heartbeat', data: { active: false } })); } catch { /* */ } };
            hb(); intervals.push(setInterval(hb, 15_000));
            later(D.pickJitterMs(), () => { void loadServers().then(connectSweep).catch(e => log('sweep failed', String(e))); });
            resolve();
        };
        sock.onerror = (e) => reject(e);
        sock.onmessage = (m) => {
            if (!online) return;
            let msg: any; try { msg = JSON.parse(String(m.data)); } catch { return; }
            const d = msg.data ?? {};
            switch (msg.event) {
                case 'server:member_joined': {
                    // Dashboard: invalidateRoster(server_id) — the copy turns stale, so a
                    // key from the newcomer reads 'refresh' (re-fetch), not 'reject'.
                    const r = roster.get(d.server_id); if (r) r.at = 0;
                    later(0, () => onMemberJoined(d.server_id, d.user_id));
                    break;
                }
                case 'server:channel_key_envelopes_ready':
                    void pullChannelKeys(d.server_id).then(() => { if (view && d.channel_id === view.channelId) rereadView(); });
                    break;
                case 'server:key_requested': {
                    stats.pushesIn++;
                    if (d.requester_device_id === deviceId) break;
                    if (keyRequestServeTimers.has(d.server_id)) break;
                    const t = setTimeout(() => { keyRequestServeTimers.delete(d.server_id); if (online) void serveKeyRequests(d.server_id, 'push'); }, S.pickServeJitterMs());
                    keyRequestServeTimers.set(d.server_id, t);
                    break;
                }
                case 'server:channel_key_rotation_needed': onRotationNeeded(d); break;
                case 'server:permissions_changed': case 'server:channels_changed': void requestMissingChannelKeys(d.server_id); break;
            }
        };
    });
}
function disconnect() {
    online = false;
    try { ws?.close(); } catch { /* */ }
    ws = null;
    for (const i of intervals) clearInterval(i);
    intervals = [];
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const t of keyRequestServeTimers.values()) clearTimeout(t);
    keyRequestServeTimers.clear();
    for (const t of rotationTimers.values()) clearTimeout(t);
    rotationTimers.clear();
    resumeTimers?.clearAll();
    reaskScheduler?.disarmAll();
    askQueue?.clear();
}

// ── commands from run.mjs ────────────────────────────────────────────────────
const commands: Record<string, (a: any) => Promise<any>> = {
    async init(a) {
        NAME = a.name; userId = a.userId; token = a.token;
        initFlow();
        const { bundle } = await ensureSignalIdentity();
        identityPub = bundle.identity_key_pub_b64;
        const reg = await http('POST', '/devices/register', { device_name: `${a.name}-${nodeCrypto.randomBytes(3).toString('hex')}`, platform: 'linux' }, false);
        deviceId = reg.data.device_id;
        await http('POST', '/keys/upload_bundle', {
            device_id: deviceId, identity_key_pub_b64: bundle.identity_key_pub_b64, registration_id: bundle.registration_id,
            signed_prekey_id: bundle.signed_prekey.id, signed_prekey_pub_b64: bundle.signed_prekey.pub_b64,
            signed_prekey_sig_b64: bundle.signed_prekey.sig_b64,
            one_time_prekeys: bundle.one_time_prekeys.map((p: any) => ({ prekey_id: p.prekey_id, prekey_pub_b64: p.prekey_pub_b64 })),
        }, false);
        return { deviceId, identityPub, features };
    },
    async connect() { await connect(); return true; },
    async disconnect() { disconnect(); return true; },
    async http(a) { return (await http(a.method, a.path, a.body, a.withDevice ?? false)).data; },
    /** Setup: mint `epochs` keys per channel locally; returns the material for the coordinator. */
    async mintLocal(a) {
        const out: Record<string, { epoch: number; keyB64: string; fp: string }[]> = {};
        for (const cid of a.channelIds) {
            out[cid] = [];
            for (let e = 1; e <= a.epochs; e++) {
                const { epoch, keyB64 } = rotateChannelKey(cid, e);
                out[cid].push({ epoch, keyB64, fp: getChannelKeyFingerprint(cid, epoch)! });
            }
        }
        return out;
    },
    /** Setup: install key material directly (not under test). */
    async installKeys(a) {
        for (const [cid, list] of Object.entries(a.keys as Record<string, { epoch: number; keyB64: string }[]>)) {
            for (const k of list) setChannelKey(cid, k.epoch, k.keyB64, new Date(Date.now() + 7 * 864e5));
        }
        return true;
    },
    /** Setup join: accept only (a holder that already "had" its keys). */
    async acceptSilently(a) { const r = await http('POST', `/invites/${a.code}/accept`, {}); await loadServers(); return r.data.server_id ?? r.data?.server?.server_id; },
    /** The joiner's flow (JoinServerModal → requestMissingChannelKeys now and +3 s). */
    async join(a) {
        const r = await http('POST', `/invites/${a.code}/accept`, {});
        const sid = r.data.server_id ?? r.data?.server?.server_id;
        await loadServers();
        await fetchRoster(sid);
        if (a.viewChannelId) {
            view = { serverId: sid, channelId: a.viewChannelId, rows: a.viewRows, mountedAt: Date.now() };
        }
        void requestMissingChannelKeys(sid);
        later(3000, () => { void requestMissingChannelKeys(sid); });
        later(D.pickJitterMs(), () => { void connectSweep(); });
        return sid;
    },
    async appendViewRows(a) { if (view) view.rows.push(...a.rows); return true; },
    async leave(a) { await http('POST', `/servers/${a.serverId}/leave`, {}); return true; },
    async status(a) { const out: Record<string, number[]> = {}; for (const cid of a.channelIds) out[cid] = listChannelEpochs(cid); return out; },
    async report() {
        return {
            features, stats: { ...stats, postsByRecipientDevice: undefined },
            postsByRecipientDevice: stats.postsByRecipientDevice,
            bannerTimeline, view: view ? { channelId: view.channelId, newest: view.rows[view.rows.length - 1]?.epoch } : null,
        };
    },
};

process.on('message', async (m: any) => {
    if (!m || !m.cmd) return;
    try { const result = await commands[m.cmd](m.args ?? {}); process.send?.({ id: m.id, ok: true, result }); }
    catch (e: any) { process.send?.({ id: m.id, ok: false, error: String(e?.message ?? e) }); }
});
process.on('unhandledRejection', (e) => log('unhandled', String(e)));
