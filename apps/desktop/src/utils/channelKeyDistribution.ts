/**
 * Pure helpers for the channel Sender-Key distribution / backfill protocol.
 * Extracted from Dashboard so the decision logic is unit-testable without
 * React or Electron IPC. See Dashboard's distributeChannelKeys /
 * requestMissingChannelKeys / serveKeyRequests for the effectful side.
 */

import { Permissions } from '@cipherline/shared';

export interface ChannelKeyStatusInput {
    channel_id: string;
    kind: string;
    /** Server-side MAX(epoch) from GET /servers/:sid/channels (0 = never bootstrapped). */
    latest_epoch?: number;
}

/**
 * Channel kinds that carry a per-epoch Sender Key.
 *
 * Originally text only. Calls channels ('huddle', and the deprecated 'voice')
 * now carry one too: their LiveKit room key is DERIVED from it — see
 * utils/voiceChannelKey.ts — which is what makes server calls end-to-end
 * encrypted. Before that they joined LiveKit with an empty key, i.e. not E2EE.
 *
 * Mirrors KEYED_CHANNEL_KINDS in apps/api/src/entities/channel.entity.ts. The
 * two must agree: a kind the client thinks is keyed but the server does not
 * leaves clients waiting forever for a key nobody will distribute, and the
 * reverse silently drops a channel out of the distribution sweep.
 */
export const KEYED_CHANNEL_KINDS = ['text', 'huddle', 'voice'] as const;

/** True iff this channel kind carries a Sender Key. */
export function channelCarriesSenderKeys(kind: string): boolean {
    return (KEYED_CHANNEL_KINDS as readonly string[]).includes(kind);
}

/**
 * True iff this is a Calls channel (user-facing name — never show "huddle" in
 * UI). These are gated on VIEW_CHANNEL | CONNECT server-side rather than
 * VIEW_CHANNEL alone, and only ever need their CURRENT epoch: a call is live
 * media, so there is no "history" an older epoch could unlock.
 */
export function isCallsChannelKind(kind: string): boolean {
    return kind === 'huddle' || kind === 'voice';
}

/**
 * Which keyed channels (text + Calls) need a key request filed: the server has minted keys
 * (latest_epoch > 0) but this device holds nothing, or only retired epochs.
 * `localLatest` maps channel_id → highest locally-held epoch (null/absent = none).
 */
export function computeMissingKeyChannels(
    channels: ChannelKeyStatusInput[],
    localLatest: Record<string, number | null>,
): string[] {
    return channels
        .filter(c => channelCarriesSenderKeys(c.kind))
        .filter(c => (c.latest_epoch ?? 0) > 0)
        .filter(c => {
            const local = localLatest[c.channel_id];
            return local == null || local < (c.latest_epoch ?? 0);
        })
        .map(c => c.channel_id);
}

/**
 * computeMissingKeyChannels, split by what the gap actually means:
 *
 *  • `noKey` — the server has keys for the channel and this device holds NONE.
 *    It cannot encrypt at all, so this (and only this) gates the composer.
 *  • `stale` — this device holds a key, just not the server's newest epoch
 *    (a rotation or recovery epoch it was never sent). Sending still works, so
 *    this must NOT gate the composer — it is background repair: keep filing
 *    key requests, and fall back to a fresh epoch if no holder ever answers.
 *
 * The composer gate used to be raised for both while every path that LOWERS
 * it (opening the channel, the gate self-heal, envelopes-ready) asks only "is
 * any key held?". A stale channel therefore flickered "Waiting for channel
 * keys" on every server open (sweep raises, heal lowers, the 3 s follow-up
 * sweep raises again) and the fallback rotation that should repair it never
 * fired, because each lowering reset its 10-minute clock.
 */
export function splitMissingKeyChannels(
    channels: ChannelKeyStatusInput[],
    localLatest: Record<string, number | null>,
): { noKey: string[]; stale: string[] } {
    const noKey: string[] = [];
    const stale: string[] = [];
    for (const id of computeMissingKeyChannels(channels, localLatest)) {
        if (localLatest[id] == null) noKey.push(id);
        else stale.push(id);
    }
    return { noKey, stale };
}

