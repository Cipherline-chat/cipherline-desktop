/**
 * Crash-recovery "Rejoin call?" — the pure decision logic.
 *
 * When the renderer dies mid-call, electron/main.ts reloads it in place (see
 * crashLoopPolicy.ts). The reload wipes React state, so the user lands back in
 * the app with the call gone — even though everyone else is still in it and
 * LiveKit/the API would happily let them back in. This module decides what the
 * renderer should remember while a call is live, whether that memory is still
 * trustworthy after a restart, and what to say about it. Everything impure
 * (secureLocalStore, axios, React) lives in callRejoinStore.ts / Dashboard.tsx
 * so the interesting rules can be tested without a browser.
 *
 * What is remembered, and why it is safe to:
 *   • The call's identity (session id + which kind of call + where it lives).
 *     Metadata the device already holds; stored per account in the encrypted
 *     secureLocalStore like every other persisted client state.
 *   • For DM/group calls ONLY, the call's E2EE key. This is the one sensitive
 *     field and the reason this module is stricter than a bookmark would be:
 *     a DM call key arrives once, inside a `call_key` message the server then
 *     deletes (poll-then-ACK), and the starting device never receives its own
 *     key back. After a reload there is NO other way to re-enter the call
 *     without it — the key gate refuses to connect keyless on purpose, so a
 *     rejoin without it would just dead-end. Calls-channel calls (voice
 *     channels, huddles) derive their key from the channel's Sender Key and
 *     never persist one.
 *   • NEVER a LiveKit token. Rejoining mints a fresh one through the normal
 *     join endpoint, which re-checks membership/permissions server-side.
 *
 * Bounded lifetime: the record is rewritten every HEARTBEAT_MS while a call is
 * live, deleted the moment the call ends by any path, and ignored (and
 * deleted) at startup once it is older than MAX_DESCRIPTOR_AGE_MS. A crash
 * reload takes seconds, so the window is generous for a recovery and short
 * enough that a stale key never lingers on disk.
 */

export type RejoinKind = 'dm' | 'voice' | 'huddle';

export const DESCRIPTOR_VERSION = 1;

/** How often the live call refreshes its `lastSeen`. */
export const HEARTBEAT_MS = 30_000;
/** A descriptor older than this (5 missed heartbeats) is not a crash — it is a
 *  call that ended some other way, or a quit long ago. */
export const MAX_DESCRIPTOR_AGE_MS = 150_000;
/** Tolerance for the wall clock having stepped backwards (NTP, resume). A
 *  `lastSeen` further in the future than this is not trusted. */
export const MAX_CLOCK_SKEW_MS = 60_000;
/** How long the startup status check keeps retrying an inconclusive answer
 *  (network not back yet) before giving up. Mirrors callStalenessPolicy. */
export const STATUS_GRACE_MS = 30_000;
export const STATUS_RETRY_MS = 3_000;

const MAX_ID_LEN = 128;
const MAX_TITLE_LEN = 120;
const MAX_KEY_LEN = 256;

export interface CallRejoinDescriptor {
    v: typeof DESCRIPTOR_VERSION;
    kind: RejoinKind;
    /** call_sessions.id — the same id for all three kinds (see Dashboard's
     *  activeCall.id and GET /v1/calls/:id/status). */
    sessionId: string;
    /** DM/group only: the conversation the call lives in. */
    conversationId?: string;
    /** voice: the voice channel id. huddle: the huddle channel id. */
    channelId?: string;
    /** Display name for the prompt — channel name, or conversation title. */
    title: string;
    /** DM/group only: the call's E2EE key (base64). See the module doc. */
    callKeyB64?: string;
    startedAt: number;
    lastSeen: number;
}

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isBoundedString = (s: unknown, max: number): s is string =>
    typeof s === 'string' && s.length > 0 && s.length <= max;

/**
 * Strictly parse a stored descriptor. Returns null for anything that is not
 * exactly a well-formed, current-version record — a corrupt or hand-edited
 * value must degrade to "no rejoin offer", never to an exception at startup
 * or a half-valid call being joined. Unknown fields are dropped.
 */
