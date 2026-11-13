/**
 * Binding the claimed sender id (`su`) of a v:3 envelope to the conversation
 * it arrived in.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `su`, `sp` (signing key) and `sd` are read out of the sender's own plaintext
 * wrapper; the Ed25519 signature is checked against `sp` from the same wrapper,
 * so it proves self-consistency and nothing about `su`
 * (see deviceDirectory.ts). Everything downstream treated `su` as an
 * authenticated principal: the stored row's `sender_user_id` (name, avatar,
 * `isSameAuthor` for edit/delete), the friend-only activity-key and status
 * sinks, the DM avatar rebind, and the key pin store. A group member could
 * therefore sign with his own key, claim `su = <another member>`, and edit,
 * delete or post as that member on every other member's desktop.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *   • su is me                -> 'ok' (own devices are judged by selfSenderTrust,
 *                                unchanged).
 *   • DM                      -> su must be the DM's other user.
 *   • group / unknown conv    -> su must be listed in THIS conversation's device
 *                                roster with `sp` among the keys published under
 *                                su (deviceDirectory.conversationRosterJudgment).
 * The roster is the one source independent of the envelope that can say
 * "this key belongs to this member of this conversation"; the relay cannot
 * forge it without publishing a device (see deviceDirectory.ts for what that
 * does and does not defend). `senderTrust` / `contactTrust` / pinning stay the
 * source of truth for everything beyond membership: this only decides whether
 * the claim may enter them at all.
 *
 * ── Never lose a legitimate message ─────────────────────────────────────────
 * A roster miss is not proof of forgery: the roster may be older than a new
 * member's join or a new device, or may not be loaded. So a miss triggers a
 * (rate-limited) refresh first, and while the answer cannot be had the result
 * is 'pending' - the caller holds the already-decrypted envelope, does NOT ack
 * it, and asks again on the next pull. Only a definite answer ('refuse') -
 * or pending that never resolves within the caller's cap - ends in the
 * "couldn't be shown" stand-in (ordinary content) or a drop (control content).
 */
import type { RosterJudgment } from './deviceDirectory';

export type SenderBinding = 'ok' | 'refuse' | 'pending';

/** At most one roster refresh per conversation per this long. */
export const ROSTER_REFRESH_MIN_MS = 15_000;

export interface BindingConversation {
    type?: string;
    other_user_id?: string | null;
}

export interface BindingDeps {
    myUserId: string;
    /** The locally known conversation, if any. */
    conversation: (conversationId: string) => BindingConversation | undefined;
    judge: (conversationId: string, su: string, sp: string) => RosterJudgment;
    /** ms since the roster was last refreshed, null when never. */
    rosterAgeMs: (conversationId: string) => number | null;
    /** Refetch the roster. Resolves true when a roster response was recorded. Must dedupe in-flight calls. */
    refreshRoster: (conversationId: string) => Promise<boolean>;
}

export async function bindSender(
    deps: BindingDeps,
    input: { conversationId: string; senderUserId?: string | null; senderPub?: string | null },
): Promise<SenderBinding> {
    const { conversationId, senderUserId: su, senderPub: sp } = input;
    // No claim, nothing to bind: the row is stored unattributed exactly as before.
    if (!su) return 'ok';
    if (su === deps.myUserId) return 'ok';

    const conv = deps.conversation(conversationId);
    if (conv?.type === 'dm') {
        // A DM has exactly two members; the peer is known locally. A sender
        // that is neither me nor the peer cannot belong to this conversation.
        return conv.other_user_id && su === conv.other_user_id ? 'ok' : 'refuse';
    }

    // Group, or a conversation this client has not listed yet: the roster decides.
    if (!sp) return 'refuse';
    if (deps.judge(conversationId, su, sp) === 'member') return 'ok';

    const age = deps.rosterAgeMs(conversationId);
    if (age !== null && age < ROSTER_REFRESH_MIN_MS) {
        // Refreshed a moment ago and still no match. A member who joined (or a
        // device added) in the last seconds is legitimate, so wait for the
        // next window rather than refusing outright.
        return 'pending';
    }
    const refreshed = await deps.refreshRoster(conversationId);
    if (!refreshed) return 'pending';
    return deps.judge(conversationId, su, sp) === 'member' ? 'ok' : 'refuse';
}

/** How long an envelope may stay held (un-ACKed, already decrypted) while its
 *  sender cannot be checked, before it falls back to the stand-in / drop. Time,
 *  not a pull count: pulls can fire in bursts, and the roster may be refreshed
 *  at most once per {@link ROSTER_REFRESH_MIN_MS}. Must stay below the
 *  HeldBackEnvelopes TTL the caller holds it in (5 min), or an expiring entry
 *  would turn into a REPLAY drop. */
export const SENDER_BINDING_MAX_HOLD_MS = 60_000;

/** Parse decrypted envelope content for the binding decision only (never used as the content itself). */
export function parseEnvelopeContent(contentJson: string): unknown {
    return JSON.parse(contentJson);
}
