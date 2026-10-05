/**
 * Sender trust evaluation (F1 — critical: sender-identity binding).
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 * `decryptEnvelope` verifies the envelope's Ed25519 signature against `sp`,
 * the sender identity pub it reads OUT OF THAT SAME ENVELOPE. That proves
 * self-consistency and nothing else. Anyone who can deliver an envelope —
 * a malicious server above all — can:
 *
 *   1. generate a fresh Ed25519 identity key and a fresh device id,
 *   2. ECDH against the victim's PUBLISHED signed prekey (it is public),
 *   3. set `su` to any user id they like and sign with their own key.
 *
 * Every existing check passes. GCM authenticates (they made the ciphertext).
 * The signature verifies (against their own key). And the TOFU layer stayed
 * silent, because an unseen device id is by design "a new device, not a
 * changed one" (RC-7) — so the forgery landed with NO warning at all, even
 * for a contact whose safety number the user had verified. The same envelope
 * carrying `call_key` was accepted outright, because the pin gate reads
 * `if (!pinned || pinned === sp)` and an unseen device id makes `pinned` null.
 *
 * ── Why the fix is not cryptographic ────────────────────────────────────────
 * It is worth being explicit, because the intuitive fix is wrong: you cannot
 * close this by signing more. `su` and `sd` already live inside `ct`, and the
 * signed transcript already covers `ct`. Adding them to the transcript
 * explicitly changes no attacker's capability, because the attacker controls
 * the signing key. The signature can only ever attest to whoever holds the key
 * named in the envelope.
 *
 * The gap is ATTRIBUTION — an independent statement of which keys belong to
 * `su` — and there are exactly two sources of that here:
 *
 *   • the server's published key directory (`deviceDirectory.ts`), which
 *     blocks every forger who cannot write it, and which forces a malicious
 *     server's forgery to be published and therefore visible; and
 *   • out-of-band Safety Number verification (`keyVerification.ts`), which is
 *     the ONLY layer that binds against a malicious server.
 *
 * This module is where those two combine into one verdict, and where that
 * verdict is turned into an action. It is deliberately pure — no network, no
 * storage beyond the existing pin store — so the whole policy is unit
 * testable, which is how the forgery regression test is written.
 */

import { isKeyChanged, isUnrecognizedForVerifiedContact, getStoredPub } from './keyVerification';
import type { DirectoryStatus } from './deviceDirectory';

export type SenderVerdict =
    /** Attributed, and consistent with what we have pinned for this device. */
    | 'ok'
    /** Never seen this device of this contact. TOFU: accept, but say so. */
    | 'first_contact'
    /** A device we HAVE seen is presenting a different identity key. */
    | 'key_changed'
    /**
     * The contact has at least one Safety-Number-VERIFIED device, and this key
     * matches none of them. This is the verdict that catches the forgery
     * above: it is keyed on the KEY, not on the device id, so inventing a
     * fresh device id (or omitting `sd` entirely) does not evade it.
     */
    | 'unrecognized_verified'
    /** The server's own directory does not publish this key for this user. */
    | 'unattributed';

/**
 * What kind of payload the envelope carries. The policy differs sharply
 * between the two and that difference is the point — see `actionFor`.
 */
export type PayloadClass = 'content' | 'key_material';

export type TrustAction =
    | 'accept'
    /** Show it, but the user must be told the identity is not trustworthy. */
    | 'accept_warn'
    /** Do not apply it. Reserved for payloads that grant crypto capability. */
    | 'reject';

export interface EvaluateSenderInput {
    myUserId: string;
    /** Claimed sender user id (`su`). */
    theirUserId: string;
    /** Claimed sender identity pub (`sp`). */
    senderPub: string;
    /** Claimed sender device id (`sd`) — absent on v:3 envelopes from a
     *  sender that predates it, and trivially omittable by an attacker. */
    senderDeviceId?: string | null;
    /** Result of `deviceDirectory.status(theirUserId, senderPub, senderDeviceId)`.
     *  Passed in rather than read here so this module stays pure. */
    directory: DirectoryStatus;
}

/**
 * Evaluate one sender claim. Verdicts are ordered most-severe-first and the
 * first match wins, so a message that is BOTH unattributed and unrecognized
 * reports the stronger evidence.
 *
 * `unattributed` outranks the pin-store verdicts because it is the one piece
 * of evidence that does not depend on the user ever having done anything: the
 * server is contradicting the envelope about its own published state.
 */
export function evaluateSender(input: EvaluateSenderInput): SenderVerdict {
    const { myUserId, theirUserId, senderPub, senderDeviceId, directory } = input;
    const sd = senderDeviceId ?? undefined;

    if (directory === 'mismatch') return 'unattributed';

    if (isKeyChanged(myUserId, theirUserId, senderPub, sd)) return 'key_changed';

    // THE F1 CHECK. Deliberately independent of `sd`: that is what closes the
    // "invent a device id / omit sd" bypass which every other check in the pin
    // store is permissive about by design.
    if (isUnrecognizedForVerifiedContact(myUserId, theirUserId, senderPub)) {
        return 'unrecognized_verified';
    }

    if (!getStoredPub(myUserId, theirUserId, sd)) return 'first_contact';

    return 'ok';
}