export function parseDescriptor(raw: string | null | undefined): CallRejoinDescriptor | null {
    if (!raw) return null;
    let obj: unknown;
    try { obj = JSON.parse(raw); } catch { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const o = obj as Record<string, unknown>;

    if (o.v !== DESCRIPTOR_VERSION) return null;
    if (o.kind !== 'dm' && o.kind !== 'voice' && o.kind !== 'huddle') return null;
    if (!isBoundedString(o.sessionId, MAX_ID_LEN)) return null;
    if (!isFiniteNumber(o.startedAt) || !isFiniteNumber(o.lastSeen)) return null;

    const title = typeof o.title === 'string' ? o.title.slice(0, MAX_TITLE_LEN) : '';
    const base = { v: DESCRIPTOR_VERSION, sessionId: o.sessionId, title, startedAt: o.startedAt, lastSeen: o.lastSeen } as const;

    if (o.kind === 'dm') {
        // A DM/group call without its key cannot be rejoined (the key gate
        // refuses to connect keyless), so a record missing it is useless.
        if (!isBoundedString(o.conversationId, MAX_ID_LEN)) return null;
        if (!isBoundedString(o.callKeyB64, MAX_KEY_LEN)) return null;
        return { ...base, kind: 'dm', conversationId: o.conversationId, callKeyB64: o.callKeyB64 };
    }

    // Calls-channel calls must NEVER carry a key — if one is present the
    // record did not come from this module, so refuse it outright.
    if (o.callKeyB64 !== undefined) return null;
    if (!isBoundedString(o.channelId, MAX_ID_LEN)) return null;
    return { ...base, kind: o.kind, channelId: o.channelId };
}

/** Whether a stored descriptor is recent enough to be a crash, not history. */
export function isDescriptorFresh(d: CallRejoinDescriptor, now: number): boolean {
    const age = now - d.lastSeen;
    return age >= -MAX_CLOCK_SKEW_MS && age <= MAX_DESCRIPTOR_AGE_MS;
}

/** What Dashboard knows about the live call at write time. */
export interface ActiveCallSnapshot {
    call: {
        id: string;
        conversation_id?: string;
        callsChannelId?: string;
        voiceChannelName?: string;
    };
    activeVoiceChannelId: string | null;
    activeHuddleCallId: string | null;
    /** The DM/group key currently in use ('' while still waiting for it). */
    deliveredCallKeyB64: string;
    /** Conversation title for DM/group calls, '' when unknown. */
    conversationTitle: string;
}

/**
 * Turn the live call into the record to persist, or null when it must not be
 * persisted: a DM/group call whose key has not arrived yet (nothing useful to
 * restore, and we never write a record we could not rejoin from), or a
 * Calls-channel call whose kind cannot be established.
 *
 * `prev` carries `startedAt` forward across heartbeats for the same call.
 */
export function buildDescriptor(
    s: ActiveCallSnapshot,
    now: number,
    prev: CallRejoinDescriptor | null,
): CallRejoinDescriptor | null {
    if (!s.call.id) return null;
    const startedAt = prev && prev.sessionId === s.call.id ? prev.startedAt : now;

    if (s.call.callsChannelId) {
        const channelId = s.call.callsChannelId;
        const title = (s.call.voiceChannelName ?? '').slice(0, MAX_TITLE_LEN);
        // Huddle calls are identified by the huddle call id; voice channels by
        // the channel id. Dashboard sets exactly one of these per join path.
        if (s.activeHuddleCallId === s.call.id) {
            return { v: DESCRIPTOR_VERSION, kind: 'huddle', sessionId: s.call.id, channelId, title, startedAt, lastSeen: now };
        }
        if (s.activeVoiceChannelId === channelId) {
            return { v: DESCRIPTOR_VERSION, kind: 'voice', sessionId: s.call.id, channelId, title, startedAt, lastSeen: now };
        }
        return null;
    }

    if (!s.call.conversation_id || !s.deliveredCallKeyB64) return null;
    return {
        v: DESCRIPTOR_VERSION,
        kind: 'dm',
        sessionId: s.call.id,
        conversationId: s.call.conversation_id,
        title: s.conversationTitle.slice(0, MAX_TITLE_LEN),
        callKeyB64: s.deliveredCallKeyB64,
        startedAt,
        lastSeen: now,
    };
}

export type RejoinOfferDecision = 'offer' | 'discard' | 'retry';

/**
 * What to do with the answer to "is that call still going?".
 *
 * Only an explicit, successful answer decides: `active: true` → offer,
 * `active: false` → discard (the call ended while we were down, nothing to
 * rejoin). A failed/absent answer (null) is NOT evidence either way — right
 * after a restart the network is often not back yet — so it retries, and only
 * gives up (discarding, because an offer we cannot confirm is worse than none)
 * once the grace window is spent. Same stance as callStalenessPolicy.ts.
 */
export function decideRejoinOffer(
    status: { active: boolean } | null,
    elapsedMs: number,
    graceMs: number = STATUS_GRACE_MS,
): RejoinOfferDecision {
    if (status) return status.active ? 'offer' : 'discard';
    return elapsedMs < graceMs ? 'retry' : 'discard';
}

/** Copy for the prompt. */
export function describeRejoinTarget(d: Pick<CallRejoinDescriptor, 'kind' | 'title'>): string {
    const t = d.title.trim();
    switch (d.kind) {
        case 'dm': return t ? `a call with ${t}` : 'a call';
        case 'voice': return t ? `the voice channel ${t}` : 'a voice channel';
        case 'huddle': return t ? `the call in ${t}` : 'a call';
    }
}
