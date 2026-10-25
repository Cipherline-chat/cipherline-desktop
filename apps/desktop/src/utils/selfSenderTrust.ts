/**
 * Trust verdict for an envelope that claims to come from the signed-in user's
 * OWN account (`su === me`).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every inbound DM envelope names its sender (`su`), the sender's identity key
 * (`sp`) and device (`sd`) inside the ciphertext, and the signature is checked
 * against that same `sp`, so all three are the sender's choice (see
 * senderTrust.ts). For other users, `evaluateSender` judges the claim against
 * the published directory and the Safety-Number pins. Envelopes claiming
 * `su === me` used to skip that judgement entirely — treated as "mine" and
 * accepted, key material included — so anyone able to address an envelope to
 * this device could name this user as the sender and be believed.
 *
 * A self claim is judged against the one source that is this install's own
 * memory of the account's devices: the own-device ledger (ownDeviceLedger.ts),
 * plus this device's own identity key. The published directory is consulted
 * only before a ledger exists, and only as first-contact evidence.
 *
 * Verdicts reuse `SenderVerdict`, so `actionFor` applies unchanged:
 *   ok                    this device, or a baseline/confirmed own device
 *   first_contact         no ledger yet; the directory lists the key for me
 *   unrecognized_verified an own device the user has not vouched for yet
 *                         (`pending` — the ghost-device banner is already up)
 *   key_changed           a known own device id presenting a different key
 *   unattributed          not one of my devices at all, rejected, or gone
 *
 * Key material is accepted only for `ok` / `first_contact`. Content from an
 * `unattributed` / `key_changed` self claim is not shown as the user's own
 * message (the caller stores a placeholder instead).
 *
 * Pure: the caller passes the ledger snapshot and directory status.
 */

import type { OwnLedger, OwnDeviceStatus } from './ownDeviceLedger';
import type { DirectoryStatus } from './deviceDirectory';
import type { SenderVerdict } from './senderTrust';

export interface SelfSenderInput {
    /** Claimed sender identity pub (`sp`). */
    senderPub: string;
    /** Claimed sender device id (`sd`); optional on the wire. */
    senderDeviceId?: string | null;
    /** This device's id and LOCAL identity pub, or null when not known yet. */
    self: { deviceId: string; pub: string } | null;
    /** `loadOwnLedger(me)`: a ledger, null (none yet) or undefined (store cold). */
    ledger: OwnLedger | null | undefined;
    /** `deviceDirectory.status(me, sp, sd)` — used only when there is no ledger. */
    directory: DirectoryStatus;
}

export interface SelfSenderResult {
    verdict: SenderVerdict;
    /**
     * False when the claimed device is simply not in the ledger. A genuinely
     * new own device is listed by the server before this install has seen a
     * complete listing that includes it, so the caller may refresh the own
     * listing once and re-evaluate.
     */
    known: boolean;
}

function fromStatus(status: OwnDeviceStatus, gone: boolean): SenderVerdict {
    if (gone) return 'unattributed';
    switch (status) {
        case 'baseline':
        case 'confirmed':
            return 'ok';
        case 'pending':
            return 'unrecognized_verified';
        default:
            return 'unattributed';
    }
}

export function evaluateSelfSender(input: SelfSenderInput): SelfSenderResult {
    const { senderPub: sp, self, ledger, directory } = input;
    const sd = input.senderDeviceId || null;
    if (!sp) return { verdict: 'unattributed', known: true };

    if (self?.pub && sp === self.pub) {
        // This device's own key. Only valid under this device's own id.
        return { verdict: sd && sd !== self.deviceId ? 'unattributed' : 'ok', known: true };
    }
    if (self && sd === self.deviceId) return { verdict: 'unattributed', known: true };

    if (ledger) {
        if (sd) {
            const rec = ledger.devices[sd];
            if (rec) {
                if (rec.pub !== sp) return { verdict: 'key_changed', known: true };
                return { verdict: fromStatus(rec.status, rec.gone_at !== undefined), known: true };
            }
        }
        const byPub = Object.entries(ledger.devices).find(([, r]) => r.pub === sp);
        if (byPub) {
            // The key is one of mine, but under a different device id than the
            // one claimed: a device id is never shared, so the claim is false.
            if (sd && byPub[0] !== sd) return { verdict: 'unattributed', known: true };
            return { verdict: fromStatus(byPub[1].status, byPub[1].gone_at !== undefined), known: true };
        }
        return { verdict: 'unattributed', known: false };
    }

    // No ledger yet (fresh install before its first complete own listing, or
    // the account store is cold): the directory is the only evidence there is.
    if (directory === 'match') return { verdict: 'first_contact', known: true };
    return { verdict: 'unattributed', known: false };
}

/** Self content that must not be rendered as the user's own message. */
export function selfContentRefused(verdict: SenderVerdict): boolean {
    return verdict === 'unattributed' || verdict === 'key_changed';
}
