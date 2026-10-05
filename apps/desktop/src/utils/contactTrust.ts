/**
 * Contact trust level — the single vocabulary behind every verification icon.
 *
 * ── Why this module exists at all ───────────────────────────────────────────
 *
 * There were already two notions of "verified" in the client and they did not
 * agree. `senderTrust.evaluateSender` judges ONE envelope (is this key
 * attributable to the claimed sender?); `keyVerification.getVerificationState`
 * judges the PIN STORE (did the user ever vouch for this key out of band?).
 * They answer different questions and neither is sufficient alone:
 *
 *   • A verdict of 'ok' means "pinned and unchanged". It does NOT mean the user
 *     ever compared a safety number. Rendering a green shield off 'ok' would
 *     award the strongest badge in the app to plain TOFU.
 *   • A pin-store 'verified' says nothing about whether THIS envelope's key is
 *     one of the vouched-for ones. That is exactly the F1 forgery.
 *
 * So the badge is a function of both, and this module is the only place that
 * composition is written down. Adding a third independent notion of "verified"
 * somewhere else is how the green shield eventually ends up lying.
 *
 * ── The mapping from senderTrust's vocabulary ───────────────────────────────
 *
 *   'unattributed'           -> 'compromised'  (red)
 *   'key_changed'            -> 'compromised'  (red)
 *   'unrecognized_verified'  -> 'compromised'  (red)
 *   'ok' | 'first_contact'   -> defer to the pin store (below)
 *   null (no envelope judged) -> defer to the pin store
 *
 * All three warnable verdicts are red, not yellow. `unrecognized_verified` in
 * particular is strictly WORSE than never having verified: it means a contact
 * the user has vouched for is presenting a key the user never vouched for,
 * which is the exact shape of a sender-identity forgery. Yellow reads as
 * "you haven't got round to this yet" and would actively mislead.
 *
 * The three are kept distinct in `verdict` rather than collapsed, so the
 * tooltip can reuse `senderTrust.verdictMessage` verbatim instead of inventing
 * a parallel set of explanations.
 *
 * ── What "verified" means for a contact with several devices ────────────────
 *
 * Every device has its own identity key by design, so verification is
 * per-device and a contact is a SET of verification states, not one.
 * The honest aggregate depends on which direction the risk runs:
 *
 *   • Inbound ("is this really from them?") depends only on the key that
 *     actually signed the thing in front of you — one device.
 *   • Outbound ("can only they read what I send?") depends on ALL of them: a
 *     DM is addressed to every one of a contact's devices, so a single
 *     unverified device is an unvouched key receiving your plaintext.
 *
 * A DM and a call are both bidirectional, so the contact-level claim is the
 * outbound one: full green requires EVERY known device verified. When the
 * device in front of you is verified but a sibling is not, that is
 * 'partially_verified' — deliberately NOT green, because "3 of 4" is not what
 * a green shield says. It gets its own icon so it is distinguishable at a
 * glance from plain 'unverified', which is a different and milder situation.
 */

import type { SenderVerdict } from './senderTrust';
import { isWarnable } from './senderTrust';
import { isLegacyVerified, type VerificationRecordLike } from './verificationStrength';

export type TrustLevel =
    /** Every device this client knows of for the contact is vouched for. */
    | 'verified'
    /**
     * Every device is vouched for, but at least one vouch predates
     * safety-number v2, so it may rest on the collision-weak v1 digits (G1).
     * NOT green and NOT a warning: a calm "re-check suggested". Enforcement
     * still treats these keys as vouched for (see `verificationStrength.ts`).
     */
    | 'verified_legacy'
    /** The device in front of you is vouched for; at least one sibling is not. */
    | 'partially_verified'
    /** Keys are on record but the user has never confirmed any of them. */
    | 'unverified'
    /** Nothing to verify against — no identity keys known for this contact. */
    | 'unverifiable'
    /** A warnable senderTrust verdict. Actively suspicious, not merely unconfirmed. */
    | 'compromised';

export interface DeviceTrust {
    deviceId: string;
    verified: boolean;
    /** Verified on a pre-v2 comparison. Meaningless when `verified` is false. */
    legacy?: boolean;
}

