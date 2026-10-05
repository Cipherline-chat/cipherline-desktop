/**
 * Verdict logic for the `safety_number` message embed.
 *
 * ── The whole security argument, in one paragraph ───────────────────────────
 *
 * A `safety_number` message carries a code and nothing else. This function is
 * the ONLY thing that produces a verdict about it, and look at what it can and
 * cannot see: it takes the claimed code and the claimed user id — the two
 * attacker-controlled values — and it takes `localDevicePubsB64`, which the
 * caller obtained from its own `GET /keys/identity_keys` fetch. There is no
 * parameter through which a message can assert an outcome, because the
 * `ClientContent` variant has no outcome-shaped field to put one in. The
 * expected code is RECOMPUTED here, on every call, from the recipient's own
 * key material. A forged embed can therefore choose what is compared; it can
 * never choose the result of the comparison. That is what "impossible by
 * construction" means here — not a check that could be bypassed, but an input
 * that does not exist.
 *
 * ── Why a match is not a verification ───────────────────────────────────────
 *
 * `verificationCode.ts` says it at length and it governs here too: a safety
 * number cannot be verified by the system over the channel it secures. An
 * attacker who has substituted the keys — the single thing safety numbers
 * exist to detect — controls both the directory the recipient reads AND the
 * message body, so producing a matching code costs them nothing. So:
 *
 *   • MISMATCH is real, load-bearing evidence. Two independent views of the
 *     same account's keys disagree. Something is wrong: a key rotated, a
 *     device was added, the directory is inconsistent, or an interception did
 *     not rewrite the message body. Worth an alarm, and free to obtain.
 *   • MATCH is only the absence of that evidence. It means the two views
 *     agree, which an attacker controlling both produces for free.
 *
 * Hence this module returns a verdict and NOTHING ELSE. It does not touch
 * `keyVerification`, and callers must not turn a `match` into `markVerified`
 * on their own — that step belongs to an explicit human attestation that the
 * code was compared out of band. See `SafetyNumberEmbed.tsx`.
 */

import { computeContactCode, checkCode } from './verificationCode';
import { deriveContactTrust, type ContactTrust } from './contactTrust';
import type { SenderVerdict } from './senderTrust';

export type SafetyEmbedVerdict =
    /** Well-formed, and identical to what this client computes for the sender. */
    | { kind: 'match' }
    /** Well-formed and definitively different — the actionable alarm. */
    | { kind: 'mismatch' }
    /** Not 40 valid base32 characters; nothing was compared. */
    | { kind: 'malformed'; reason: string }
    /** `content.user_id` disagrees with the envelope's sender. Never compared. */
    | { kind: 'sender_mismatch' }
    /** The recipient could not obtain the sender's keys, so no comparison ran. */
    | { kind: 'unavailable'; reason: string };

export interface SafetyEmbedInput {
    /**
     * Sender id taken from the ENVELOPE (`msg.sender_user_id`) — i.e. who the
     * transport says actually sent this. The verdict is computed against this
     * identity and no other.
     */
    senderUserId: string;
    /** `content.user_id` exactly as it arrived. Compared, never trusted. */
    claimedUserId: string;
    /** `content.code` exactly as it arrived. Compared, never trusted. */
    claimedCode: string;
    /**
     * The recipient's OWN view of the sender's published identity keys, from
     * its own directory fetch. This is the root of the whole comparison and is
     * the one input that does not come off the wire message.
     */
    localDevicePubsB64: string[];
}

/**
 * Decide whether a received safety-number embed agrees with what this client
 * independently believes the sender's identity keys to be.
 *
 * Deliberately `async` and free of side effects: no store writes, no network,
 * no trust mutation. Hand it data, get a verdict.
 */
export async function evaluateSafetyNumberEmbed(
    input: SafetyEmbedInput,
): Promise<SafetyEmbedVerdict> {
    const { senderUserId, claimedUserId, claimedCode, localDevicePubsB64 } = input;

    // Without a sender identity from the envelope there is nothing to compute
    // an expectation against, and falling back to the payload's own `user_id`
    // would hand the attacker the choice of subject as well as the value.
    // Refuse instead.
    if (!senderUserId) {
        return { kind: 'unavailable', reason: 'This message has no verified sender to check against.' };
    }

    // A payload naming a different account than the one that sent it is not a
    // transcription error and must never be quietly compared "as the sender"
    // — it is either a broken client or an attempt to have the recipient
    // evaluate someone else's code and attribute the result here.
    if (claimedUserId && claimedUserId !== senderUserId) {
        return { kind: 'sender_mismatch' };
    }

    if (!Array.isArray(localDevicePubsB64) || localDevicePubsB64.length === 0) {
        return { kind: 'unavailable', reason: "Could not read this contact's encryption keys." };
    }

    let expected: string;
    try {
        // Recomputed here, every time, from the recipient's own key material.
        expected = await computeContactCode(senderUserId, localDevicePubsB64);
    } catch (err: unknown) {
        const reason = err instanceof Error && err.message
            ? err.message
            : 'Could not compute the expected code.';
        return { kind: 'unavailable', reason };
    }

    const check = checkCode(expected, typeof claimedCode === 'string' ? claimedCode : '');
    if (check.result === 'malformed') return { kind: 'malformed', reason: check.reason };
    if (check.result === 'mismatch') return { kind: 'mismatch' };
    return { kind: 'match' };
}