/**
 * Keyed channels (text + Calls) that have NEVER been minted anywhere — `latest_epoch` is
 * explicitly `0` (a real "nobody has ever recorded an epoch for this
 * channel" answer from the server), not merely absent/unknown — and this
 * device holds nothing locally either. Distinct from computeMissingKeyChannels
 * (which finds channels to file a REQUEST for): a never-minted channel has
 * no holder anywhere to request from, so it needs a MINT instead, and must
 * stay invisible to the request-filing sweep to avoid an unanswerable
 * request.
 */
export function computeUnmintedChannels(
    channels: ChannelKeyStatusInput[],
    localLatest: Record<string, number | null>,
): string[] {
    return channels
        .filter(c => channelCarriesSenderKeys(c.kind))
        .filter(c => c.latest_epoch === 0)
        .filter(c => (localLatest[c.channel_id] ?? null) == null)
        .map(c => c.channel_id);
}

/**
 * May THIS member mint / record a channel's Sender-Key epoch? Mirrors the
 * server's write gate (ChannelMessagesService.epochWritePermissions): text
 * channels need SEND_MESSAGES, Calls channels need VIEW_CHANNEL | CONNECT.
 *
 * A member who fails it (read-only announcement channel, a mute, a role edit)
 * must never attempt a mint: rotateChannelKey installs a key LOCALLY, the
 * server then 403s the epoch record, and the member is left holding an epoch
 * the server never heard of — one that can diverge from the real epoch-1 key
 * once a sender does mint it, and that blocks the request path because
 * "local >= latest" reads as "key held". They wait for a holder's
 * distribution instead (viewing needs only VIEW_CHANNEL).
 *
 * `undefined` permissions (not loaded yet) → true, preserving prior behaviour:
 * the server stays the authority and an unknown must not strand a channel.
 */
export function canMintChannelKey(kind: string, myPermissions: bigint | undefined): boolean {
    if (myPermissions === undefined) return true;
    const need = isCallsChannelKind(kind)
        ? Permissions.VIEW_CHANNEL | Permissions.CONNECT
        : Permissions.SEND_MESSAGES;
    return (myPermissions & need) === need;
}

export type ChannelEntryAction = 'clear_gate' | 'mint' | 'wait';

/**
 * Mint-vs-wait decision for opening a text channel. `latestEpoch` is the
 * server's authoritative `latest_epoch` for the channel — `undefined` means
 * unknown (e.g. a fallback GET failed) and is treated the same as ">0" here:
 * waiting is always safe (closed by shouldMintAfterKeyRequest below), while
 * blind-minting on "unknown" is not — a channel that genuinely already has
 * keys would have its epoch-1 arbitration "won" by a spurious local mint,
 * forcing every real holder through discard-and-request for nothing.
 */
export function decideChannelEntryAction(params: {
    localEpoch: number | null;
    latestEpoch: number | undefined;
}): ChannelEntryAction {
    if (params.localEpoch != null) return 'clear_gate';
    if (params.latestEpoch === 0) return 'mint';
    return 'wait';
}

/**
 * After filing a key request, the API's response tells us whether the
 * request can ever be answered: `latest_epoch === 0` means nobody has ever
 * minted a key for this channel, so no holder exists to answer it — mint
 * instead of waiting. `undefined` (an older API build without this field)
 * conservatively means "keep waiting", matching prior behavior.
 */
export function shouldMintAfterKeyRequest(latestEpoch: number | undefined): boolean {
    return latestEpoch === 0;
}

