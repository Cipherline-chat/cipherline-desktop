/**
 * Call-key sharing: the decisions behind "anyone who holds the call's media
 * key can hand it to a joiner", kept pure so they are testable without React.
 *
 * ## Why
 *
 * A DM/group call's E2EE key used to reach a device exactly once, in the
 * initiator's `call_key` broadcast at call start (and again on rotation). A
 * device that was not in the conversation's device list at that moment, was
 * offline for it, or lost its in-memory key (app restart, a second device, a
 * member added to a group mid-call) had no way to get the key and sat on the
 * "securing call" gate for good.
 *
 * ## The protocol (all inside the ordinary E2EE message channel)
 *
 *   1. REQUEST. A device that joins a call without an accepted key sends
 *      `call_key_request { call_id }` to the conversation, re-sending every
 *      {@link CALL_KEY_REQUEST_RETRY_MS} up to {@link CALL_KEY_REQUEST_MAX_SENDS}
 *      times. It also sends one (throttled) when the call's E2EE layer reports
 *      it cannot decrypt a remote participant's media.
 *   2. RESPOND. A device that is connected to that call AND holds an accepted
 *      key answers with an ordinary `call_key` carrying the SAME key at its
 *      CURRENT epoch (`key_id: 'share'`), after a random jitter so a room full
 *      of holders does not all answer at once, addressed only to the
 *      requester's own devices. At most one answer per (call, requesting
 *      device) per {@link CALL_KEY_RESPONSE_WINDOW_MS}.
 *   3. ACCEPT. The requester feeds it to `CallKeyStore.recordRemote`, which
 *      accepts a first key from any trusted member (utils/callKeyStore.ts).
 *   4. ROTATE. The initiator rotates while connected; otherwise the connected
 *      participant with the lowest user id does ({@link chooseRotator}).
 *   5. NOBODY CAN ANSWER. A joiner still keyless after the retries, and alone
 *      in the call, may mint a fresh key ({@link shouldMintSoloKey}). With
 *      remote participants present it never does: it keeps waiting, because a
 *      minted key would split the call.
 *
 * Nothing here ever builds or joins a room unencrypted: the gate that blocks
 * CallPane while keyless (utils/callKeyGate.ts) is untouched.
 */

/** First request goes out this long after the keyless join — a key already in flight usually beats it. */
export const CALL_KEY_REQUEST_FIRST_DELAY_MS = 1_000;
/** Gap between re-sends while still keyless. */
export const CALL_KEY_REQUEST_RETRY_MS = 4_000;
/** Total requests per keyless stretch (the first plus retries). */
export const CALL_KEY_REQUEST_MAX_SENDS = 5;
/** A decryption-failure triggered request is sent at most this often. */
export const CALL_KEY_DECRYPT_REQUEST_MIN_GAP_MS = 10_000;
/** A holder answers a given (call, requesting device) at most once per this window. */
export const CALL_KEY_RESPONSE_WINDOW_MS = 10_000;
/** Random delay before answering, 0..this. */
export const CALL_KEY_RESPONSE_JITTER_MAX_MS = 1_500;
/** Wait after the last request before a lone joiner may mint (~20 s keyless in all). */
export const CALL_KEY_SOLO_MINT_AFTER_MS =
    CALL_KEY_REQUEST_FIRST_DELAY_MS + (CALL_KEY_REQUEST_MAX_SENDS - 1) * CALL_KEY_REQUEST_RETRY_MS + CALL_KEY_REQUEST_RETRY_MS;
/** A non-primary rotator waits this long past the due time, so the initiator (or whoever the others think is primary) wins the race. */
export const CALL_KEY_ROTATION_GRACE_MS = 15_000;
/** `key_id` of a key handed to a requester. */
export const CALL_KEY_ID_SHARE = 'share';
/** `key_id` of a key minted by a lone joiner. */
export const CALL_KEY_ID_MINT = 'mint';

// ── Requesting ──────────────────────────────────────────────────────────────

/**
 * Delay before the next request, given how many have been sent in this keyless
 * stretch; null = stop requesting.
 */
export function nextRequestDelayMs(sentSoFar: number): number | null {
    if (sentSoFar >= CALL_KEY_REQUEST_MAX_SENDS) return null;
    return sentSoFar === 0 ? CALL_KEY_REQUEST_FIRST_DELAY_MS : CALL_KEY_REQUEST_RETRY_MS;
}

/** Gate for the decryption-failure triggered request: once per {@link CALL_KEY_DECRYPT_REQUEST_MIN_GAP_MS}. */
export class MinGapGate {
    private last = Number.NEGATIVE_INFINITY;
    private readonly gapMs: number;
    constructor(gapMs: number) { this.gapMs = gapMs; }
    /** true = go ahead (and the gap restarts now). */
    tryPass(nowMs: number): boolean {
        if (nowMs - this.last < this.gapMs) return false;
        this.last = nowMs;
        return true;
    }
    reset(): void { this.last = Number.NEGATIVE_INFINITY; }
}

