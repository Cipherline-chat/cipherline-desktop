/**
 * The holder side of channel-key delivery: answering key requests (a "serve
 * pass") and reacting to `server:member_joined`.
 *
 * Moved out of Dashboard.tsx (where it was the body of serveKeyRequests and
 * distributeKeysToNewMember) so the whole join → keys path can be driven by a
 * simulation with fake timers — one joiner, N holders — instead of only by
 * source-scan wiring tests. Every effect (REST, IPC, timers, diagnostics) is
 * injected; the decisions are unchanged from the inline version except for
 * the two additions below, both about MANY holders answering ONE joiner.
 *
 * First responder wins (2026-10-11, owner report: "had to wait 5 mins for the
 * keys to arrive"):
 *
 *  • member_join hands off to the request path. Every joiner — desktop of any
 *    version, mobile — files one key request per keyless channel within a
 *    second or two of joining, and every online holder is pushed each one.
 *    member_join used to ALSO make every online holder push every epoch of
 *    every channel to the joiner on its own (N holders × channels × epochs
 *    POSTs per join, none of them aware of the others), all of it landing on
 *    the same key-handshake route that prod was already failing on. Now a
 *    holder waits a short jittered moment and, if the joiner has open
 *    requests here, just runs a serve pass — which converges (below). Only a
 *    joiner that files nothing gets the old one-shot distribution.
 *
 *  • A serve pass re-lists the open requests while it runs. The API closes a
 *    request when the device ACKs that channel's newest epoch, so a request
 *    that vanished from the list was answered — by whoever got there first.
 *    If THIS holder has not delivered that request's newest epoch, it drops
 *    the request (newest and history alike); if it has, the history is its to
 *    finish (the existing "owed" rule). Nothing is suppressed on the server,
 *    and nothing a device asks for again is refused — a re-ask is a new
 *    request version and is served at once, as before.
 *
 * Nothing here touches key material: wrapping and posting are the injected
 * `distribute` (runKeyDistribution in Dashboard).
 */

import { computeEpochsToDistribute } from './channelKeyDistribution';
import {
    keyRequestVersion,
    latestFirstPhases,
    recordOwed,
    takeOwed,
    SERVE_PASS_SUBMISSION_CAP,
    type DeliveryLedger,
    type DistributionOutcome,
    type DistributionRecipient,
    type HandshakeBackoff,
    type OwedServe,
    type SingleFlight,
} from './keyDistributionThrottle';

/** One open key request, as GET /servers/:sid/key-requests/pending lists it. */
export interface PendingKeyRequest {
    request_id: string;
    channel_id: string;
    requester_user_id: string;
    requester_device_id: string;
    created_at: string;
    /**
     * The epochs the requester is missing, or null/absent for "every epoch you
     * hold" (an API or requester from before precise asks). See
     * epochsToServe.
     */
    epochs?: number[] | null;
    /** Only in member_join's ?all=1 listing (APIs from 2026-10-23): whether
     *  this caller's serve pass would see the request now. */
    serve_now?: boolean;
}

/**
 * Which of the epochs this device holds a request asks for. A request that
 * names its epochs gets exactly those (the ones held); one that does not gets
 * everything held, as before. Re-sending what the requester already holds was
 * the whole cost of the 2026-10-19 churn: one missing history epoch, 20-40
 * envelopes back from every online holder, on every re-ask.
 */
export function epochsToServe(held: readonly number[], requested: readonly number[] | null | undefined): number[] {
    if (!Array.isArray(requested)) return [...held];
    const want = new Set(requested);
    return held.filter(e => want.has(e));
}

export type DeviceBundle = Omit<DistributionRecipient, 'user_id'>;

/** During a pass, re-list the open requests at most this often (each list
 *  costs the API one VIEW resolve per channel with an open request). */
export const SERVE_RELIST_INTERVAL_MS = 1_000;
/** …and once more right before the history phase, if the last list is at
 *  least this old: history is the bulk of a join (channels × epochs), and the
 *  joiner has usually ACKed someone's newest epochs by then. */
export const SERVE_RELIST_BEFORE_HISTORY_MS = 500;

/** Delay before answering a `server:key_requested` push. Spreads N holders a
 *  little (the first to list and POST usually wins; the relist above stops
 *  the rest) without making a joiner wait for it — was pickJitterMs
 *  (0.5–3.5 s), the connect-sweep's anti-herd jitter. */