/** Split into chunks of `size` (the API caps key-handshake at 20 envelopes). */
export function chunkEnvelopes<T>(items: T[], size = 20): T[][] {
    if (size < 1) throw new Error('chunk size must be >= 1');
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * The `channel_key` ClientContent object wrapped inside each per-device
 * envelope. `client_msg_id` is deterministic per (channel, epoch, device) so
 * duplicate distributions dedupe naturally on the receiving side.
 */
export function buildChannelKeyContent(params: {
    channelId: string;
    epoch: number;
    keyB64: string;
    deviceId: string;
    rotationReason: string;
}) {
    return {
        client_msg_id: `ck-${params.channelId}-${params.epoch}-${params.deviceId}`,
        type: 'channel_key' as const,
        channel_id: params.channelId,
        epoch: params.epoch,
        key_b64: params.keyB64,
        rotates_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        rotation_reason: params.rotationReason,
    };
}

/**
 * Jitter before answering a `server:key_requested` push (500–3500 ms). All
 * online holders receive the event; the jitter spreads their re-check of the
 * pending list so the first responder's delivery marks the request fulfilled
 * and the rest stand down instead of POSTing duplicate envelope sets.
 */
export function pickJitterMs(): number {
    return 500 + Math.floor(Math.random() * 3000);
}

// ── Split-brain epoch arbitration (server-arbitrated fingerprints) ─────────
//
// Two devices can independently mint different keys for the same epoch
// (classic case: two members opening a brand-new channel at the same
// moment). The server's recordEpoch is an atomic INSERT ... ON CONFLICT that
// makes the first POST for a given epoch the winner; every caller gets back
// `{created, fingerprint_b64}` reflecting who actually won. These two pure
// functions turn that response (and, separately, a later repair sweep's
// epoch inventory) into a decision — the effectful IPC/HTTP calls live in
// Dashboard.tsx.

export type EpochClaimOutcome = 'won' | 'lost';

/**
 * Immediately after POSTing a freshly minted key's epoch + fingerprint,
 * decide whether this device's key is the one that should be distributed.
 */
export function resolveEpochClaim(params: {
    localFingerprintB64: string;
    created: boolean;
    serverFingerprintB64: string | null;
}): EpochClaimOutcome {
    if (params.created) return 'won';
    if (params.serverFingerprintB64 === params.localFingerprintB64) return 'won';
    return 'lost';
}

export interface ServerEpochInfo {
    epoch: number;
    fingerprint_b64: string | null;
    created_at: string;
}

export type EpochRepairAction = 'keep' | 'claim' | 'discard_and_request';

/**
 * Repair-sweep decision for ONE epoch this device already holds a key for,
 * given the server's arbitrated record (if any) for that same epoch.
 *   - No server row yet, or a null fingerprint → 'claim': POST our
 *     fingerprint so a divergence gets arbitrated instead of staying silent.
 *   - Server fingerprint matches ours → 'keep': nothing to do.
 *   - Server fingerprint differs → 'discard_and_request': we lost a race we
 *     never observed (e.g. offline when the winner claimed it, or the
 *     divergence predates this repair mechanism) — discard the local key
 *     and file a key request for the winner's.
 */
export function resolveEpochDivergence(
    localFingerprintB64: string,
    serverEpoch: ServerEpochInfo | undefined,
): EpochRepairAction {
    if (!serverEpoch || serverEpoch.fingerprint_b64 == null) return 'claim';
    return serverEpoch.fingerprint_b64 === localFingerprintB64 ? 'keep' : 'discard_and_request';
}

// Drop epoch gaps older than this — matches channel-keys.ts's pruneOldKeys
// horizon. Past this point, no holder keeps the key anymore either, so
// requesting it is a guaranteed-forever no-op that just spams the protocol.
const EPOCH_PRUNE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export interface EpochGapResult {
    /** Server-known epochs (within the prune horizon) this device doesn't hold. */
    missingEpochs: number[];
    /** True iff the channel's highest-numbered epoch is among missingEpochs —
     *  the ONLY case that should gate the composer. A device missing old
     *  history but holding the current epoch can still send. */
    missingLatest: boolean;
}

/**
 * Full-set missing-epoch detection for ONE channel — unlike
 * computeMissingKeyChannels (which only compares the highest epoch number),
 * this flags a device holding epoch 5 but not 1–4: "can't read old
 * messages" would otherwise persist forever with the composer fully enabled
 * and no request ever filed for the gap.
 */
// ── Event-burst coalescing ──────────────────────────────────────────────────
//
// useRealtime queues server:key_requested / server:channel_key_envelopes_ready
// as append-only arrays rather than a single nullable slot — a distributor or
// requester firing several of these in a loop can land more than one in the
// same React batch, and a single-slot setState only keeps the last, silently
// dropping every earlier one. These two pure functions turn a drained batch
// into "what to actually do" so the Dashboard effects stay thin.

/**
 * Which servers need a serveKeyRequests() call for this batch of
 * server:key_requested events, excluding the caller's own asks (their other
 * devices don't need to answer their own device's request).
 */
export function coalesceKeyRequestEvents(
    events: { server_id: string; requester_device_id: string }[],
    ownDeviceId: string | null,
): string[] {
    const serverIds = new Set(
        events
            .filter(e => e.requester_device_id !== ownDeviceId)
            .map(e => e.server_id),
    );
    return [...serverIds];
}

export interface EnvelopesReadyBatch {
    /** Distinct servers to pull pending envelopes from (pulling is server-wide). */
    serverIds: string[];
    /** Distinct channels to clear the composer gate for / invalidate the cache of. */
    channelIds: string[];
}

/**
 * Groups a batch of server:channel_key_envelopes_ready events into the
 * distinct servers to pull and channels to reconcile — every channel in the
 * batch, not just the last one a single-slot version would have kept.
 */
export function coalesceEnvelopesReadyEvents(
    events: { server_id: string; channel_id: string }[],
): EnvelopesReadyBatch {
    return {
        serverIds: [...new Set(events.map(e => e.server_id))],
        channelIds: [...new Set(events.map(e => e.channel_id))],
    };
}

export type EnvelopesReadyAction = 'ignore' | 'refetch';

export interface EnvelopesReadyChannelState {
    /** Did this device hold ANY key for the channel before pullChannelKeys ran? */
    heldKeyBefore: boolean;
    /** Does it hold one now, after the pull? */
    heldKeyAfter: boolean;
    /** Does the locally cached thread still contain "couldn't decrypt"
     *  placeholders that a re-fetch could now resolve? */
    hasUndecryptableCached: boolean;
}

/**
 * What a `server:channel_key_envelopes_ready` push means for ONE channel on
 * THIS device.
 *
 * The server addresses envelopes to specific devices but notifies the
 * recipient USER — gateway.notifyChannelKeyEnvelopesReady →
 * broadcastToUsers([recipient_user_id]) — so every one of that user's sockets
 * is woken for envelopes addressed to a single sibling device. Verified live
 * against the dev API: a device that already held the key, was not in the
 * envelope list, and had a fully decrypted thread on screen still received
 * the frame.
 *
 * That made the old handler's unconditional `delete channelMessages[id]` fire
 * on devices with nothing wrong: the thread rendered empty (the loading flag
 * is only armed on a channel's FIRST visit), then repopulated when the
 * catch-up fetch landed. Because a served key request stays `fulfilled_at IS
 * NULL` until the recipient ACKs, holders re-serve it on every retry tick and
 * every reconnect, so the wipe/refill repeated — the reported flicker.
 *
 * Rules:
 *   - Gained a key we didn't have → 'refetch': history that was undecryptable
 *     may decrypt now.
 *   - Still holding placeholders → 'refetch': a re-serve may have delivered a
 *     missing older epoch.
 *   - Otherwise → 'ignore': the envelopes were for a different device and this
 *     device's cache is already correct. Touching it can only cause flicker.
 *
 * Note what is NOT here: dropping cached rows. The catch-up merge upgrades an
 * undecryptable placeholder in place once the row decrypts, so invalidating
 * the cache was never needed to heal one — and it actively lost messages
 * older than the API's 50-row window, which a re-fetch cannot bring back.
 */
export function decideEnvelopesReadyAction(
    state: EnvelopesReadyChannelState,
): EnvelopesReadyAction {
    if (!state.heldKeyBefore && state.heldKeyAfter) return 'refetch';
    if (state.hasUndecryptableCached) return 'refetch';
    return 'ignore';
}

export function computeMissingEpochsForChannel(
    serverEpochs: ServerEpochInfo[],
    localEpochs: number[],
    nowMs: number,
): EpochGapResult {
    const localSet = new Set(localEpochs);
    const latestEpoch = serverEpochs.length ? Math.max(...serverEpochs.map(e => e.epoch)) : 0;
    const missingEpochs = serverEpochs
        .filter(e => nowMs - Date.parse(e.created_at) < EPOCH_PRUNE_HORIZON_MS)
        .map(e => e.epoch)
        .filter(epoch => !localSet.has(epoch));
    return {
        missingEpochs,
        missingLatest: latestEpoch > 0 && missingEpochs.includes(latestEpoch),
    };
}

// ── Phase 4c: idempotent-envelope retry bound (RC-8) ────────────────────────
//
// Server-side, submitHandshake now upserts (see channel-key-handshakes.
// service.ts) so envelope_id survives redistribution instead of churning on
// every retry — the give-up counter below can actually converge. Keying it
// on (channel_id, epoch) rather than envelope_id is a defensive extra on top
// of that server fix, not a replacement for it: what the client is really
// bounding is "attempts to install THIS epoch for THIS channel", which is
// the meaningful unit even in the (now much rarer) case of a genuinely new
// envelope_id turning up for the same epoch.

/** Attempts before pullChannelKeys gives up on installing a specific
 *  (channel, epoch) and starts cooling off instead of retrying forever. */
export const CHANNEL_KEY_RETRY_LIMIT = 3;

/** How long to suppress re-filing a key request for a channel after giving
 *  up on it — long enough for an unrelated redistribution (a different
 *  member coming online, a permission change) to land and be tried fresh,
 *  short enough the user isn't stuck indefinitely if it's genuinely broken. */
export const CHANNEL_KEY_COOL_OFF_MS = 10 * 60 * 1000;

/** Natural key for the per-envelope retry counter. */
export function channelEpochKey(channelId: string, epoch: number): string {
    return `${channelId}:${epoch}`;
}

export function shouldGiveUpOnChannelKey(failCount: number): boolean {
    return failCount >= CHANNEL_KEY_RETRY_LIMIT;
}

export function computeCoolOffUntil(nowMs: number): number {
    return nowMs + CHANNEL_KEY_COOL_OFF_MS;
}

/** True while a channel is within its post-give-up cool-off window. */
export function isCoolingOff(coolOffUntilMs: number | undefined, nowMs: number): boolean {
    return coolOffUntilMs != null && nowMs < coolOffUntilMs;
}

// ── RC-10: pinned / historical epoch distribution ──────────────────────────
//
// member_joined and serveKeyRequests distribute every epoch this device
// holds locally (electron/e2ee-engine's listChannelEpochs) — a pinned epoch
// is covered automatically IF this device still holds it. The gap is a
// pinned epoch NEITHER this device nor (as far as it can tell) anyone else
// still holds, typically because pruneOldKeys dropped it before the
// protected_epochs mechanism existed, or before this device ever learned it
// was pinned. This can't be fixed by distributing something we don't have —
// the fix is visibility (log it) plus channelKeyDistribution's actual
// prevention (setProtectedEpochs stops the drop happening again).

export interface EpochDistributionPlan {
    /** Epochs to actually send — bounded by what we hold; we can't distribute a key we don't have. */
    toDistribute: number[];
    /** Required epochs (pinned, plus the channel's latest if known) NOT in `held` —
     *  nobody can serve these from this device; log at error level. */
    unservable: number[];
}

/**
 * `held` — this device's full local epoch set for the channel.
 * `pinned` — epochs GET /pinned-epochs says are referenced by an active pin.
 * `latest` — the channel's current epoch, if known (undefined when unknown —
 *   e.g. the caller didn't fetch it for this call). Included in the
 *   required set because a missing latest epoch is at least as serious as a
 *   missing pinned one (it blocks current messages, not just history).
 */
export function computeEpochsToDistribute(
    held: number[],
    pinned: number[],
    latest: number | undefined,
): EpochDistributionPlan {
    const heldSet = new Set(held);
    const required = new Set(pinned);
    if (latest != null) required.add(latest);
    const unservable = [...required].filter(e => !heldSet.has(e)).sort((a, b) => a - b);
    return {
        toDistribute: [...held].sort((a, b) => a - b),
        unservable,
    };
}

// ── Calls-channel Sender-Key rotation (server:channel_key_rotation_needed) ──
//
// The server pushes this when a member LOSES access to a Calls channel
// (kind 'huddle' / legacy 'voice'): a role edit, a channel/category override, a
// kick, a ban, or a leave. See gateway.notifyCallsChannelKeyRotationNeeded and
// channel-key-handshakes.service's signalRotationForLostAccess.
//
// Why the CLIENT does the rotation: a Calls channel's Sender Key DERIVES the
// LiveKit room key (utils/voiceChannelKey.ts), and the server never sees key
// material — it can only detect the demotion and signal. Remaining holders mint
// the next epoch, register it, and redistribute to the post-change authorized
// set. That set excludes the demoted member because getChannelRecipientDevices
// filters through viewersOf → requiredKeyPermissions → VIEW_CHANNEL|CONNECT for
// Calls channels (verified against the resolver, not assumed).
//
// What rotation does and does NOT buy: the load-bearing control is that the
// server independently refuses a demoted member a LiveKit token, so they cannot
// join. Rotation BOUNDS the key material they retain — without it they keep a
// working room key for the current epoch indefinitely and could decrypt
// captured media. It cannot un-see anything they already decrypted.
//
// Everything below is pure, so the decisions are unit-testable without React,
// Electron IPC, or a live gateway. The effectful half is Dashboard's
// rotateCallsChannelKey.

export interface ChannelKeyRotationEvent {
    server_id: string;
    channel_id: string;
    reason: string;
}

/** Reasons the API actually emits (signalRotationForLostAccess's default, plus
 *  the kick/ban/leave callers). Anything else is a newer or malformed server
 *  build: normalize rather than write an unrecognized string into the
 *  `rotation_reason` column. */
export const ROTATION_REASONS = ['permission_change', 'member_removed'] as const;

export function normalizeRotationReason(reason: string | null | undefined): string {
    return (ROTATION_REASONS as readonly string[]).includes(reason ?? '')
        ? (reason as string)
        : 'permission_change';
}

/**
 * The `rotation_reason` to RECORD with the server for a lost-access rotation.
 * The signal's own vocabulary (`permission_change` / `member_removed`, kept in
 * the encrypted channel_key content) is NOT in RecordEpochDto's allowlist
 * (apps/api/src/servers/dto/server.dto.ts), so posting it 400'd on every
 * attempt and the desktop discarded the new key — desktop never completed a
 * lost-access rotation. Same mapping mobile uses (epochReasonForRotationSignal
 * in cipherline-mobile's channelKeys/decisions.ts).
 */
export function epochReasonForRotationSignal(reason: string | null | undefined): 'role_perm_changed' | 'member_left' {
    return normalizeRotationReason(reason) === 'member_removed' ? 'member_left' : 'role_perm_changed';
}

/**
 * One entry per CHANNEL for a drained batch. An admin editing several roles in
 * a row — or one role deletion that demotes many members at once — produces a
 * storm of these for the same channel. Rotating per event would mint an epoch
 * per event and re-run the whole member×device fan-out each time for no extra
 * security: only the last rotation matters.
 *
 * Last-wins on the reason — a later event is the more current cause.
 */
export function coalesceRotationEvents<T extends ChannelKeyRotationEvent>(events: T[]): T[] {
    const byChannel = new Map<string, T>();
    for (const e of events) byChannel.set(e.channel_id, e);
    return [...byChannel.values()];
}

export type RotationDecision =
    /** Mint + register + redistribute the next epoch. */
    | 'rotate'
    /** Not in this device's loaded channel list: we can't confirm it's a Calls
     *  channel, and in the common case we can't see it at all. Some other
     *  member of the (server-filtered) audience covers it. */
    | 'skip_unknown_channel'
    /** Known, but not a keyed channel at all (no Sender Key exists for it), so
     *  there is nothing to rotate. Text and Calls channels BOTH rotate as of
     *  C6 — see decideRotationAction. */
    | 'skip_not_keyed_channel'
    /** We hold no key for this channel: nothing to rotate from, nothing to
     *  distribute. Another holder in the audience does. */
    | 'skip_no_local_key';

/**
 * `channelKind` is the kind from this device's loaded channel list, or
 * null/undefined when the channel isn't in it.
 *
 * C6 — this used to refuse anything that was not a Calls channel. That mirrored
 * a server that only ever signalled Calls channels, and it is HALF of why text
 * channels never rotated: even once the server started asking, an un-updated
 * client would answer `skip_not_calls_channel`. The gate is now "does this kind
 * carry a Sender Key at all", which admits text.
 *
 * The check is still not merely trusting the server — it is the same
 * defence-in-depth as before, just at the correct boundary. A signal naming a
 * channel that carries no key, or one this device does not know, is still
 * refused rather than acted on.
 */
export function decideRotationAction(state: {
    channelKind: string | null | undefined;
    holdsLocalKey: boolean;
}): RotationDecision {
    if (state.channelKind == null) return 'skip_unknown_channel';
    if (!channelCarriesSenderKeys(state.channelKind)) return 'skip_not_keyed_channel';
    if (!state.holdsLocalKey) return 'skip_no_local_key';
    return 'rotate';
}

export type RotationScheduleAction =
    /** Nothing pending for this channel — arm a jittered timer. */
    | 'arm'
    /** A timer is already armed; this event rides it (no second rotation). */
    | 'ride'
    /** A rotation is mid-flight and cannot possibly account for this event's
     *  demotion. Queue exactly ONE follow-up for when it finishes. */
    | 'queue_followup';

/**
 * Why 'queue_followup' exists rather than dropping an event that lands during
 * an in-flight rotation: that rotation snapshotted its recipient list BEFORE
 * this event's demotion was applied, so the member demoted by THIS event may
 * have just been handed the brand-new epoch. Dropping it would leave the
 * last-demoted member holding a live key — exactly the gap this mechanism
 * exists to close. One trailing rotation suffices however many events land.
 */
export function decideRotationScheduling(state: {
    armed: boolean;
    inFlight: boolean;
}): RotationScheduleAction {
    if (state.inFlight) return 'queue_followup';
    if (state.armed) return 'ride';
    return 'arm';
}

/**
 * The epoch to mint, or null to stand down.
 *
 * Takes the max of the server's arbitrated latest and our local latest:
 * (localLatest + 1) alone loses to a rotation that already landed server-side
 * but whose envelopes haven't reached us; (serverLatest + 1) alone can re-mint
 * a number we already hold.
 *
 * `serverLatest === 0` means the channel was never bootstrapped anywhere.
 * Holding a local key for a channel the server says has no epochs is an
 * inconsistent state owned by the bootstrap/repair sweep, not by rotation —
 * stand down rather than mint into it.
 */
export function computeRotationEpoch(
    serverLatest: number,
    localLatest: number | null,
): number | null {
    if (localLatest == null) return null;
    if (serverLatest < 1) return null;
    return Math.max(serverLatest, localLatest) + 1;
}

export type RotationOutcome =
    /** We own this epoch — hand it to the post-change recipient set. */
    | 'distribute'
    /** Another holder minted this epoch first: drop ours, ask for theirs. */
    | 'discard_and_request'
    /** recordEpoch never succeeded, so nobody but us knows this key exists. */
    | 'discard_only';

/**
 * Unlike the bootstrap mint — which KEEPS an unregistered key, because no other
 * key exists and it's still usable for our own sends — a rotation that fails to
 * register must DISCARD. The previous epoch is still valid and still in use by
 * everyone else; an unregistered higher epoch would make useCallsChannelKey
 * publish under material no other participant has or can ever request, leaving
 * us undecryptable to the whole call until a repair sweep noticed. Falling back
 * to the pre-existing key is exactly today's behaviour: a no-op, not a
 * regression.
 */
export function resolveRotationClaim(params: {
    claim: { created: boolean; fingerprint_b64: string | null } | null;
    localFingerprintB64: string;
}): RotationOutcome {
    if (!params.claim) return 'discard_only';
    return resolveEpochClaim({
        localFingerprintB64: params.localFingerprintB64,
        created: params.claim.created,
        serverFingerprintB64: params.claim.fingerprint_b64,
    }) === 'won'
        ? 'distribute'
        : 'discard_and_request';
}