export interface KeyRequestContent { type: 'call_key_request'; call_id: string; client_msg_id: string }
export function buildKeyRequest(callId: string, clientMsgId: string): KeyRequestContent {
    return { client_msg_id: clientMsgId, type: 'call_key_request', call_id: callId };
}

// ── Responding ──────────────────────────────────────────────────────────────

export type RespondRefusal =
    | 'not_connected'    // we are not in that call right now
    | 'no_accepted_key'  // we hold no accepted key for it
    | 'untrusted'        // the sender-trust gate refused the requester
    | 'not_member'       // a known non-member of the conversation
    | 'self_device'      // our own request echoed back
    | 'rate_limited';    // already answered this device recently

export type RespondDecision = { respond: true } | { respond: false; reason: RespondRefusal };

/**
 * Whether to answer a `call_key_request`. Order matters only for the reason
 * reported; every refusal is silent on the wire.
 */
export function decideKeyRequestResponse(input: {
    /** The call this device is currently CONNECTED to (null = none). */
    connectedCallId: string | null;
    requestedCallId: string;
    /** Do we hold an accepted (epoch >= 1) key for the call in this conversation? */
    holdsAcceptedKey: boolean;
    /** `actionFor(verdict, 'key_material') === 'accept'` for the requester. */
    senderTrusted: boolean;
    /** false = known non-member; true/undefined = member or not knowable here. */
    requesterIsMember: boolean | undefined;
    requesterDeviceId: string | null | undefined;
    myDeviceId: string | null | undefined;
    nowMs: number;
    limiter: KeyResponseLimiter;
}): RespondDecision {
    if (input.requesterDeviceId && input.requesterDeviceId === input.myDeviceId) return { respond: false, reason: 'self_device' };
    if (!input.connectedCallId || input.connectedCallId !== input.requestedCallId) return { respond: false, reason: 'not_connected' };
    if (!input.holdsAcceptedKey) return { respond: false, reason: 'no_accepted_key' };
    if (!input.senderTrusted) return { respond: false, reason: 'untrusted' };
    if (input.requesterIsMember === false) return { respond: false, reason: 'not_member' };
    // Last, so a refused request never consumes the window.
    if (!input.limiter.tryAcquire(input.requestedCallId, input.requesterDeviceId ?? '', input.nowMs)) {
        return { respond: false, reason: 'rate_limited' };
    }
    return { respond: true };
}

/** At most one answer per (call, requesting device) per window. Bounded. */
export class KeyResponseLimiter {
    private readonly last = new Map<string, number>();
    private readonly windowMs: number;
    private readonly maxEntries: number;
    constructor(windowMs: number = CALL_KEY_RESPONSE_WINDOW_MS, maxEntries: number = 256) {
        this.windowMs = windowMs;
        this.maxEntries = maxEntries;
    }
    tryAcquire(callId: string, requesterDeviceId: string, nowMs: number): boolean {
        const k = `${callId}\u0000${requesterDeviceId}`;
        const prev = this.last.get(k);
        if (prev !== undefined && nowMs - prev < this.windowMs) return false;
        if (this.last.size >= this.maxEntries) this.prune(nowMs);
        this.last.set(k, nowMs);
        return true;
    }
    private prune(nowMs: number): void {
        for (const [k, t] of this.last) if (nowMs - t >= this.windowMs) this.last.delete(k);
        // Still full of live entries (a flood): drop the oldest so the map stays bounded.
        while (this.last.size >= this.maxEntries) {
            const oldest = this.last.keys().next().value;
            if (oldest === undefined) break;
            this.last.delete(oldest);
        }
    }
}

/** Random answer delay in [0, CALL_KEY_RESPONSE_JITTER_MAX_MS). `random` in [0,1). */
export function responseJitterMs(random: number = Math.random()): number {
    const r = Number.isFinite(random) ? Math.min(Math.max(random, 0), 0.999999) : 0;
    return Math.floor(r * CALL_KEY_RESPONSE_JITTER_MAX_MS);
}

/** Recipients of an answer: only the requesting USER's devices, never anyone else's. */
export function devicesOfUser<T extends { user_id?: string | null }>(devices: readonly T[], userId: string): T[] {
    if (!userId) return [];
    return devices.filter(d => d.user_id === userId);
}

/** The devices belonging to any of `userIds` (a device with no user id never matches). */
export function devicesOfUsers<T extends { user_id?: string | null }>(devices: readonly T[], userIds: readonly string[]): T[] {
    const want = new Set(userIds.filter(Boolean));
    if (want.size === 0) return [];
    return devices.filter(d => !!d.user_id && want.has(d.user_id));
}

/**
 * Who a `call_key_request` is addressed to: only the users the server reports
 * as connected to the call — the only ones who can answer it. Released builds
 * (1.0.22 and earlier) render an unknown control type as a visible
 * "Unsupported message variant" row, so a request sent to the whole
 * conversation would leave that row with every member, in the call or not.
 * Returns [] when the status is unusable or nobody is connected (nothing to
 * ask; the solo-mint path covers an empty call).
 */
