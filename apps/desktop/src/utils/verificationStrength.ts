/**
 * Verification provenance: HOW STRONG was the comparison behind a pinned
 * `verified: true`?
 *
 * The pin store (`keyVerification.ts`, `kv_verify_v2_{me}_{them}`) records
 * that the user vouched for a device's key. Until safety-number v2 it did not
 * record what they compared to do so, and one of the two routes was weak:
 *
 *   - the 40-character contact code: per-party and 200 bits, always sound;
 *   - the by-eye digits: safety number v1, a single hash over BOTH keys that a
 *     key-directory MITM could defeat with a ~2^50 collision search (G1, see
 *     `safetyNumber.ts`).
 *
 * A record cannot say which route produced it, so every `verified: true`
 * written before this field existed is treated as `legacy`. Every write from
 * now on stamps `sv: VERIFICATION_STRENGTH`. The field is additive and
 * per-record. The store's own layout version (`v: 2`) is unchanged, and older
 * builds and the mobile port simply ignore it. A record they rewrite comes
 * back without `sv`, and so reads as legacy again. That is the correct,
 * conservative answer for a verification made by a client that still showed
 * v1 digits.
 *
 * What `legacy` changes, and what it deliberately does not:
 *
 *   - It does NOT weaken any enforcement. A legacy-verified key is still a
 *     vouched-for trust anchor: key-change and unrecognised-device alarms keep
 *     firing against it exactly as before. Downgrading it to unverified would
 *     have switched those alarms OFF for every verified contact.
 *   - It DOES stop the contact reading as a full green "Verified". The trust
 *     level becomes `verified_legacy` ("Re-check suggested"), a calm state,
 *     not a warning, until the user compares once more with a v2 check.
 *
 * Pure and import-free on purpose: the writer (`keyVerification`) and the
 * readers (`contactTrust`, the embed, the modal) must agree on the rule, and
 * tests that mock the pin store must not have to re-implement it.
 */

/** The strength generation a verification made today carries. */
export const VERIFICATION_STRENGTH = 2;

export interface VerificationRecordLike {
    verified: boolean;
    /** Absent on every record written before safety-number v2. */
    sv?: number;
}

/** Vouched for, but on a comparison older than the current strength. */
export function isLegacyVerified(rec: VerificationRecordLike | null | undefined): boolean {
    if (!rec || !rec.verified) return false;
    return typeof rec.sv !== 'number' || rec.sv < VERIFICATION_STRENGTH;
}
