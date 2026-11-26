/**
 * The sender-trust decision for an incoming DM / group `call_key` — the one
 * place call keys depart from `actionFor(verdict, 'key_material')`.
 *
 * ## Owner decision (2026-11-25): warn only, like the phones
 *
 * A contact whose Safety Number you verified rings you from a device you have
 * NOT verified (their new phone). `evaluateSender` calls that
 * `unrecognized_verified`, and `actionFor(..., 'key_material')` refuses it, so
 * the call never got a key and hung on "Securing call…" (2026-11-25 incident,
 * docs/worklog/entries/2026-11-25-call-key-resend.md). The native phones
 * accept the same key (cl-sync `authorship::judge` refuses only a pinned-key
 * mismatch or a claim the conversation's server roster does not list) and
 * show the "Unvouched device" warning. The owner chose that behaviour for the
 * desktop too: accept the key, connect, and say so in the call.
 *
 * ## Exactly which case changes
 *
 * `accept_warn` is returned ONLY when every one of these holds:
 *   1. the verdict is `unrecognized_verified` — the contact has at least one
 *      verified device and this key matches none of them, AND (by
 *      `evaluateSender`'s ordering) no pin for this device id names a different
 *      key (`key_changed` outranks it) and the directory does not contradict
 *      the claim (`unattributed` outranks it);
 *   2. the sender is another account, never this one (own devices are judged
 *      by the own-device ledger, utils/selfSenderTrust.ts);
 *   3. the envelope names the sending device (`sd`). An omitted `sd` is the
 *      F1 forgery's bypass shape and stays refused;
 *   4. the server's key directory POSITIVELY publishes this key for exactly
 *      that device of that user (`deviceDirectory.status` === 'match'; with a
 *      device id that is an exact per-device check). 'unknown' (no snapshot,
 *      e.g. the fresh lookup failed) stays refused — the phones likewise never
 *      accept a claim their roster does not list. This is what makes it "a new
 *      device of theirs" and not "a key nobody vouches for".
 *
 * Every other non-accepting verdict is still refused, exactly as before:
 * `key_changed` (a device you have seen — verified or not — presents another
 * key), `unattributed` (the directory contradicts the claim), no verdict at
 * all, and `unrecognized_verified` without condition 2/3/4. Keys that fail
 * decryption or authentication never reach this function (the engine throws
 * first), and a sender the client knows is not a member of the conversation is
 * still refused afterwards by `CallKeyStore.recordRemote` ('refused_member').
 *
 * Scope: DM / group call keys, both directions:
 *   • RECEIVING a `call_key` (`routeIncomingCallKey`) — owner 2026-11-25;
 *   • ANSWERING a `call_key_request` (`routeIncomingKeyRequest`) — owner
 *     2026-11-25, "yes make late joiners warn only too": the same one case
 *     gets the held key sent to it, and the call panel warns that a device you
 *     have not verified was given the key. The rest of the answer rules
 *     (connected to that call, holding an accepted key, requester not a known
 *     non-member, not our own device, one answer per device per window) are
 *     unchanged in `decideKeyRequestResponse`, and the answer is addressed only
 *     to the requester's devices that the CONVERSATION's server roster lists,
 *     so a non-member is never addressed at all.
 * `channel_key` and the huddle guest key keep `actionFor(..., 'key_material')`
 * unchanged; message (content) trust is untouched.
 *
 * Pure; no ids are logged from here.
 */
import { actionFor, type SenderVerdict } from './senderTrust';
import type { DirectoryStatus } from './deviceDirectory';
import type { CallKeyDecision } from './callKeyStore';
import { CallKeyRefusals } from './callKeyRefusal';

export type CallKeyTrust = 'accept' | 'accept_warn' | 'reject';

export interface CallKeyTrustInput {
    verdict: SenderVerdict | null | undefined;
    /** Claimed sender user id (`su`). */
    senderUserId: string | null | undefined;
    /** This account. */
    selfUserId: string | null | undefined;
    /** Claimed sender device id (`sd`). */
    senderDeviceId: string | null | undefined;
    /** `deviceDirectory.status(su, sp, sd)`, read after the fresh `ensureUser`. */
    directory: DirectoryStatus;
}

export function decideCallKeyTrust(input: CallKeyTrustInput): CallKeyTrust {
    const { verdict, senderUserId, selfUserId, senderDeviceId, directory } = input;
    if (!verdict) return 'reject';
    if (actionFor(verdict, 'key_material') === 'accept') return 'accept';
    if (verdict !== 'unrecognized_verified') return 'reject';
    if (!senderUserId || !selfUserId || senderUserId === selfUserId) return 'reject';
    if (typeof senderDeviceId !== 'string' || !senderDeviceId.trim()) return 'reject';
    if (directory !== 'match') return 'reject';
    return 'accept_warn';
}

/** Which way the key went: adopted FROM the unverified device, or sent TO it (a late joiner). */
export type CallKeyWarningKind = 'received' | 'sent';