export function keyRequestRecipientUserIds(status: unknown): string[] {
    if (!status || typeof status !== 'object') return [];
    const s = status as { active?: unknown; participant_ids?: unknown };
    if (s.active !== true || !Array.isArray(s.participant_ids)) return [];
    return Array.from(new Set(s.participant_ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256)));
}

export interface ShareContent {
    client_msg_id: string;
    type: 'call_key';
    call_id: string;
    epoch: number;
    e2ee_key_b64: string;
    key_id: typeof CALL_KEY_ID_SHARE;
    rotates_at: string;
}
/** The answer: the held key, unchanged, at its current epoch. */
export function buildShareContent(input: {
    callId: string;
    keyB64: string;
    epoch: number;
    /** When the held epoch is due to be replaced; the answer carries it through. */
    rotatesAtMs: number | null;
    nowMs: number;
    clientMsgId: string;
    rotationMs: number;
}): ShareContent {
    const rotates = input.rotatesAtMs !== null && input.rotatesAtMs > input.nowMs ? input.rotatesAtMs : input.nowMs + input.rotationMs;
    return {
        client_msg_id: input.clientMsgId,
        type: 'call_key',
        call_id: input.callId,
        epoch: input.epoch,
        e2ee_key_b64: input.keyB64,
        key_id: CALL_KEY_ID_SHARE,
        rotates_at: new Date(rotates).toISOString(),
    };
}

// ── Rotation duty ───────────────────────────────────────────────────────────

export interface RotatorChoice {
    /** Who should rotate, by this device's view; null = nobody can be chosen. */
    userId: string | null;
    /** true when the choice is the initiator (rotates on time); false = a fallback (waits out the grace). */
    primary: boolean;
}

/**
 * The initiator rotates while connected to the call; when they are not, the
 * connected participant with the lexicographically lowest user id does.
 * `connectedUserIds` are the LiveKit participant identities (user ids) of the
 * room, local participant included; this device's own id is always counted.
 */
export function chooseRotator(input: {
    selfUserId: string;
    /** This device started the call. */
    selfIsInitiator: boolean;
    /** The initiator's user id when this device learned it (`initial` broadcast). */
    knownInitiatorUserId: string | null;
    connectedUserIds: readonly string[];
}): RotatorChoice {
    const present = new Set(input.connectedUserIds.filter(Boolean));
    if (input.selfUserId) present.add(input.selfUserId);
    const initiator = input.selfIsInitiator ? input.selfUserId : input.knownInitiatorUserId;
    if (initiator && present.has(initiator)) return { userId: initiator, primary: true };
    let lowest: string | null = null;
    for (const id of present) if (lowest === null || id < lowest) lowest = id;
    return { userId: lowest, primary: false };
}

/** Whether this device should rotate now. */
export function isRotationDue(input: {
    selfUserId: string;
    choice: RotatorChoice;
    rotatesAtMs: number | null;
    nowMs: number;
    graceMs?: number;
}): boolean {
    if (input.choice.userId !== input.selfUserId) return false;
    if (input.rotatesAtMs === null) return false;
    const grace = input.choice.primary ? 0 : (input.graceMs ?? CALL_KEY_ROTATION_GRACE_MS);
    return input.nowMs >= input.rotatesAtMs + grace;
}

// ── Nobody can answer ───────────────────────────────────────────────────────

/**
 * May a keyless joiner mint a fresh key? Only when it has stayed keyless past
 * the retries AND the call's server status positively says the room is empty.
 * Unknown status (error, not fetched), a live call with participants, or an
 * ended call all answer no — a minted key in a room with other people would
 * split it, and "wait" is always safe.
 */
export function shouldMintSoloKey(input: {
    stillKeyless: boolean;
    keylessForMs: number;
    status: { active?: boolean; participants?: number; participant_ids?: unknown; error?: boolean } | null | undefined;
}): boolean {
    if (!input.stillKeyless) return false;
    if (input.keylessForMs < CALL_KEY_SOLO_MINT_AFTER_MS) return false;
    const s = input.status;
    if (!s || s.error || s.active !== true) return false;
    if (s.participants !== 0) return false;
    if (Array.isArray(s.participant_ids) && s.participant_ids.length > 0) return false;
    return true;
}

/** The epoch a minted key is recorded at: one past the highest seen for the call, never below 2. */
export function mintEpoch(highestSeenEpoch: number): number {
    return Math.max(highestSeenEpoch, 1) + 1;
}

// ── Decryption-failure trigger ──────────────────────────────────────────────

/** livekit-client `CryptorErrorReason` (InvalidKey = 0, MissingKey = 1, InternalError = 2). */
const CRYPTOR_REASON_INVALID_KEY = 0;
const CRYPTOR_REASON_MISSING_KEY = 1;

/**
 * Is this the room's `EncryptionError` for "I cannot decrypt someone's media"
 * (wrong or missing key), as opposed to an internal worker fault? Only the
 * former is cured by getting the key again.
 */
export function isDecryptKeyFailure(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const reason = (err as { reason?: unknown }).reason;
    return reason === CRYPTOR_REASON_INVALID_KEY || reason === CRYPTOR_REASON_MISSING_KEY;
}
