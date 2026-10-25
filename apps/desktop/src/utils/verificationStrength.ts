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
 * Owner decision 2026-10-23: the "Re-check suggested" nudge no longer depends
 * on that generation (`sv`). It depends on AGE: a verification (`verified_at`,
 * stamped by every `markVerified`) that is a year old, on devices that have
 * not changed, reads as `legacy`. `sv` is still recorded but decides nothing.
 *
 * What `legacy` changes, and what it deliberately does not:
 *
 *   - It does NOT weaken any enforcement. A legacy-verified key is still a
 *     vouched-for trust anchor: key-change and unrecognised-device alarms keep
 *     firing against it exactly as before. Downgrading it to unverified would
 *     have switched those alarms OFF for every verified contact.
 *   - It DOES stop the contact reading as a full green "Verified". The trust
 *     level becomes `verified_legacy` ("Re-check suggested"), a calm state,
 *     not a warning, until the user compares once more.
 *
 * Pure and import-free on purpose: the writer (`keyVerification`) and the
 * readers (`contactTrust`, the embed, the modal) must agree on the rule, and
 * tests that mock the pin store must not have to re-implement it.
 */

/** The strength generation a verification made today carries. */
export const VERIFICATION_STRENGTH = 2;

/** A verification this old reads as "Re-check suggested" (owner decision 2026-10-23). */
export const RECHECK_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

export interface VerificationRecordLike {
    verified: boolean;
    /** Absent on every record written before safety-number v2. Kept for the record; no longer decides the level. */
    sv?: number;
    /** When the user last compared codes for this key (ms). Absent on records written before 2026-10-23. */
    verified_at?: number;
}

/**
 * Vouched for, but long enough ago that a fresh comparison is worth suggesting.
 *
 * Owner decision 2026-10-23: the re-check nudge is about AGE, not about which
 * safety-number generation produced the pin. A verification is suggested for a
 * re-check once it is a year old; before that it is a plain green "Verified".
 * Unknown age (no `verified_at`) = no nag.
 * A changed or added device never reaches this state: it is a key-change /
 * unvouched-device / partly-verified verdict instead (contactTrust.ts), so this
 * only ever means "same devices, compared a while ago".
 */
export function isLegacyVerified(rec: VerificationRecordLike | null | undefined, now: number = Date.now()): boolean {
    if (!rec || !rec.verified) return false;
    // Records from before `verified_at` existed carry no comparison date
    // (`first_seen` is when the KEY was pinned, not when codes were compared),
    // so they are not nagged; their next re-verification stamps the clock.
    const at = rec.verified_at;
    if (typeof at !== 'number' || !Number.isFinite(at)) return false;
    return now - at >= RECHECK_AFTER_MS;
}
