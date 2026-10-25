/**
 * The first time you verify anyone: a full-screen ceremony, once per account.
 *
 * "Verified" is committed in exactly one place, keyVerification.markVerified
 * (the safety-number modal's per-device button, its Quick-verify code match, and
 * the chat embed's attestation all end there), and that function calls
 * `noteContactVerified` below. Hooking the commit rather than any button is what
 * makes every route count, and what keeps a route added later from forgetting.
 *
 * What it does, in order:
 *   1. The one-time "make sure it's really them" hint is finished for good
 *      (utils/safetyVerifyHint.ts) - someone who has verified no longer needs it.
 *   2. If this account has already had its first-verification ceremony, stop.
 *      The per-account flag is written BEFORE anything is scheduled, so the
 *      modal's "Quick verify" loop (markVerified once per device of the contact)
 *      and a double click can only ever produce one ceremony.
 *   3. If anyone had been verified before this commit - the account is not new to
 *      verification, e.g. it verified before this feature existed - the flag is
 *      spent without playing: this is not their FIRST.
 *   4. Otherwise the ceremony is requested (utils/moments.ts requestCeremony:
 *      guaranteed, no rarity, no dice, no cooldown, no ledger). It starts after
 *      CEREMONY_DELAY_MS so the safety modal's own success animation (the
 *      cl-verify-seal sequence, about 1.2 s) finishes first and is never covered;
 *      the ceremony then overlays whatever is open, and the modal stays usable
 *      underneath once it ends. Escape / a click / any key skips it.
 *
 * Storage: a per-account record in secureLocalStore, excluded from backups
 * (services/backupRegistry.ts) like the hint's - and for the same reason: the
 * pins themselves are never restored from a vault, so a restored device really
 * is one where nobody has been verified yet. Nothing here reaches the network;
 * the only data it carries is the other person's display name, to the overlay.
 */
import { secureLocalStore } from './secureLocalStore';
import { requestCeremony } from './moments';
import { markHintDone, hintStoreReady } from './safetyVerifyHint';

export const FIRST_VERIFY_PLAYED_PREFIX = 'cipherline_first_verify_played_';

/** How long after the commit the ceremony starts: lets the modal's own seal (~1.2 s) finish first. */
export const CEREMONY_DELAY_MS = 1500;

export interface VerifiedCommit {
    myUserId: string;
    /** The other person's display name, when the caller has one. */
    peerName?: string | null;
    /** Had ANY contact been verified on this device before this commit? Must be read before the pin is written. */
    hadVerifiedBefore: boolean;
}

export type FirstVerifyOutcome =
    | 'scheduled'        // first verification ever: the ceremony is on its way
    | 'already-played'   // the account has had its ceremony (or spent its one chance)
    | 'not-first'        // someone was verified before; the flag is spent, nothing plays
    | 'not-ready';       // the account's records are not loaded: say nothing rather than risk a repeat

const playedKey = (userId: string) => FIRST_VERIFY_PLAYED_PREFIX + userId;

/** Has this account's first-verification ceremony been spent? */
export function firstVerifyPlayed(userId: string | null | undefined): boolean {
    if (!userId || !hintStoreReady(userId)) return false;
    try { return secureLocalStore.getItem(playedKey(userId)) === '1'; } catch { return false; }
}

/**
 * Called by keyVerification.markVerified right after a pin is written verified.
 * Never throws: a failure here must not undo or hide a verification.
 */
export function noteContactVerified(c: VerifiedCommit): FirstVerifyOutcome {
    try { markHintDone(c.myUserId, 'verified'); } catch { /* the hint is a nicety */ }
    try {
        if (!hintStoreReady(c.myUserId)) return 'not-ready';
        if (secureLocalStore.getItem(playedKey(c.myUserId)) === '1') return 'already-played';
        secureLocalStore.setItem(playedKey(c.myUserId), '1');
        if (c.hadVerifiedBefore) return 'not-first';
        const peer = c.peerName ?? null;
        setTimeout(() => requestCeremony('safety-verified', { peer }), CEREMONY_DELAY_MS);
        return 'scheduled';
    } catch {
        return 'not-ready';
    }
}
