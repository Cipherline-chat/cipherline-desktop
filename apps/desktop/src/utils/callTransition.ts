/**
 * callTransition — the client half of "a moderator moved / disconnected you".
 *
 * ── The bug this exists for (owner report) ───────────────────────────────────
 * "When moving members around in calls it often completely disconnects them: it
 * almost always looks like they're disconnected, the call controls are gone, yet
 * they can talk and hear me. It also says they were kicked even though they were
 * moved."
 *
 * A move reached the client as two independent things racing each other:
 *   1. `huddle:force_move` over the app WebSocket (→ join the next call), and
 *   2. LiveKit's `Disconnected(PARTICIPANT_REMOVED)` on the OLD room, because the
 *      server evicted the member from it.
 * CallPane reported (2) as "you were removed by a moderator" and tore the call UI
 * down through the ordinary leave path — whichever order they arrived in, the
 * moved user was told they were kicked, and when (2) landed after (1) had put the
 * UI in the new call, the leave tore that down too: no activeCall / controls,
 * while the new LiveKit connection kept carrying audio.
 *
 * ── The fix, client side ─────────────────────────────────────────────────────
 * The server now sends `force_move` FIRST and removes the member from the old
 * room only if they are still in it after a grace period. This module is the
 * other half: a tiny "a transition is in progress" marker that is set
 * SYNCHRONOUSLY in the WebSocket handler (before React state, so it cannot lose
 * a race with the LiveKit event) and consulted by CallPane's disconnect handler.
 * A disconnect of the source room while the marker is set is PART OF the
 * transition — no "removed" message, no teardown — because the Dashboard flow is
 * already replacing (or deliberately ending) that call.
 *
 * Pure and framework-free so the whole contract is unit-testable; the Dashboard
 * and CallPane are thin callers.
 */

import { DisconnectReason } from 'livekit-client';
import { mapDisconnectReasonToUserMessage, type DisconnectMessage } from './callDisconnectReasons';

export type CallTransitionKind = 'move' | 'disconnect';

export interface CallTransition {
    kind: CallTransitionKind;
    /** The call being left. null = unknown (an older server did not say): then
     *  any call other than `toCallId` counts as the one being left. */
    fromCallId: string | null;
    /** The call being entered (moves only). */
    toCallId: string | null;
    /** When the marker stops applying even if nothing cleared it. */
    expiresAt: number;
}

/**
 * How long a transition marker stays armed. Generous: the server's own eviction
 * grace is 3 s, and the destination can take a while to connect on a bad
 * network. It is only a backstop so a marker that is never cleared (a
 * connection that failed before reporting) cannot swallow genuine disconnects
 * for the rest of the session.
 */
export const CALL_TRANSITION_TTL_MS = 20_000;

export interface CallTransitionTracker {
    begin(t: { kind: CallTransitionKind; fromCallId: string | null; toCallId: string | null }): void;
    /** Is a disconnect of `callId`'s room currently part of a move / disconnect? */
    isExpectedDisconnect(callId: string | null | undefined): boolean;
    /** Is a move INTO `callId` still waiting for its room to connect? */
    isMovePendingFor(callId: string | null | undefined): boolean;
    /** The room of `callId` reported Connected: a move into it is complete, and
     *  any pending disconnect marker is over. */
    markConnected(callId: string): void;
    clear(): void;
    /** Drop a MOVE marker only (the user left / the move failed); a pending
     *  disconnect marker keeps covering the server's fallback removal. */
    clearMove(): void;
    current(): CallTransition | null;
}