/**
 * Where in the (channel-sorted) list of open requests this device starts its
 * walk. Holders answering the same joiner at the same moment would otherwise
 * all walk channel 1, 2, 3 … in lock-step and every one of them would deliver
 * every channel's newest epoch before any re-list could show it the others'
 * work. Starting at a per-device point of the ring, they cover different
 * channels first, and each re-list drops what another one already delivered.
 * Stable per device (FNV-1a of the device id), so it needs no coordination.
 */
export function walkOffsetFor(deviceId: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < deviceId.length; i++) {
        h ^= deviceId.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

/** `items` sorted by channel (then device) and rotated to start at `offset`. */
export function rotateWalk<T extends { req: { channel_id: string; requester_device_id: string } }>(items: T[], offset: number): T[] {
    const sorted = [...items].sort((a, b) => {
        const ka = `${a.req.channel_id}:${a.req.requester_device_id}`;
        const kb = `${b.req.channel_id}:${b.req.requester_device_id}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    if (!sorted.length) return sorted;
    const k = ((offset % sorted.length) + sorted.length) % sorted.length;
    return [...sorted.slice(k), ...sorted.slice(0, k)];
}

/**
 * The phases of a pass when the API takes a channel's epochs in ONE call
 * (POST key-handshake/batch): each request whole, newest first within it.
 * Splitting newest from history (latestFirstPhases) exists because history
 * used to cost one POST per epoch; with a batch the history rides the same
 * call as the newest epoch, so splitting would only double the calls.
 */
export function wholeRequestPhases<T extends { epochs: number[] }>(items: T[]): { item: T; epochs: number[] }[] {
    const out: { item: T; epochs: number[] }[] = [];
    for (const item of items) {
        const epochs = [...new Set(item.epochs)].sort((a, b) => b - a);
        if (epochs.length) out.push({ item, epochs });
    }
    return out;
}

/** `phases` with each requesting device's items made adjacent (first
 *  appearance order kept): the unit runKeyDistributionMany answers in one go. */
export function groupPhasesByRequester<T extends { item: { req: { requester_device_id: string } } }>(phases: T[]): T[] {
    const groups = new Map<string, T[]>();
    for (const p of phases) {
        const k = p.item.req.requester_device_id;
        const g = groups.get(k);
        if (g) g.push(p); else groups.set(k, [p]);
    }
    return [...groups.values()].flat();
}

export function pickServeJitterMs(random: () => number = Math.random): number {
    return 150 + Math.floor(random() * 1_050);
}

/** member_join → wait this long (jittered) before deciding between handing
 *  off to the request path and distributing on our own. A joiner files its
 *  first key request ~0.3–1 s after the join. */
export const JOIN_HANDOFF_MIN_MS = 1_000;
export const JOIN_HANDOFF_SPREAD_MS = 1_000;
/** …and if it had filed nothing yet, look once more after this (the joining
 *  client re-sweeps 3 s after joining)… */
export const JOIN_HANDOFF_RECHECK_MS = 3_000;
/** …and a last time after this. A joiner that has filed nothing ~15 s after
 *  joining is one that will not (a client from before key requests); one that
 *  is merely slow (a busy machine, ten joiners at once) must not make EVERY
 *  online holder push every epoch of every channel at it — measured in the
 *  channel-key harness: 4,595 one-shot distributions for ten joiners when the
 *  hand-off gave up after ~5 s. */
export const JOIN_HANDOFF_LAST_CHECK_MS = 10_000;
/** …and, on a box too busy to have filed anything by then, once more. Every
 *  current client (desktop, mobile) files requests; the one-shot below is a
 *  safety net for ones that do not, and firing it from every holder at a
 *  joiner that is merely slow is the herd it must never be. */
export const JOIN_HANDOFF_FINAL_CHECK_MS = 20_000;

export function pickJoinHandoffDelayMs(random: () => number = Math.random): number {
    return JOIN_HANDOFF_MIN_MS + Math.floor(random() * JOIN_HANDOFF_SPREAD_MS);
}

/**
 * Should a pass drop this request because someone else answered it?
 * True only when the request is no longer open AND this device neither owes it
 * (a stopped pass of ours started it) nor delivered its newest epoch (then the
 * request closed on OUR envelope and its history is ours to send).
 */
export function answeredElsewhere(args: {
    channelId: string;
    deviceId: string;
    newestEpoch: number;
    openTargets: ReadonlySet<string>;
    owed: boolean;
    ledger: Pick<DeliveryLedger, 'hasDelivered'>;
}): boolean {
    if (args.owed) return false;
    if (args.openTargets.has(`${args.channelId}:${args.deviceId}`)) return false;
    return !args.ledger.hasDelivered(args.channelId, args.newestEpoch, args.deviceId);
}

function openTargetsOf(pending: readonly PendingKeyRequest[]): Set<string> {
    return new Set(pending.map(r => `${r.channel_id}:${r.requester_device_id}`));
}

export interface ServePassDeps {
    /** GET /servers/:sid/key-requests/pending (excludes our own device). */
    listPending: (serverId: string) => Promise<PendingKeyRequest[]>;
    /** Epochs of a channel this device holds (IPC). */
    listHeldEpochs: (channelId: string) => Promise<number[]>;
    /** GET /servers/:sid/members/:uid/devices. */
    getMemberDevices: (serverId: string, userId: string) => Promise<DeviceBundle[]>;
    /** GET pinned-epochs + refresh main-process prune protection. */
    refreshProtectedEpochs: (serverId: string) => Promise<Map<string, number[]>>;
    /** Dashboard's distributeChannelKeys (runKeyDistribution + one-shot resume). */
    distribute: (
        serverId: string,
        channelId: string,
        epochs: number[],
        recipients: DistributionRecipient[],
        rotationReason: string,
        opts?: { requestVersion?: string; requestSeenAt?: number; budget?: { remaining: number } },
    ) => Promise<DistributionOutcome>;
    backoff: HandshakeBackoff;
    ledger: DeliveryLedger;
    flight: SingleFlight;
    /** One resume per server (ResumeTimers keeps the earliest). */
    scheduleResume: (serverId: string, delayMs: number) => void;
    /** Request versions this device has finished answering. */
    answered: Set<string>;
    /**
     * Request version → how many epochs of its channel this device held when
     * it marked the version answered. A version stays answered only while
     * that is still true: a holder that has since INSTALLED another epoch of
     * the channel (it was mid-rotation, or still receiving keys itself) looks
     * at the request again. (It was the newest epoch held, which missed an
     * epoch installed BELOW it: a holder that had minted the newest rotation
     * itself but not yet received the one before marked a request for that
     * one answered for good — 2026-10-23, double-rotation-then-join.) Absent
     * = the pre-2026-10-20 behaviour (answered forever).
     */
    answeredHeldMax?: Map<string, number>;
    /** Called at the end of a pass with the channels of requests that are
     *  still OPEN but that this device has answered with what it holds — a
     *  key installed for one of them later is a reason to serve again. */
    onAnsweredOpen?: (channelIds: Set<string>) => void;
    /** The API takes a channel's epochs in one call (key-handshake/batch is
     *  available): serve each request whole (wholeRequestPhases). */
    batched?: () => boolean;
    /**
     * Answer ONE device's requests for several channels in as few calls as the
     * API takes (runKeyDistributionMany). With `batched`, a pass hands each
     * requesting device all of its requests at once instead of one call per
     * channel.
     */
    distributeMany?: (
        serverId: string,
        recipient: DistributionRecipient[],
        entries: { channelId: string; epochs: number[]; requestVersion?: string; requestSeenAt?: number }[],
        opts: { budget?: { remaining: number } },
    ) => Promise<DistributionOutcome>;
    /** Request version → when this device first saw it listed. */
    seenAt: Map<string, number>;
    /** History a stopped pass still owes (see recordOwed / takeOwed). */
    owed: Map<string, OwedServe<PendingKeyRequest>>;
    now: () => number;
    /** false = never re-list mid-pass (the pre-2026-10-11 pass; simulation control only). */
    relist?: boolean;
    /** walkOffsetFor(this device's id): where this holder starts its walk. */
    walkOffset?: number;
    onNoRecipientBundle?: (req: PendingKeyRequest) => void;
    onRequestError?: (req: PendingKeyRequest, e: unknown) => void;
    onPassError?: (e: unknown) => void;
    onUnservablePins?: (channelId: string, epochs: number[]) => void;
}

/**
 * Answer open key requests in a server with the epochs each one asks for that
 * this device holds (every held epoch, for a request that names none). Runs on connect (all servers, whatever the UI is showing), after a short
 * jitter on the `server:key_requested` push, and as member_join's hand-off.
 *
 * Order: every request's NEWEST epoch first, then history (latestFirstPhases)
 * — a new member can send and read new messages in every channel before any
 * channel's history goes out.
 *
 * Single-flight per server: a trigger that lands while a pass is running
 * rides it as ONE trailing re-run instead of starting a concurrent loop. Each
 * pass is capped at SERVE_PASS_SUBMISSION_CAP POSTs; an epoch already
 * delivered to the requesting device for this request version is not sent
 * again, but a RE-ASK (new version) is always served at once — an unacked
 * delivery is never treated as received; and a 429 / failure stops the pass
 * and schedules ONE resume after the back-off. A request someone else
 * answered meanwhile is dropped (answeredElsewhere).
 */
export function serveKeyRequestsPass(deps: ServePassDeps, serverId: string): Promise<void> {
    const { backoff, ledger, flight, answered, seenAt } = deps;
    return flight.run(serverId, async () => {
        if (backoff.isBlocked()) {
            deps.scheduleResume(serverId, backoff.remainingMs());
            return;
        }
        try {
            const pending = await deps.listPending(serverId);
            if (answered.size > 5_000) { answered.clear(); deps.answeredHeldMax?.clear(); }
            if (seenAt.size > 5_000) seenAt.clear();
            const now = deps.now();
            // Only requests this device has not already answered as-is.
            const listed: { req: PendingKeyRequest; version: string; seenAt: number; epochs: number[] }[] = [];
            const open: typeof listed = [];
            const heldMaxAt = deps.answeredHeldMax;
            const heldCountAtStart = new Map<string, number>();
            const markAnswered = (version: string, held: readonly number[]) => {
                answered.add(version);
                if (heldMaxAt) heldMaxAt.set(version, held.length);
            };
            for (const req of pending) {
                const version = keyRequestVersion(req);
                if (!seenAt.has(version)) seenAt.set(version, now);
                const askSeenAt = seenAt.get(version)!;
                listed.push({ req, version, seenAt: askSeenAt, epochs: [] });
                if (answered.has(version) && !heldMaxAt?.has(version)) continue;
                const held = await deps.listHeldEpochs(req.channel_id);
                if (answered.has(version)) {
                    // Answered with what we held then. Look again only if we
                    // have installed a NEWER epoch of this channel since —
                    // the holder that was still receiving the rotation it is
                    // being asked for (2026-10-20: a joiner asked for an epoch
                    // minted seconds earlier; every holder but its minter
                    // marked the ask answered before the key reached them, so
                    // only a re-ask minutes later reached them again).
                    if (held.length <= (heldMaxAt!.get(version) ?? 0)) continue;
                    answered.delete(version);
                }
                heldCountAtStart.set(version, held.length);
                if (!held.length) continue; // we hold nothing for this channel
                const epochs = epochsToServe(held, req.epochs);
                if (!epochs.length) {
                    // It asks only for epochs we do not hold either (a gap no
                    // online holder has, or one still on its way to us):
                    // nothing to send until we hold more, or it asks anew.
                    markAnswered(version, held);
                    continue;
                }
                if (ledger.allDelivered(req.channel_id, epochs, req.requester_device_id, version, askSeenAt)) {
                    markAnswered(version, held);
                    continue;
                }
                open.push({ req, version, seenAt: askSeenAt, epochs });
            }
            const reportAnsweredOpen = () => {
                if (!deps.onAnsweredOpen) return;
                const chans = new Set<string>();
                for (const { req, version } of listed) if (answered.has(version)) chans.add(req.channel_id);
                deps.onAnsweredOpen(chans);
            };
            // …plus history an earlier, stopped pass started and still owes
            // (its request is closed server-side once the newest epoch is
            // acked, so it is not in `pending` any more — see recordOwed).
            const owedItems = takeOwed(deps.owed, listed, answered, now);
            const owedVersions = new Set(owedItems.map(o => o.version));
            open.push(...owedItems);
            if (!open.length) { reportAnsweredOpen(); return; }
            const walk = rotateWalk(open, deps.walkOffset ?? 0);
            // RC-10: fetched (and used to refresh main-process protection) once
            // per pass, not once per request.
            const pinnedByChannel = await deps.refreshProtectedEpochs(serverId);
            for (const { req, epochs } of open) {
                const { unservable } = computeEpochsToDistribute(epochs, pinnedByChannel.get(req.channel_id) ?? [], undefined);
                if (unservable.length) deps.onUnservablePins?.(req.channel_id, unservable);
            }
            // One device-list GET per requesting USER per pass.
            const devicesByUser = new Map<string, Promise<DeviceBundle[]>>();
            const devicesOf = (uid: string) => {
                let p = devicesByUser.get(uid);
                if (!p) {
                    p = deps.getMemberDevices(serverId, uid);
                    devicesByUser.set(uid, p);
                }
                return p;
            };
            const newestOf = new Map<string, number>();
            for (const o of open) newestOf.set(o.version, Math.max(newestOf.get(o.version) ?? 0, ...o.epochs));
            let openTargets = openTargetsOf(pending);
            let lastListAt = now;
            const budget = { remaining: SERVE_PASS_SUBMISSION_CAP };
            // Versions that still owe something after this pass (a request
            // that threw).
            const unfinished = new Set<string>();
            let stop = false;
            // Every request's NEWEST epoch first, then history — see
            // latestFirstPhases. Same POSTs, same pacing, different order.
            const whole = deps.batched?.() === true;
            const many = whole && typeof deps.distributeMany === 'function';
            const phases = whole
                ? (many ? groupPhasesByRequester(wholeRequestPhases(walk)) : wholeRequestPhases(walk))
                : latestFirstPhases(walk);
            // Whole requests have no separate history phase to yield before.
            const latestCount = whole ? phases.length : open.filter(o => o.epochs.length > 0).length;
            let stoppedAt = -1;
            for (let i = 0; i < phases.length; i++) {
                if (many) {
                    // One requesting device's requests, answered together.
                    const device = phases[i].item.req.requester_device_id;
                    let j = i;
                    const entries: { channelId: string; epochs: number[]; requestVersion: string; requestSeenAt: number; req: PendingKeyRequest }[] = [];
                    while (j < phases.length && phases[j].item.req.requester_device_id === device) {
                        const { item: { req, version, seenAt: askSeenAt }, epochs } = phases[j];
                        j++;
                        if (answered.has(version)) continue;
                        const since = deps.now() - lastListAt;
                        if (deps.relist !== false && i > 0 && since >= SERVE_RELIST_INTERVAL_MS) {
                            try { openTargets = openTargetsOf(await deps.listPending(serverId)); } catch { /* keep the last view */ }
                            lastListAt = deps.now();
                        }
                        if (answeredElsewhere({
                            channelId: req.channel_id, deviceId: req.requester_device_id,
                            newestEpoch: newestOf.get(version) ?? Math.max(...epochs),
                            openTargets, owed: owedVersions.has(version), ledger,
                        })) { answered.add(version); continue; }
                        entries.push({ channelId: req.channel_id, epochs, requestVersion: version, requestSeenAt: askSeenAt, req });
                    }
                    if (entries.length) {
                        const first = entries[0].req;
                        try {
                            const dev = (await devicesOf(first.requester_user_id)).find(d => d.device_id === first.requester_device_id);
                            if (!dev) {
                                deps.onNoRecipientBundle?.(first);
                                for (const e of entries) answered.add(e.requestVersion);
                            } else {
                                const outcome = await deps.distributeMany!(
                                    serverId, [{ ...dev, user_id: first.requester_user_id }],
                                    entries.map(({ req: _r, ...e }) => e), { budget },
                                );
                                if (outcome.status === 'deferred') {
                                    deps.scheduleResume(serverId, outcome.retryInMs);
                                    stop = true;
                                }
                            }
                        } catch (e) {
                            for (const en of entries) unfinished.add(en.requestVersion);
                            deps.onRequestError?.(first, e);
                        }
                    }
                    if (stop) { stoppedAt = i; break; }
                    i = j - 1;
                    continue;
                }
                const { item: { req, version, seenAt: askSeenAt }, epochs } = phases[i];
                if (answered.has(version)) continue; // e.g. no listed device (below)
                if (i >= latestCount && flight.hasPendingRerun(serverId)) {
                    // New asks arrived mid-pass (a joiner files one request per
                    // channel, ~150 ms apart): yield before more HISTORY so the
                    // trailing re-run sends their NEWEST epochs first. What is
                    // left here is owed to that re-run (below), not dropped.
                    stop = true; stoppedAt = i; break;
                }
                // First responder wins: re-list now and then (and right before
                // history), and drop what another holder already answered.
                const since = deps.now() - lastListAt;
                if (deps.relist !== false && i > 0 && (since >= SERVE_RELIST_INTERVAL_MS || (i === latestCount && since >= SERVE_RELIST_BEFORE_HISTORY_MS))) {
                    try {
                        openTargets = openTargetsOf(await deps.listPending(serverId));
                    } catch { /* keep the last view — never skip on a failed list */ }
                    lastListAt = deps.now();
                }
                if (answeredElsewhere({
                    channelId: req.channel_id,
                    deviceId: req.requester_device_id,
                    newestEpoch: newestOf.get(version) ?? Math.max(...epochs),
                    openTargets,
                    owed: owedVersions.has(version),
                    ledger,
                })) {
                    answered.add(version);
                    continue;
                }
                try {
                    const dev = (await devicesOf(req.requester_user_id)).find(d => d.device_id === req.requester_device_id);
                    if (!dev) {
                        // The members/:uid/devices listing only carries APPROVED,
                        // un-revoked devices WITH a published key bundle — so this
                        // is a revoked device, or one whose bundle the server does
                        // not have (yet). Nothing can be wrapped for it either way.
                        // Not re-checked until it re-asks.
                        deps.onNoRecipientBundle?.(req);
                        answered.add(version);
                        continue;
                    }
                    const outcome = await deps.distribute(
                        serverId, req.channel_id, epochs,
                        [{ ...dev, user_id: req.requester_user_id }],
                        'backfill',
                        { requestVersion: version, requestSeenAt: askSeenAt, budget },
                    );
                    if (outcome.status === 'deferred') {
                        // 429 / failure / pass budget spent: stop THIS pass
                        // (no more POSTs from it) and resume once, later.
                        deps.scheduleResume(serverId, outcome.retryInMs);
                        stop = true;
                    }
                } catch (e) {
                    // One request failing (a member who left between the list
                    // and this fetch) must not abort every request after it in
                    // this pass: the list is oldest-first, so the newest
                    // request — usually the member who just joined — was the
                    // one that always lost.
                    unfinished.add(version);
                    deps.onRequestError?.(req, e);
                }
                if (stop) { stoppedAt = i; break; }
            }
            if (stop) {
                // The rest — this item included (the ledger skips whatever of
                // it did go out) — is owed to the resume.
                recordOwed(deps.owed, phases.slice(stoppedAt), deps.now());
            } else {
                for (const { version, epochs } of open) {
                    if (unfinished.has(version)) continue;
                    answered.add(version);
                    // What this pass served came from what we held at its start.
                    if (heldMaxAt && !heldMaxAt.has(version)) heldMaxAt.set(version, heldCountAtStart.get(version) ?? epochs.length);
                }
            }
            reportAnsweredOpen();
        } catch (e) {
            deps.onPassError?.(e);
        }
    });
}

/**
 * member_join's hand-off listing, from either API: a row list (an API without
 * `summary`, which ignores the parameter) or `{ asked, serve_now }` (2026-10-23
 * — one query, no rows). The summary becomes ONE stand-in row for the joiner,
 * which is all runMemberJoinDistribution reads (who asked; serve_now).
 */
export function joinCheckRows(data: unknown, requesterUserId: string): PendingKeyRequest[] {
    if (Array.isArray(data)) return data as PendingKeyRequest[];
    const d = data as { asked?: unknown; serve_now?: unknown } | null | undefined;
    if (!d || d.asked !== true) return [];
    return [{ request_id: '', channel_id: '', requester_user_id: requesterUserId, requester_device_id: '', created_at: '', serve_now: d.serve_now === true }];
}

export interface MemberJoinDeps {
    sleep: (ms: number) => Promise<void>;
    random?: () => number;
    /** Open (and just-answered) requests, routed anywhere — only the joiner's
     *  are needed (`requesterUserId`: the API may narrow to them; the check
     *  below still filters, for an API that ignores it). */
    listPending: (serverId: string, requesterUserId: string) => Promise<PendingKeyRequest[]>;
    /** serveKeyRequestsPass for this server (single-flight). */
    serve: (serverId: string) => Promise<void>;
    getMemberDevices: (serverId: string, userId: string) => Promise<DeviceBundle[]>;
    /** GET /servers/:sid/channels — fetched fresh, never the UI's cache. */
    listChannels: (serverId: string) => Promise<{ channel_id: string; kind: string }[]>;
    carriesSenderKeys: (kind: string) => boolean;
    refreshProtectedEpochs: (serverId: string) => Promise<Map<string, number[]>>;
    listHeldEpochs: (channelId: string) => Promise<number[]>;
    distribute: ServePassDeps['distribute'];
    onNoRecipientBundle?: () => void;
    onUnservablePins?: (channelId: string, epochs: number[]) => void;
    /** See ServePassDeps.batched. */
    batched?: () => boolean;
    /**
     * true only when this device KNOWS it holds no key of any keyed channel
     * of the server (it knows the server's channels and holds none of them —
     * typically it joined moments ago itself). Such a device can neither
     * serve nor distribute anything, so it skips the hand-off entirely.
     */
    holdsNoKeys?: (serverId: string) => Promise<boolean>;
}

export type MemberJoinOutcome = 'handoff' | 'distributed' | 'no_bundle' | 'unknown' | 'nothing_held';

/**
 * `server:member_joined` on an existing member's device. Hands off to the
 * request path when the joiner has asked (the normal case — see the module
 * doc); otherwise distributes EVERY channel epoch this device holds to the new
 * member's devices — full history, every channel's NEWEST epoch first — as a
 * bounded, resumable one-shot.
 */
export async function runMemberJoinDistribution(
    deps: MemberJoinDeps,
    serverId: string,
    newUserId: string,
): Promise<MemberJoinOutcome> {
    // Ten members joining together each saw the other nine join and ran nine
    // hand-off checks (and passes) with nothing to give (harness, ten joiners).
    if (await deps.holdsNoKeys?.(serverId).catch(() => false)) return 'nothing_held';
    await deps.sleep(pickJoinHandoffDelayMs(deps.random));
    const rechecks = [JOIN_HANDOFF_RECHECK_MS, JOIN_HANDOFF_LAST_CHECK_MS, JOIN_HANDOFF_FINAL_CHECK_MS];
    let listedOk = false;
    for (let attempt = 0; attempt <= rechecks.length; attempt++) {
        let pending: PendingKeyRequest[] | null = null;
        try { pending = await deps.listPending(serverId, newUserId); listedOk = true; } catch { pending = null; }
        const theirs = pending?.filter(r => r.requester_user_id === newUserId) ?? [];
        if (theirs.length) {
            // The API says none of them is ours to answer now (routed to another
            // holder, which was pushed, or already answered): a pass here could
            // only list nothing. Ours comes with the escalation's push. An API
            // that does not say (no `serve_now`) gets the pass, as before.
            if (!theirs.every(r => r.serve_now === false)) await deps.serve(serverId);
            return 'handoff';
        }
        if (attempt < rechecks.length) await deps.sleep(rechecks[attempt]);
    }
    // Never got an answer: do not push everything blind at an API that is
    // failing (that is exactly when a burst hurts most); the joiner's own
    // requests and every holder's connect sweep still cover it.
    if (!listedOk) return 'unknown';

    // The joiner asked for nothing we can see: distribute on our own.
    const newMemberDevices = await deps.getMemberDevices(serverId, newUserId);
    if (!newMemberDevices.length) {
        // If the joiner's device has no published key bundle yet, nothing is
        // distributed from here and only the joiner's own key requests can
        // recover it. Say so.
        deps.onNoRecipientBundle?.();
        return 'no_bundle';
    }
    const channels = await deps.listChannels(serverId);
    // RC-10: fetched once for the whole join, not once per channel.
    const pinnedByChannel = await deps.refreshProtectedEpochs(serverId);
    const plan: { channelId: string; epochs: number[] }[] = [];
    for (const ch of channels) {
        if (!deps.carriesSenderKeys(ch.kind)) continue;
        const epochs = await deps.listHeldEpochs(ch.channel_id);
        if (!epochs.length) continue; // no keys held — another member covers it
        const { unservable } = computeEpochsToDistribute(epochs, pinnedByChannel.get(ch.channel_id) ?? [], undefined);
        if (unservable.length) deps.onUnservablePins?.(ch.channel_id, unservable);
        plan.push({ channelId: ch.channel_id, epochs });
    }
    const recipients = newMemberDevices.map(d => ({ user_id: newUserId, ...d }));
    for (const { item, epochs } of (deps.batched?.() === true ? wholeRequestPhases(plan) : latestFirstPhases(plan))) {
        await deps.distribute(serverId, item.channelId, epochs, recipients, 'member_join');
    }
    return 'distributed';
}