/**
 * Map a verdict to an action for a given payload class.
 *
 * ── Why content warns and key material rejects ──────────────────────────────
 * These are not the same risk and must not get the same policy.
 *
 * CONTENT (text, reactions, attachments metadata) is inert. A forged message
 * is a lie shown to a human, and a human who is told "this did not come from
 * a verified device" can weigh it. Dropping it instead would be worse: a
 * malicious server can already suppress messages for free, so rejection buys
 * no security while guaranteeing real message loss whenever a legitimate
 * contact adds a device. Show it, mark it.
 *
 * KEY MATERIAL (`call_key`, `channel_key`) is not inert. Accepting it hands
 * the sender a cryptographic capability — the ability to decrypt this call's
 * media, or to read and forge an entire channel epoch — silently, with no
 * human in the loop at any point. There is nothing for the user to weigh
 * because they are never asked. This is exactly the case where fail-closed is
 * correct, and its failure mode is benign and legible: the call falls back to
 * unencrypted-media/failed rather than silently MITM'd, and the user is shown
 * a specific prompt to verify the new device.
 *
 * `first_contact` accepts in both classes, and must: it is the TOFU bootstrap
 * every conversation starts from. Rejecting it would mean no one could ever
 * begin. The protection at first contact is the Safety Number, not this gate.
 *
 * `unrecognized_verified` rejecting key material is the one place this policy
 * is strict enough to inconvenience an honest user: a contact whose safety
 * number you verified adds a genuine new device, and their call key is now
 * refused until you verify it. That is intended. Verifying a contact is an
 * explicit statement of the preference "do not let keys I have not vouched
 * for act on my behalf", and adopting a call media key is precisely such an
 * action. The remedy is in the user's hands and is one modal away.
 */
export function actionFor(verdict: SenderVerdict, payload: PayloadClass): TrustAction {
    if (verdict === 'ok' || verdict === 'first_contact') return 'accept';

    if (payload === 'key_material') return 'reject';

    return 'accept_warn';
}

/** True for any verdict the user must be told about. `first_contact` is not
 *  one: silent TOFU on genuinely-first contact is the established behaviour
 *  everywhere in this client, and warning on it would train the warning away. */
export function isWarnable(verdict: SenderVerdict): boolean {
    return verdict === 'key_changed'
        || verdict === 'unrecognized_verified'
        || verdict === 'unattributed';
}

/**
 * Decides whether a DM's row in the conversation picker earns the red
 * "something is not right" marker, ahead of the user ever opening the chat.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 * True iff `senderWarnings` (Dashboard's map of contact userId -> the most
 * recent verdict `pinAndDetect` judged WARNABLE for them — see its call
 * site, which only ever writes an entry when `isWarnable(verdict)` is true)
 * carries a warnable verdict for this specific contact. Re-checking
 * `isWarnable` here rather than trusting bare key-presence is deliberate:
 * it keeps this function correct even if `senderWarnings` ever gains a
 * non-warnable entry from elsewhere, and it makes the rule this function
 * embodies legible on its own without having to go read `pinAndDetect` to
 * confirm what the map can and can't contain.
 *
 * ── Why plain first contact does NOT qualify ────────────────────────────
 * `senderWarnings` never contains a `first_contact` (or `ok`) entry in the
 * first place — silent TOFU is the whole point of `isWarnable` excluding
 * it (see above). That absence is exactly the severity split this function
 * must preserve: every contact reads unmarked on day one, before the user
 * has ever exchanged a message with them. Marking first contact red would
 * put a red warning on literally every new conversation, which teaches
 * users to treat red as decoration — the same failure mode a fire alarm
 * that goes off for toast trains people to ignore, and it is precisely the
 * cover a REAL key-change warning needs to hide behind. A contact only
 * turns red here once something has actually changed after that first
 * contact (`key_changed`), or a forgery-shaped mismatch was detected
 * (`unrecognized_verified`, `unattributed`) — see `evaluateSender`.
 *
 * Deliberately does not distinguish `key_changed` from the two
 * forgery-shaped verdicts the way `UnverifiedDeviceBanner` does — the
 * picker row has room for one bit (marked / not), not a severity gradient.
 */
export function hasUnverifiedDeviceWarning(
    otherUserId: string | null | undefined,
    senderWarnings: Readonly<Record<string, SenderVerdict>>,
): boolean {
    if (!otherUserId) return false;
    const verdict = senderWarnings[otherUserId];
    return verdict !== undefined && isWarnable(verdict);
}

/** Short, user-facing reason string. Kept here rather than in the component so
 *  the same wording is used by the chat banner and the call banner. */
export function verdictMessage(verdict: SenderVerdict, displayName: string): string {
    switch (verdict) {
        case 'key_changed':
            return `${displayName}'s safety number changed since you last verified. This can happen if they reinstalled or added a device — or if someone is intercepting your messages.`;
        case 'unrecognized_verified':
            return `This came from a device of ${displayName} that you have not verified, even though you have verified them before. Verify their new safety number before trusting it.`;
        case 'unattributed':
            return `${displayName}'s account does not publish the key this was signed with. Treat it as unverified — it may not be from them at all.`;
        default:
            return '';
    }
}