/**
 * The ONE mapping from pin-store records to trust input. Every caller that
 * feeds `getKnownDevices` into `deriveContactTrust` goes through here, so none
 * can drop the `legacy` bit and quietly paint a pre-v2 verification green.
 */
export function pinsToTrustDevices(records: Record<string, VerificationRecordLike>): DeviceTrust[] {
    return Object.entries(records).map(([deviceId, rec]) => ({
        deviceId,
        verified: !!rec.verified,
        legacy: isLegacyVerified(rec),
    }));
}

/**
 * Ghost-device fix, contact side (docs/ghost-device.md §2.4): count devices
 * the directory is PUBLISHING for the contact that the pin store has never
 * recorded, as unverified.
 *
 * Pins are written only by received envelopes and `markVerified`, so a device
 * added after verification that never sends is invisible to them. The send
 * path addresses it anyway, which left the shield green while every DM and
 * `call_key` also went to a device nobody vouched for.
 *
 * A published device is "already known" when its device id is in `devices` OR
 * its pub is one of `pinnedPubs`. The pub match covers records pinned before
 * `sd` existed, which live under a `pub:` bucket key instead of the device id.
 *
 * Never writes. The result only feeds `deriveContactTrust`: a server response
 * can lower the badge, and it can never raise it or seed a pin.
 */
export function addUnpinnedPublished(
    devices: DeviceTrust[],
    pinnedPubs: readonly string[],
    published: Record<string, string> | null | undefined,
): DeviceTrust[] {
    if (!published) return devices;
    const ids = new Set(devices.map(d => d.deviceId));
    const pubs = new Set(pinnedPubs);
    const extra: DeviceTrust[] = [];
    for (const [deviceId, pub] of Object.entries(published)) {
        if (!deviceId || !pub || ids.has(deviceId) || pubs.has(pub)) continue;
        extra.push({ deviceId, verified: false });
    }
    return extra.length ? [...devices, ...extra] : devices;
}

export interface ContactTrustInput {
    /**
     * Verdict for the specific envelope in front of the user (a `call_key`, a
     * message), when there is one. `null` for a contact-level badge that is not
     * about any one envelope — e.g. the shield in the chat header.
     */
    verdict?: SenderVerdict | null;
    /** Every device this client has pinned for the contact. */
    devices: DeviceTrust[];
    /**
     * The device that sent the thing being judged, when known. Only meaningful
     * alongside `verdict`; it is what separates 'partially_verified' from
     * 'unverified'.
     */
    activeDeviceId?: string | null;
}

export interface ContactTrust {
    level: TrustLevel;
    /** Carried through so the tooltip can use `verdictMessage` rather than a copy. */
    verdict: SenderVerdict | null;
    verifiedCount: number;
    deviceCount: number;
}

export function deriveContactTrust(input: ContactTrustInput): ContactTrust {
    const { verdict = null, devices, activeDeviceId = null } = input;

    const deviceCount = devices.length;
    const verifiedCount = devices.filter(d => d.verified).length;
    const base = { verdict, verifiedCount, deviceCount };

    // A warnable verdict outranks everything the pin store could say. It is
    // evidence about the thing actually in front of the user, and two of the
    // three verdicts (`unattributed`, `unrecognized_verified`) can be true of a
    // contact whose every pinned device is verified — which is precisely when
    // deferring to the pin store would paint a forgery green.
    if (verdict && isWarnable(verdict)) return { ...base, level: 'compromised' };

    if (deviceCount === 0) return { ...base, level: 'unverifiable' };

    if (verifiedCount === deviceCount) {
        // Full coverage. Green only if every vouch is current-strength: one
        // legacy vouch is enough to withhold it, because green is a claim
        // about ALL of the contact's keys.
        return { ...base, level: devices.some(d => d.verified && d.legacy) ? 'verified_legacy' : 'verified' };
    }

    if (verifiedCount === 0) return { ...base, level: 'unverified' };

    // Some verified, some not.
    //
    // When a specific device is in front of the user (an incoming call's
    // caller device) and THAT device is not vouched for, the answer is plain
    // 'unverified' — a verified sibling says nothing about the key actually
    // being used, and letting it soften the badge would be the same category
    // error as reading 'ok' as "verified".
    //
    // Otherwise — the contact-level view, which is what the verification modal
    // and the chat header show — 'partially_verified' is the honest summary.
    // Reporting "Not verified" while listing two green devices understates what
    // the user has already done and teaches them the badge is not tracking
    // their work; reporting "Verified" would be the far worse lie in the other
    // direction. The fraction in the label is what keeps it precise.
    if (activeDeviceId) {
        const active = devices.find(d => d.deviceId === activeDeviceId);
        if (!active?.verified) return { ...base, level: 'unverified' };
    }

    return { ...base, level: 'partially_verified' };
}

