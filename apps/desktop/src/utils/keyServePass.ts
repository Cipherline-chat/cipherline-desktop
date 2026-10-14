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

export function pickServeJitterMs(random: () => number = Math.random): number {
    return 150 + Math.floor(random() * 1_050);
}

/** member_join → wait this long (jittered) before deciding between handing
 *  off to the request path and distributing on our own. A joiner files its
 *  first key request ~0.3–1 s after the join. */
export const JOIN_HANDOFF_MIN_MS = 1_000;
export const JOIN_HANDOFF_SPREAD_MS = 1_000;
/** …and if it had filed nothing yet, look once more after this (the joining
 *  client re-sweeps 3 s after joining). */
export const JOIN_HANDOFF_RECHECK_MS = 3_000;

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
 * Answer open key requests in a server with every epoch this device holds.
 * Runs on connect (all servers, whatever the UI is showing), after a short
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
            if (answered.size > 5_000) answered.clear();
            if (seenAt.size > 5_000) seenAt.clear();
            const now = deps.now();
            // Only requests this device has not already answered as-is.
            const listed: { req: PendingKeyRequest; version: string; seenAt: number; epochs: number[] }[] = [];
            const open: typeof listed = [];
            for (const req of pending) {
                const version = keyRequestVersion(req);
                if (!seenAt.has(version)) seenAt.set(version, now);
                const askSeenAt = seenAt.get(version)!;
                listed.push({ req, version, seenAt: askSeenAt, epochs: [] });
                if (answered.has(version)) continue;
                const epochs = await deps.listHeldEpochs(req.channel_id);
                if (!epochs.length) continue; // we hold nothing for this channel
                if (ledger.allDelivered(req.channel_id, epochs, req.requester_device_id, version, askSeenAt)) {
                    answered.add(version);
                    continue;
                }
                open.push({ req, version, seenAt: askSeenAt, epochs });
            }
            // …plus history an earlier, stopped pass started and still owes
            // (its request is closed server-side once the newest epoch is
            // acked, so it is not in `pending` any more — see recordOwed).
            const owedItems = takeOwed(deps.owed, listed, answered, now);
            const owedVersions = new Set(owedItems.map(o => o.version));
            open.push(...owedItems);
            if (!open.length) return;
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
            const phases = latestFirstPhases(walk);
            const latestCount = open.filter(o => o.epochs.length > 0).length;
            let stoppedAt = -1;
            for (let i = 0; i < phases.length; i++) {
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
                for (const { version } of open) if (!unfinished.has(version)) answered.add(version);
            }
        } catch (e) {
            deps.onPassError?.(e);
        }
    });
}

export interface MemberJoinDeps {
    sleep: (ms: number) => Promise<void>;
    random?: () => number;
    listPending: (serverId: string) => Promise<PendingKeyRequest[]>;
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
}

export type MemberJoinOutcome = 'handoff' | 'distributed' | 'no_bundle';

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
    await deps.sleep(pickJoinHandoffDelayMs(deps.random));
    for (let attempt = 0; attempt < 2; attempt++) {
        let pending: PendingKeyRequest[] | null = null;
        try { pending = await deps.listPending(serverId); } catch { pending = null; }
        if (pending && pending.some(r => r.requester_user_id === newUserId)) {
            await deps.serve(serverId);
            return 'handoff';
        }
        if (attempt === 0) await deps.sleep(JOIN_HANDOFF_RECHECK_MS);
    }

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
    for (const { item, epochs } of latestFirstPhases(plan)) {
        await deps.distribute(serverId, item.channelId, epochs, recipients, 'member_join');
    }
    return 'distributed';
}