export function createCallTransitionTracker(now: () => number = Date.now): CallTransitionTracker {
    let t: CallTransition | null = null;
    const live = (): CallTransition | null => {
        if (t && now() >= t.expiresAt) t = null;
        return t;
    };
    return {
        begin({ kind, fromCallId, toCallId }) {
            t = { kind, fromCallId, toCallId, expiresAt: now() + CALL_TRANSITION_TTL_MS };
        },
        isExpectedDisconnect(callId) {
            const cur = live();
            if (!cur || !callId) return false;
            // Never the call we are moving INTO: a genuine failure there must
            // still reach the user.
            if (cur.toCallId && callId === cur.toCallId) return false;
            return cur.fromCallId === null ? true : cur.fromCallId === callId;
        },
        isMovePendingFor(callId) {
            const cur = live();
            return !!cur && cur.kind === 'move' && !!callId && cur.toCallId === callId;
        },
        markConnected(callId) {
            const cur = live();
            if (!cur) return;
            // A move is complete when its destination room connects. A
            // disconnect is over as soon as ANY room connects: that is the user
            // having moved on (a rejoin of the same call included), so a later
            // genuine removal must not be silenced by a stale marker.
            if (cur.kind === 'move' ? cur.toCallId === callId : true) t = null;
        },
        clear() { t = null; },
        clearMove() { if (t && t.kind === 'move') t = null; },
        current() { return live(); },
    };
}

/** The app-wide marker. Set from useRealtime's WS handler, read by CallPane / Dashboard. */
export const callTransitions: CallTransitionTracker = createCallTransitionTracker();

// ── What CallPane does with a LiveKit disconnect ─────────────────────────────

export interface DisconnectHandling {
    /** null = say nothing. */
    toast: DisconnectMessage | null;
    /** Run the ordinary "the call is over" teardown. */
    teardown: boolean;
}

/**
 * Decide what a LiveKit `Disconnected` on `callId`'s room means for the UI.
 *
 *  - CLIENT_INITIATED: the user (or our own switch) left — silent, but the
 *    ordinary teardown still runs exactly as before.
 *  - Any other reason while the room is the one a move / disconnect is leaving:
 *    part of the transition — silent, and NO teardown (the transition owns it).
 *  - Anything else: the existing reason → message mapping and teardown.
 */
export function decideDisconnectHandling(
    reason: DisconnectReason | undefined,
    callId: string | null | undefined,
    tracker: Pick<CallTransitionTracker, 'isExpectedDisconnect'> = callTransitions,
): DisconnectHandling {
    if (reason !== DisconnectReason.CLIENT_INITIATED && tracker.isExpectedDisconnect(callId)) {
        return { toast: null, teardown: false };
    }
    if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
        return { toast: mapDisconnectReasonToUserMessage(reason), teardown: true };
    }
    return { toast: null, teardown: true };
}

/**
 * Should a "the call ended" report from the CallPane of `paneCallId` be acted
 * on? Only while that call is still the active one. A pane that has already been
 * replaced (its key changed, its room was torn down) must not be able to end the
 * call that replaced it — the stale-closure half of the move bug.
 */
export function shouldActOnPaneDisconnect(
    paneCallId: string,
    activeCallId: string | null | undefined,
): boolean {
    return !!activeCallId && activeCallId === paneCallId;
}

// ── Wire parsing (the WS payload is untrusted input) ─────────────────────────

const asId = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);

/** `from_call_id` of a force_move (absent from older servers → null). */
export function parseFromCallId(v: unknown): string | null { return asId(v); }

/** Parse a `huddle:force_disconnect` payload; null if malformed (ignored). */
export function parseForceDisconnect(data: unknown): Omit<ForceDisconnectEvent, 'nonce'> | null {
    const d = (data ?? {}) as Record<string, unknown>;
    const call_id = asId(d.call_id);
    const channel_id = asId(d.channel_id);
    if (!call_id || !channel_id) return null;
    const by = typeof d.by_name === 'string' ? d.by_name.slice(0, 64) : undefined;
    // Only the one known reason is honoured; anything else is a plain disconnect.
    const reason = d.reason === CALL_ENDED_BY_CREATOR ? CALL_ENDED_BY_CREATOR : undefined;
    return reason ? { call_id, channel_id, by_name: by, reason } : { call_id, channel_id, by_name: by };
}

// ── Messages ─────────────────────────────────────────────────────────────────

/** Fallback when nobody can name the moderator. */
export const UNKNOWN_MODERATOR_LABEL = 'a moderator';

/** `huddle:force_disconnect.reason` when the call's CREATOR left with "end the
 *  call for everyone when I leave" on (not a moderator action). */
export const CALL_ENDED_BY_CREATOR = 'creator_left';

