/**
 * Call keys this device REFUSED at the sender-trust gate, per call — so a
 * keyless call can say why it is stuck and get unstuck.
 *
 * ## Why (2026-11-25)
 *
 * A contact whose Safety Number you verified rang you from a device you had
 * not verified (a new iPhone). Every `call_key` that device sent — the start
 * broadcast and both answers to this device's own `call_key_request`s — was
 * refused by `actionFor(verdict, 'key_material')` (utils/senderTrust.ts), as
 * designed. But nothing in the call said so: the ring card rang, Accept joined,
 * the panel read "Securing call…" then "Still waiting for encryption keys" and
 * told the user to redial, which can never help — the key was ARRIVING and
 * being refused. senderTrust.ts promises the refusal is "legible": "the user
 * is shown a specific prompt to verify the new device". In a call it was not.
 *
 * This module only remembers the refusal (never the key — a refused key is
 * dropped, exactly as before) and decides when one fresh `call_key_request`
 * is worth sending: after the user resolves that sender's warning (verify /
 * acknowledge / dismiss), the holder's next answer is judged again by the
 * SAME gate. Verified → accepted → the call connects. Dismissed → refused
 * again → the notice stays. The trust policy is untouched; keys still move
 * only inside the E2EE message channel, only to the call's participants.
 *
 * Since 2026-11-25 (owner: warn only, like the phones) the incident's exact
 * case — a verified contact's unverified device that the server publishes —
 * is no longer refused at all: utils/callKeyTrust.ts adopts that key with an
 * in-call warning. What still lands here is every other refusal: a changed
 * key, an unattributed key, and `unrecognized_verified` with no device id or
 * no positive directory match.
 *
 * Pure and bounded; no ids are ever logged from here.
 */
import type { SenderVerdict } from './senderTrust';

/** Why a call key was refused. `unknown` = the envelope carried no usable sender identity. */
export type CallKeyRefusalReason = Exclude<SenderVerdict, 'ok' | 'first_contact'> | 'unknown';

export interface CallKeyRefusal {
    conversationId: string;
    callId: string;
    senderUserId: string;
    reason: CallKeyRefusalReason;
    atMs: number;
}

/** Refusals older than this are forgotten (a DM/group call key rotates every 10 min). */
export const CALL_KEY_REFUSAL_TTL_MS = 30 * 60_000;
/** At most this many calls are remembered. */
export const CALL_KEY_REFUSAL_MAX = 32;

function refusalReason(verdict: SenderVerdict | null | undefined): CallKeyRefusalReason {
    if (verdict === 'key_changed' || verdict === 'unrecognized_verified' || verdict === 'unattributed') return verdict;
    return 'unknown';
}

export class CallKeyRefusals {
    private byCall = new Map<string, CallKeyRefusal>();

    private static slot(conversationId: string, callId: string): string {
        return `${conversationId}\u0000${callId}`;
    }

    /** Remember that a key for this call was refused (the latest refusal wins). */
    note(input: { conversationId: string; callId: string; senderUserId: string; verdict: SenderVerdict | null | undefined; nowMs?: number }): void {
        const { conversationId, callId, senderUserId } = input;
        if (!conversationId || !callId || !senderUserId) return;
        // An 'ok' / 'first_contact' verdict is not a refusal: nothing to remember.
        if (input.verdict === 'ok' || input.verdict === 'first_contact') return;
        const nowMs = input.nowMs ?? Date.now();
        this.prune(nowMs);
        const k = CallKeyRefusals.slot(conversationId, callId);
        this.byCall.delete(k);
        this.byCall.set(k, { conversationId, callId, senderUserId, reason: refusalReason(input.verdict), atMs: nowMs });
        while (this.byCall.size > CALL_KEY_REFUSAL_MAX) {
            const oldest = this.byCall.keys().next().value;
            if (oldest === undefined) break;
            this.byCall.delete(oldest);
        }
    }

    get(conversationId: string | null | undefined, callId: string | null | undefined, nowMs = Date.now()): CallKeyRefusal | null {
        if (!conversationId || !callId) return null;
        const r = this.byCall.get(CallKeyRefusals.slot(conversationId, callId));
        if (!r || nowMs - r.atMs > CALL_KEY_REFUSAL_TTL_MS) return null;
        return r;
    }

    /** A key for the call was accepted (or the call is over): its refusal no longer explains anything. */
    clear(conversationId: string | null | undefined, callId: string | null | undefined): void {
        if (!conversationId || !callId) return;
        this.byCall.delete(CallKeyRefusals.slot(conversationId, callId));
    }

    private prune(nowMs: number): void {
        for (const [k, r] of this.byCall) {
            if (nowMs - r.atMs > CALL_KEY_REFUSAL_TTL_MS) this.byCall.delete(k);
        }
    }
}

/**
 * The user just resolved `resolvedUserId`'s identity warning. Should the
 * keyless call ask its holders for the key once more?
 *
 * Only for the call this device is in, only while it still has no key, and
 * only when the key it refused came from that same person — so verifying an
 * unrelated contact never sends anything.
 */
export function shouldRerequestAfterResolve(input: {
    resolvedUserId: string;
    activeCall: { id: string; conversation_id?: string | null; callsChannelId?: string | null; isVoiceChannel?: boolean } | null;
    hasKey: boolean;
    refusal: CallKeyRefusal | null;
}): boolean {
    const { resolvedUserId, activeCall, hasKey, refusal } = input;
    if (!resolvedUserId || !activeCall || hasKey || !refusal) return false;
    // DM / group calls only: a Calls channel derives its key, a voice channel uses the channel Sender Key.
    if (activeCall.callsChannelId || activeCall.isVoiceChannel || !activeCall.conversation_id) return false;
    if (refusal.callId !== activeCall.id || refusal.conversationId !== activeCall.conversation_id) return false;
    return refusal.senderUserId === resolvedUserId;
}

/** What the keyless call panel says about a refused key. `who` is a display name. */
export function callKeyRefusalNotice(reason: CallKeyRefusalReason, who: string): { title: string; body: string } {
    const name = who.trim() || 'The caller';
    switch (reason) {
        case 'unrecognized_verified':
            return {
                title: `${name} is calling from a device you haven't verified`,
                body: `You verified ${name} before, but this call's key came from one of their devices you have not verified, so it was not used. Review that device in your chat with ${name}; once you verify it, the call connects.`,
            };
        case 'key_changed':
            return {
                title: `${name}'s safety number changed`,
                body: `This call's key came from a device of ${name} whose key changed since you last saw it, so it was not used. Review the change in your chat with ${name} before joining.`,
            };
        case 'unattributed':
            return {
                title: `Couldn't confirm this call's key came from ${name}`,
                body: `${name}'s account does not publish the key this call's key was signed with, so it was not used. Review ${name}'s devices in your chat before joining.`,
            };
        default:
            return {
                title: `Couldn't confirm who sent this call's key`,
                body: `This call's key could not be tied to ${name}, so it was not used. Review ${name}'s devices in your chat before joining.`,
            };
    }
}