/**
 * One-line label for the badge. Short enough to sit next to an icon.
 *
 * The three 'compromised' verdicts get DIFFERENT labels rather than a shared
 * "Identity warning". They are red for the same reason but they are not the
 * same event and the user's next move differs — "they reinstalled, re-verify"
 * versus "the server is not publishing this key at all". A single shared label
 * also collapses them for anyone reading by screen reader, where the label is
 * the whole badge: the tooltip that carries the distinction is only announced
 * while it is open.
 */
export function trustLabel(t: ContactTrust): string {
    switch (t.level) {
        case 'verified':           return 'Verified';
        case 'verified_legacy':    return 'Re-check suggested';
        case 'partially_verified': return `Partly verified (${t.verifiedCount}/${t.deviceCount})`;
        case 'unverified':         return 'Not verified';
        case 'unverifiable':       return 'No keys on record';
        case 'compromised':
            switch (t.verdict) {
                case 'key_changed':           return 'Safety number changed';
                case 'unrecognized_verified': return 'Unvouched device';
                case 'unattributed':          return 'Key not published';
                default:                      return 'Identity warning';
            }
    }
}

/**
 * The hover explanation. Every branch answers "why am I seeing this colour",
 * which is the question the user actually has — a badge that only restates its
 * own name teaches nothing and gets ignored.
 *
 * For 'compromised' the caller should prefer `verdictMessage(t.verdict, name)`
 * from senderTrust, which is specific to which forgery shape was detected; this
 * is the fallback for when no verdict was carried through.
 */
export function trustExplanation(t: ContactTrust, displayName: string): string {
    switch (t.level) {
        case 'verified':
            return t.deviceCount > 1
                ? `You have confirmed all ${t.deviceCount} of ${displayName}'s devices out of band. Messages and calls with them are end-to-end encrypted to keys you have personally vouched for.`
                : `You have confirmed ${displayName}'s identity out of band. Messages and calls with them are end-to-end encrypted to a key you have personally vouched for.`;
        case 'verified_legacy':
            // Calm by design: nothing is known to be wrong. The one fact is
            // that a past check used a weaker number than the app shows now.
            return `You verified ${displayName} before Cipherline strengthened its safety numbers. That still protects you: you will be warned if their keys change. But the older check was shorter, so compare codes with them once more to restore the full green shield.`;
        case 'partially_verified': {
            // Worded without "this device", because the same string is shown on
            // a call badge (where there IS one specific device) and on the
            // contact-level modal header (where there is not).
            const left = t.deviceCount - t.verifiedCount;
            return `You have confirmed ${t.verifiedCount} of ${displayName}'s ${t.deviceCount} devices. The other ${left} ${left === 1 ? 'is' : 'are'} not verified — and everything you send reaches ${left === 1 ? 'it' : 'them'} too. Verify the rest for a full green shield.`;
        }
        case 'unverified':
            // No call to action here: this string is also shown on the incoming-call
            // badge, which is not clickable, and telling someone to click something
            // that isn't there is worse than saying nothing. `TrustBadge` appends the
            // affordance line itself, and only when it actually has one.
            return `You have never confirmed ${displayName}'s identity out of band. The encryption is working, but nothing except the server's word says these keys are really theirs.`;
        case 'unverifiable':
            return `${displayName} has no encryption keys on record yet, so there is nothing to verify. Wait until they have connected from a device.`;
        case 'compromised':
            return `${displayName}'s identity does not check out. Do not treat this as confirmed until you have verified their safety number again.`;
    }
}