export interface ForceDisconnectEvent {
    call_id: string;
    channel_id: string;
    by_name?: string;
    /** Absent = a moderator disconnected us. */
    reason?: typeof CALL_ENDED_BY_CREATOR;
    /** Client-side re-fire token (Date.now()); one per received event. */
    nonce: number;
}

/** The notice shown to a member a moderator disconnected. Deliberately not
 *  "kicked" / "removed": it is neither, and they can rejoin at once. */
export function disconnectedToast(byName: string | undefined): { kind: 'info'; title: string; message: string } {
    const who = typeof byName === 'string' && byName.trim() ? byName.trim() : UNKNOWN_MODERATOR_LABEL;
    return {
        kind: 'info',
        title: 'Disconnected from call',
        message: `You were disconnected from the call by ${who}.`,
    };
}

/** The notice shown when the creator ended the call by leaving it. Like the
 *  disconnect notice it is deliberately not "kicked" / "removed": nobody did
 *  anything TO this member, the call is simply over. */
export function callEndedByCreatorToast(byName: string | undefined): { kind: 'info'; title: string; message: string } {
    const who = typeof byName === 'string' && byName.trim() ? byName.trim() : 'The person who started it';
    return { kind: 'info', title: 'Call ended', message: `${who} ended the call.` };
}

/** Title for a connection failure of a call we were MOVED into. */
export function moveFailureTitle(callName: string | undefined): string {
    const n = typeof callName === 'string' ? callName.trim() : '';
    return `Couldn't move you to ${n || 'the call'}`;
}

/**
 * The heading for CallPane's connection-failed toast: "Couldn't move you to X"
 * while a move into this call is still waiting to connect, else undefined (the
 * generic "Call connection failed"). A failed move is therefore reported as
 * what it was, and the ordinary teardown that follows leaves the destination
 * cleanly - the user ends up out of calls, not in a half-built one.
 */
export function failureTitleFor(
    callId: string,
    callName: string | undefined,
    tracker: Pick<CallTransitionTracker, 'isMovePendingFor'> = callTransitions,
): string | undefined {
    return tracker.isMovePendingFor(callId) ? moveFailureTitle(callName) : undefined;
}

// ── The flows (ports-and-adapters so they run without the 14k-line Dashboard) ─

/** What the Dashboard keeps as "the call I am in" for a Calls-channel call. */
export interface HuddleSelection {
    activeVoiceChannelId: null;
    activeHuddleCallId: string;
    activeHuddleChannelId: string;
    activeCall: {
        id: string;
        livekit_url: string;
        livekit_token: string;
        e2ee_key_b64: '';
        callsChannelId: string;
        mode: 'sfu';
        isInitiator: boolean;
        isVoiceChannel: true;
        voiceChannelName: string;
    };
}

/**
 * The ONE place the four pieces of "I am in this Calls-channel call" state are
 * derived. Spawn, join and a moderator's move all go through it, so a moved
 * user's activeCall / huddle ids / voice-channel id / call-pane props are exactly
 * what the user would have after switching calls themselves. (Before, the move
 * built its own copy in the force_move effect.)
 */
export function buildHuddleSelection(c: {
    callId: string;
    huddleId: string;
    name: string;
    livekitUrl: string;
    livekitToken: string;
    isInitiator: boolean;
}): HuddleSelection {
    return {
        activeVoiceChannelId: null,
        activeHuddleCallId: c.callId,
        activeHuddleChannelId: c.huddleId,
        activeCall: {
            id: c.callId,
            livekit_url: c.livekitUrl,
            livekit_token: c.livekitToken,
            e2ee_key_b64: '',
            callsChannelId: c.huddleId,
            mode: 'sfu',
            isInitiator: c.isInitiator,
            isVoiceChannel: true,
            voiceChannelName: c.name,
        },
    };
}

export interface ForceMoveEventData {
    huddle_id: string;
    call_id: string;
    call_name: string;
    livekit_url: string;
    livekit_token: string;
    moved_by: string;
    moved_by_name?: string;
    from_call_id?: string | null;
    nonce: number;
}