/* ────────────────────────────────────────────────────────────────────────────
 * RESTING STATE — what the embed shows before, and without, a live check.
 *
 * ── The bug this exists to fix ──────────────────────────────────────────────
 *
 * The embed used to hold its whole world in component state, so leaving the
 * chat and coming back re-asked for a verification the user had already done
 * and which `keyVerification` had durably recorded. The fix is to DERIVE what
 * a fresh mount displays from the pin store instead of from local state —
 * exactly the way the chat-header `TrustBadge` already does.
 *
 * ── Why this defers to `deriveContactTrust` instead of answering "verified?" ─
 *
 * "Already verified" is not a boolean about a person. Verification is
 * per-device by construction (every device has its own identity key), and a
 * contact can add devices after the user attested. `contactTrust` is the one
 * place in this client where that per-device reality is collapsed into a
 * single displayable claim, and it is deliberately harsh about it: full green
 * requires EVERY known device vouched for, because a DM is addressed to all of
 * them. Re-deciding that here would be a second notion of "verified" that
 * eventually disagrees with the header shield — the precise failure
 * `contactTrust.ts` was written to end. So this function's real work is
 * choosing WHICH devices to hand it, and saying what the code itself adds.
 *
 * ── The three cases, and the rule for each ──────────────────────────────────
 *
 *  1. Every device the code commits to is verified → 'verified'. Green, and
 *     the check affordance demotes to a quiet "check again". That is the
 *     user's actual complaint, fixed.
 *  2. Some verified, some not → 'partially_verified'. Amber, never green.
 *     `contactTrust` already owns this and already says why: "3 of 4" is not
 *     what a green shield claims, and everything the user sends reaches the
 *     fourth device too.
 *  3. A NEW unverified device since the user attested → ALSO not green, and
 *     this is the case worth being explicit about, because a newly-appeared
 *     unverified device is the exact event safety numbers exist to surface.
 *     It can arrive two ways and both are covered:
 *       • the device is in the pin store (it has sent something, so TOFU
 *         recorded it) → `verifiedCount < deviceCount` → case 2's amber; or
 *       • the device is NOT in the pin store, but the CODE commits to it —
 *         i.e. the sender's device set at send time is not the set this
 *         client has pinned. Then `commitsToPinnedSet` is false and the
 *         caller must not render a clean "you're good to go". That is the one
 *         thing the code adds that the pin store cannot say by itself.
 *
 * ── What we do when the code and the current device set disagree ────────────
 *
 * We make NO claim about the code, and fall back to offering the live check —
 * which is the only thing that can actually resolve it, since only the
 * directory knows the contact's device set now. `commitsToPinnedSet` is
 * reported ALONGSIDE `trust` rather than folded into it, because the two
 * answer different questions: `trust` is about the CONTACT ("have you vouched
 * for their keys"), `commitsToPinnedSet` is about THIS MESSAGE ("is the set it
 * commits to the set you vouched for"). A stale embed sent before a legitimate
 * device change is simultaneously a true "verified contact" and a true "this
 * is not the set your pins commit to"; flattening them would have to lie about
 * one. The caller renders the WEAKER of the two, so a green tick never sits
 * next to a caution.
 *
 * ── Why reading persisted state does not weaken the forgery guarantee ───────
 *
 * Every value that decides the outcome — the pinned pubs, their `verified`
 * flags, the envelope's `senderUserId`, the contact's current `SenderVerdict`
 * — is local. The message body supplies exactly one input, `claimedCode`, and
 * only as one side of a comparison against a code RECOMPUTED here from the
 * recipient's own pins. As in `evaluateSafetyNumberEmbed`, a forged embed can
 * choose what is compared; it can never choose the result, and there is no
 * outcome-shaped field for it to assert. Nothing here writes: the only path to
 * `verified` remains `markVerified`, behind the explicit attestation button.
 * ─────────────────────────────────────────────────────────────────────────── */

/** One pinned device, as `keyVerification.getKnownDevices` records it. */
export interface PinnedDevice {
    /** Device id, or the pub-bucket key for a device pinned before `sd`. */
    deviceId: string;
    pub: string;
    verified: boolean;
    /** Verified before safety-number v2 (`verificationStrength.isLegacyVerified`). */
    legacy?: boolean;
}

export type EmbedRestingState =
    /** Nothing to report. Render the plain "Check this code" affordance. */
    | { kind: 'silent' }
    | {
        kind: 'trust';
        /** The contact-level claim, in the app's one trust vocabulary. */
        trust: ContactTrust;
        /**
         * True iff this embed's code commits to EXACTLY the set of pubs this
         * client has pinned for the sender. False means the two views of the
         * contact's device set differ — a stale code, or a device the pin
         * store has never seen — and no clean "verified" may be shown.
         */
        commitsToPinnedSet: boolean;
    };