export interface CallKeyWarning {
    conversationId: string;
    callId: string;
    senderUserId: string;
    kind: CallKeyWarningKind;
    atMs: number;
}

/**
 * Calls in which a call key moved between this device and a verified
 * contact's UNVERIFIED device (`accept_warn`, either direction), so the call
 * panel can say so for as long as the call runs. Same bounds and expiry as
 * CallKeyRefusals (it is one underneath); never the key. The latest event
 * for a call wins.
 */
export class CallKeyWarnings {
    private readonly inner = new CallKeyRefusals();
    private readonly kinds = new Map<string, { conversationId: string; callId: string; kind: CallKeyWarningKind }>();

    private static slot(conversationId: string, callId: string): string {
        return `${conversationId}\u0000${callId}`;
    }

    note(input: { conversationId: string; callId: string; senderUserId: string; kind: CallKeyWarningKind; nowMs?: number }): void {
        const { conversationId, callId, senderUserId, kind } = input;
        if (!conversationId || !callId || !senderUserId) return;
        this.inner.note({ conversationId, callId, senderUserId, verdict: 'unrecognized_verified', nowMs: input.nowMs });
        this.kinds.set(CallKeyWarnings.slot(conversationId, callId), { conversationId, callId, kind });
        // Keep the side table in step with the bounded/expiring store underneath.
        const nowMs = input.nowMs ?? Date.now();
        for (const [k, v] of this.kinds) {
            if (!this.inner.get(v.conversationId, v.callId, nowMs)) this.kinds.delete(k);
        }
    }

    get(conversationId: string | null | undefined, callId: string | null | undefined, nowMs = Date.now()): CallKeyWarning | null {
        const r = this.inner.get(conversationId, callId, nowMs);
        if (!r) return null;
        const kind = this.kinds.get(CallKeyWarnings.slot(r.conversationId, r.callId))?.kind ?? 'received';
        return { conversationId: r.conversationId, callId: r.callId, senderUserId: r.senderUserId, kind, atMs: r.atMs };
    }

    clear(conversationId: string | null | undefined, callId: string | null | undefined): void {
        if (!conversationId || !callId) return;
        this.inner.clear(conversationId, callId);
        this.kinds.delete(CallKeyWarnings.slot(conversationId, callId));
    }
}

/**
 * What the Dashboard's `call_key` branch does with one trusted-or-not key.
 * Split out so the whole path — decision, adoption, warning, refusal — is
 * testable against the real CallKeyStore (Dashboard has no render harness).
 *
 * Returns the decision. `adopt` is called for 'accept' and 'accept_warn' only;
 * `onWarned` only when an `accept_warn` key was actually adopted (stored, or the
 * same key again) — a key the store refuses (non-member, stale epoch) is not in
 * use, so there is nothing to warn about; `onRefused` only for 'reject'.
 */
export function routeIncomingCallKey(
    input: CallKeyTrustInput,
    deps: {
        adopt: () => CallKeyDecision;
        onWarned: () => void;
        onRefused: () => void;
    },
): CallKeyTrust {
    const trust = decideCallKeyTrust(input);
    if (trust === 'reject' || !input.senderUserId) {
        deps.onRefused();
        return 'reject';
    }
    const d = deps.adopt();
    if (trust === 'accept_warn' && (d === 'stored' || d === 'duplicate')) deps.onWarned();
    return trust;
}

/**
 * What the DM pull loop does with a `call_key_request` (owner 2026-11-25:
 * late joiners warn only too). `answer(senderTrusted)` is the existing
 * responder (useCallKeySharing.handleKeyRequest → decideKeyRequestResponse),
 * which still applies every other rule; it returns 'scheduled' or the reason
 * it did not answer. `onWarned` fires only when an `accept_warn` requester's
 * answer was actually scheduled.
 */
export function routeIncomingKeyRequest(
    input: CallKeyTrustInput,
    deps: {
        answer: (senderTrusted: boolean) => string;
        onWarned: () => void;
    },
): { trust: CallKeyTrust; outcome: string } {
    const trust = decideCallKeyTrust(input);
    const outcome = deps.answer(trust !== 'reject');
    if (trust === 'accept_warn' && outcome === 'scheduled') deps.onWarned();
    return { trust, outcome };
}

/**
 * What the call panel says while a call key has moved to or from such a
 * device. `who` is a display name; `kind` is which way the key went.
 */
export function callKeyWarningNotice(who: string, kind: CallKeyWarningKind = 'received'): { title: string; body: string } {
    if (kind === 'sent') {
        const name = who.trim() || 'Someone';
        return {
            title: `${name} joined from a new device you haven't verified`,
            body: `You verified ${name} before, but not this device. It asked for this call's key and was given it, so it can hear the call. Compare safety numbers to verify the device.`,
        };
    }
    const name = who.trim() || 'The caller';
    return {
        title: `${name} is calling from a new device you haven't verified`,
        body: `You verified ${name} before, but not this device. The call is encrypted, but that doesn't prove who is on the other end. Compare safety numbers to verify the device.`,
    };
}