export interface ForceMoveFlowPorts<A = unknown> {
    /** The call the client is in right now (activeCall.id), or null. */
    activeCallId(): string | null;
    /**
     * Is THIS device the one being moved? The server addresses a move to every
     * device of the account, but only one of them is in the source call. An idle
     * second device must not act on it: connecting a second client with the same
     * LiveKit identity to the destination would kick the device that IS in the
     * call (DUPLICATE_IDENTITY) - a "completely disconnected" of its own.
     */
    isInSourceCall(ev: ForceMoveEventData): boolean;
    /** Start the join exactly as a user-initiated switch does (the same
     *  beginCallJoin: optimistic call UI, room-key derivation, mic warm-up, and
     *  supersedes any join already in flight). */
    beginJoin(ev: ForceMoveEventData): A;
    /** The join "request" is answered. false = superseded or cancelled meanwhile. */
    settleJoin(attempt: A): boolean;
    /** Commit the destination call (the four state setters). */
    enter(selection: HuddleSelection): void;
    /** Cue + toast ("You were moved to X by Y"). */
    announce(ev: ForceMoveEventData): void;
}

export type ForceMoveOutcome = 'entered' | 'already-there' | 'superseded' | 'not-in-source';

/**
 * Run a `huddle:force_move`. The caller has ALREADY armed the tracker (in the WS
 * handler, synchronously). Swapping `activeCall` re-keys CallPane, which
 * unmounts the old pane and disconnects its room CLIENT_INITIATED — the leave
 * the server is waiting for — and mounts the new one through the same state the
 * normal join path produces. No REST leave: the server already moved presence.
 */
export function runForceMove<A>(
    ev: ForceMoveEventData,
    ports: ForceMoveFlowPorts<A>,
    tracker: CallTransitionTracker = callTransitions,
): ForceMoveOutcome {
    if (ports.activeCallId() === ev.call_id) {
        // Already in the destination (a replayed event): nothing to rebuild.
        tracker.markConnected(ev.call_id);
        return 'already-there';
    }
    if (!ports.isInSourceCall(ev)) {
        // Another device of this account: the one in the call handles it. Drop
        // the marker too, so it cannot silence an unrelated disconnect here.
        tracker.clear();
        return 'not-in-source';
    }
    const attempt = ports.beginJoin(ev);
    if (!ports.settleJoin(attempt)) return 'superseded';
    ports.enter(buildHuddleSelection({
        callId: ev.call_id,
        huddleId: ev.huddle_id,
        name: ev.call_name,
        livekitUrl: ev.livekit_url,
        livekitToken: ev.livekit_token,
        isInitiator: false,
    }));
    ports.announce(ev);
    return 'entered';
}

export interface ForceDisconnectFlowPorts {
    activeCallId(): string | null;
    activeVoiceChannelId(): string | null;
    /** Leave the call the ordinary way (handleDisconnectCall): local teardown,
     *  server leave (idempotent — the server already removed presence), and the
     *  room is disconnected CLIENT_INITIATED by CallPane unmounting. */
    leave(): void;
    toast(t: { kind: 'info'; title: string; message: string }): void;
    /** The neutral "left" cue — never an error tone. */
    playLeaveCue(): void;
}

export type ForceDisconnectOutcome = 'left' | 'not-in-that-call';

/** Run a `huddle:force_disconnect`. The tracker was armed in the WS handler. */
export function runForceDisconnect(
    ev: Pick<ForceDisconnectEvent, 'call_id' | 'channel_id' | 'by_name' | 'reason'>,
    ports: ForceDisconnectFlowPorts,
    tracker: CallTransitionTracker = callTransitions,
): ForceDisconnectOutcome {
    const inCall = ports.activeCallId() === ev.call_id;
    const inVoice = ports.activeVoiceChannelId() === ev.channel_id;
    if (!inCall && !inVoice) {
        // Another device of this account, or a call we already left.
        tracker.clear();
        return 'not-in-that-call';
    }
    ports.leave();
    ports.playLeaveCue();
    ports.toast(ev.reason === CALL_ENDED_BY_CREATOR
        ? callEndedByCreatorToast(ev.by_name)
        : disconnectedToast(ev.by_name));
    // The marker is deliberately NOT cleared here: the pane unmounts on the next
    // commit, and the server's fallback removal (immediate on legacy voice
    // channels) may land in between — it must still read as part of this
    // disconnect. It ends when any room next connects, or after its TTL.
    return 'left';
}