export interface EmbedRestingInput {
    /** Envelope sender. Every claim is bound to this identity and no other. */
    senderUserId: string | null;
    /** `content.user_id` as it arrived. Consistency-checked, never trusted. */
    claimedUserId: string;
    /** `content.code` as it arrived. Compared, never trusted. */
    claimedCode: string;
    /** `keyVerification.getKnownDevices` for (viewer, sender). */
    pinned: PinnedDevice[];
    /**
     * The contact's current warnable verdict, if the conversation has one —
     * the same value the chat header feeds `TrustBadge`. Passed in rather than
     * read here so this stays pure, and so the embed and the header cannot end
     * up disagreeing about how bad the situation is.
     */
    verdict?: SenderVerdict | null;
}

/**
 * Decide what a freshly-mounted embed should say, from persisted state alone.
 *
 * Pure, and free of network and of store writes: hand it the pins, get a
 * claim. Async only because the code commitment is a SHA-512 through
 * WebCrypto — there is no round trip here, which is what makes it safe to run
 * on mount just to render a badge.
 */
export async function deriveEmbedRestingState(
    input: EmbedRestingInput,
): Promise<EmbedRestingState> {
    const { senderUserId, claimedUserId, claimedCode, pinned, verdict = null } = input;

    // No attributable sender means there is no subject to make a claim about.
    if (!senderUserId) return { kind: 'silent' };

    // A payload naming a different account than the one that sent it is never
    // compared — not here either. Staying silent, rather than reporting the
    // true-but-irrelevant trust level of the account that actually sent it,
    // keeps "already verified" from ever appearing beside a claim about
    // somebody else. Clicking through still yields `sender_mismatch`.
    if (claimedUserId && claimedUserId !== senderUserId) return { kind: 'silent' };

    const trust = deriveContactTrust({
        verdict,
        devices: pinned.map(d => ({ deviceId: d.deviceId, verified: d.verified, legacy: !!d.legacy })),
    });

    // An active warning outranks anything the pin store could say, and has to
    // be shown at rest — it is the whole reason not to trust the green.
    if (trust.level === 'compromised') {
        return { kind: 'trust', trust, commitsToPinnedSet: false };
    }

    // Nothing pinned, or nothing vouched for: the status quo ante. "Check this
    // code" is already the call to action and the header shield already carries
    // the state, so a second amber row here would be noise. The resting row
    // reports work the user HAS done; with none done, it says nothing.
    if (trust.level === 'unverifiable' || trust.level === 'unverified') {
        return { kind: 'silent' };
    }

    let commitsToPinnedSet = false;
    try {
        const expected = await computeContactCode(senderUserId, pinned.map(d => d.pub));
        commitsToPinnedSet =
            checkCode(expected, typeof claimedCode === 'string' ? claimedCode : '').result === 'match';
    } catch {
        // Unusable pins, or a code we cannot compute: fail toward "cannot
        // confirm", which costs a redundant check and never a false green.
        commitsToPinnedSet = false;
    }

    return { kind: 'trust', trust, commitsToPinnedSet };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * A live match must never paint over an unresolved key change.
 *
 * "Check this code" compares the code with the keys the DIRECTORY serves right
 * now — not with the keys this device pinned. For a contact with an unresolved
 * key-change warning that is exactly the attack a safety number exists for: a
 * substituting interceptor controls the directory and the message body alike,
 * so a matching code costs them nothing. The embed used to answer a match with
 * a green card saying "The keys this device holds for X are the keys they say
 * are theirs" and drop the warning (found by mobile's safety-number port,
 * 2026-09-24). The verdict stays `match` — the two views DO agree, and the user
 * may well be resolving a legitimate reinstall — but it is amber, it says which
 * keys it matched, and the warning stays until the user attests to an
 * out-of-band comparison. Same rule as mobile's `liveMatchCaution`.
 * ─────────────────────────────────────────────────────────────────────────── */

export type LiveMatchCaution =
    /** A device the directory just served is pinned here under a DIFFERENT key. */
    | { reason: 'pins_differ' }
    /** No served key contradicts a pin, but the contact has an unresolved warning. */
    | { reason: 'contact_warning' };

/** Verdicts that mean "an identity problem is open for this contact". */
const WARNING_VERDICTS: ReadonlySet<SenderVerdict> = new Set<SenderVerdict>(['key_changed', 'unrecognized_verified', 'unattributed']);

export function liveMatchCaution(input: {
    /** What this device has pinned for the sender. */
    pinned: PinnedDevice[];
    /** The directory rows the live check just compared. */
    compared: ReadonlyArray<{ deviceId: string; pub: string }>;
    /** The contact's current warnable verdict, if any. */
    verdict?: SenderVerdict | null;
}): LiveMatchCaution | null {
    const pinnedPub = new Map(input.pinned.map(d => [d.deviceId, d.pub] as const));
    for (const served of input.compared) {
        const pub = pinnedPub.get(served.deviceId);
        if (pub !== undefined && pub !== served.pub) return { reason: 'pins_differ' };
    }
    if (input.verdict && WARNING_VERDICTS.has(input.verdict)) return { reason: 'contact_warning' };
    return null;
}
