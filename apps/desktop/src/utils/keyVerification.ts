import { secureLocalStore } from './secureLocalStore';
import { VERIFICATION_STRENGTH, isLegacyVerified } from './verificationStrength';

export type VerificationState = 'unverified' | 'verified' | 'key_changed';

// ── RC-7 / Phase 5: per-(user, device) TOFU pin store ───────────────────────
//
// v1 pinned exactly one identity pub per (myUserId, theirUserId) and never
// refreshed it. But every device has its own identity key by design
// (multi-device — see CLAUDE.md) — a contact's second device read as an
// "identity changed" event under v1, and on the channel-key distribution
// path (Dashboard.tsx pullChannelKeys) that mismatch was a hard rejection,
// not just a banner. A user whose distributing device rotated (reinstall,
// new device, or simply a different device answering the key request than
// the one that minted it) could get permanently stuck.
//
// v2 keys the pin store per device instead: `kv_verify_v2_{me}_{them}` →
// { v:2, devices: { [deviceId]: { pub, verified, first_seen, last_seen } } }.
// A device id we've never seen is a NEW device, not a changed one — that's
// the entire fix. Senders that don't yet carry `sd` (the sealed-wrapper
// sender-device-id field, additive as of Phase 5) bucket under a
// deterministic hash of the pub instead, and get transparently adopted into
// the real device id the first time a message from that same device does
// carry `sd` — so a pre-Phase-5 pin's `verified` status isn't lost the
// moment the other side upgrades.
//
// Migration from v1 is lazy and non-destructive: the legacy key is read
// once (if no v2 record exists yet) and folded in under a pub-bucket, but
// NEVER deleted — a rollback to a pre-Phase-5 build finds its data exactly
// where it left it.
//
// Safety-number v2 adds one optional per-record field, `sv` (verification
// strength). `markVerified` stamps it; a `verified: true` record without it,
// including every v1-migrated record, is a LEGACY verification. See
// `verificationStrength.ts` for what that does and does not change. The store
// layout stays `v: 2`: the field is additive and older readers ignore it.

const V1_PREFIX = 'kv_verify_';
const V2_PREFIX = 'kv_verify_v2_';

interface DeviceRecord {
    pub: string;
    verified: boolean;
    first_seen: number;
    last_seen: number;
    /** Strength of the comparison behind `verified`. Absent = legacy. */
    sv?: number;
}

interface V2Store {
    v: 2;
    devices: Record<string, DeviceRecord>;
}

interface LegacyRecord {
    pub: string;
    verified: boolean;
}

function v1Key(myUserId: string, theirUserId: string): string {
    return `${V1_PREFIX}${myUserId}_${theirUserId}`;
}

function v2Key(myUserId: string, theirUserId: string): string {
    return `${V2_PREFIX}${myUserId}_${theirUserId}`;
}

/**
 * Deterministic, non-cryptographic bucket key for a pub we don't have a
 * device id for (pre-Phase-5 sender, or a caller that genuinely has none).
 * Only needs to be stable per-pub and distinct from a real device UUID —
 * not a security boundary, just a local bookkeeping key.
 */
function pubBucketKey(pub: string): string {
    let h = 0;
    for (let i = 0; i < pub.length; i++) h = (h * 31 + pub.charCodeAt(i)) | 0;
    return `pub:${(h >>> 0).toString(16)}`;
}

function readStore(myUserId: string, theirUserId: string): V2Store {
    const raw = secureLocalStore.getItem(v2Key(myUserId, theirUserId));
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.v === 2 && parsed.devices && typeof parsed.devices === 'object') {
                return parsed as V2Store;
            }
        } catch { /* corrupt — fall through and rebuild (still tries legacy migration below) */ }
    }

    // No v2 record yet — lazily migrate the legacy single-pub record, if any.
    // Left in place on disk (never deleted) for rollback safety.
    const store: V2Store = { v: 2, devices: {} };
    const legacyRaw = secureLocalStore.getItem(v1Key(myUserId, theirUserId));
    if (legacyRaw) {
        try {
            const legacy = JSON.parse(legacyRaw) as LegacyRecord;
            if (legacy && legacy.pub) {
                const now = Date.now();
                store.devices[pubBucketKey(legacy.pub)] = {
                    pub: legacy.pub,
                    verified: !!legacy.verified,
                    first_seen: now,
                    last_seen: now,
                };
            }
        } catch { /* nothing usable to migrate */ }
    }
    return store;
}

function writeStore(myUserId: string, theirUserId: string, store: V2Store): void {
    secureLocalStore.setItem(v2Key(myUserId, theirUserId), JSON.stringify(store));
}

/**
 * Adopt a pub-bucket entry into a real device id the first time that device
 * is actually identified (an `sd`-carrying message arrives). Carries
 * `verified`/`first_seen` forward so upgrading a peer never resets a prior
 * verification. No-op if `deviceId` already has its own record, or there's
 * no matching bucket to adopt.
 */
function adopt(store: V2Store, deviceId: string, incomingPub: string): void {
    if (store.devices[deviceId]) return;
    const bucket = pubBucketKey(incomingPub);
    const legacy = store.devices[bucket];
    if (legacy && legacy.pub === incomingPub) {
        store.devices[deviceId] = legacy;
        delete store.devices[bucket];
    }
}

/**
 * Returns the verification state for a contact.
 * - 'unverified'   — no prior contact (for this device) or never verified
 * - 'verified'     — user confirmed the safety number for this device
 * - 'key_changed'  — a KNOWN device's identity key changed since first-seen
 *
 * `deviceId` should be supplied whenever the caller has one (from
 * DecryptResult.senderDeviceId or a channel message's sender_device_id) —
 * it's what makes the mismatch check per-device instead of per-user.
 * Without it (omitted or the sender predates Phase 5), returns an aggregate
 * view: 'verified' only when every device ever pinned for this contact has
 * been individually verified — an unverified device is exactly as
 * trustworthy as day one, so one unverified device keeps the aggregate from
 * reading as secure. This path never returns 'key_changed' — a mismatch is
 * only ever meaningful against a specific, previously-known device.
 */
export function getVerificationState(
    myUserId: string,
    theirUserId: string,
    incomingPub?: string,
    deviceId?: string,
): VerificationState {
    return getDeviceVerification(myUserId, theirUserId, incomingPub, deviceId).state;
}

/**
 * `getVerificationState`, plus whether a `verified` answer rests on a LEGACY
 * comparison (made before safety-number v2; see `verificationStrength.ts`).
 * Same lookup, including pub-bucket adoption, so the two can never disagree
 * about which record they read. `legacy` is only ever true alongside
 * `state: 'verified'`.
 */
export function getDeviceVerification(
    myUserId: string,
    theirUserId: string,
    incomingPub?: string,
    deviceId?: string,
): { state: VerificationState; legacy: boolean } {
    const store = readStore(myUserId, theirUserId);

    if (deviceId) {
        if (incomingPub) adopt(store, deviceId, incomingPub);
        const record = store.devices[deviceId];
        if (!record) return { state: 'unverified', legacy: false };
        if (incomingPub && incomingPub !== record.pub) return { state: 'key_changed', legacy: false };
        return record.verified
            ? { state: 'verified', legacy: isLegacyVerified(record) }
            : { state: 'unverified', legacy: false };
    }

    const records = Object.values(store.devices);
    if (!records.length) return { state: 'unverified', legacy: false };
    return records.every(r => r.verified)
        ? { state: 'verified', legacy: records.some(r => isLegacyVerified(r)) }
        : { state: 'unverified', legacy: false };
}

/**
 * Record the first-seen identity pub for a contact's device (no-op on the
 * stored pub if a record already exists for that device — only refreshes
 * last_seen; does NOT reset verification state on re-record). Without a
 * `deviceId`, buckets by a hash of the pub so a later `sd`-carrying message
 * from the same device can adopt this record instead of starting fresh.
 */
export function recordFirstSeen(
    myUserId: string,
    theirUserId: string,
    incomingPub: string,
    deviceId?: string,
): void {
    const store = readStore(myUserId, theirUserId);
    const now = Date.now();
    const key = deviceId ?? pubBucketKey(incomingPub);
    if (deviceId) adopt(store, deviceId, incomingPub);

    const existing = store.devices[key];
    if (existing) {
        existing.last_seen = now;
    } else {
        store.devices[key] = { pub: incomingPub, verified: false, first_seen: now, last_seen: now };
    }
    writeStore(myUserId, theirUserId, store);
}

/**
 * True iff `incomingPub` differs from the pub already pinned for a
 * previously-seen device. RC-7: a device we haven't seen before — no
 * `deviceId` supplied, or one this store has no record for yet — is a NEW
 * device, never a "change". That distinction (device-scoped, not
 * user-scoped) is the entire per-device TOFU fix.
 */
export function isKeyChanged(
    myUserId: string,
    theirUserId: string,
    incomingPub: string,
    deviceId?: string,
): boolean {
    if (!deviceId) return false;
    const store = readStore(myUserId, theirUserId);
    const record = store.devices[deviceId];
    return !!record && record.pub !== incomingPub;
}

/**
 * Hardening follow-up (F1 — critical): closes the sd-omission TOFU bypass.
 *
 * Every hard-mismatch check in this module (`isKeyChanged`, and every
 * Dashboard.tsx call site that gates on `getStoredPub`) is keyed on
 * `deviceId` — deliberately permissive when it's missing, so a genuinely
 * new device (the common, expected case) is never hard-rejected (RC-7).
 * But "permissive when deviceId is missing" also meant "completely
 * silent" — a message/envelope with `sd` omitted (or from an unrecognized
 * device id) was treated as indistinguishable from first-ever contact,
 * even for a contact the user had ALREADY Safety-Number-verified a
 * specific device for. Nothing cryptographic ties `sp` to `su`/`sd` — the
 * Ed25519 signature only proves self-consistency (whoever holds `sp`'s
 * private key really did sign this), never that `sp` is the identity the
 * recipient has actually vouched for. That binding is this module's job
 * alone, and the sd-omission path fell through it entirely.
 *
 * This is the additive, NON-blocking signal that closes that gap: true
 * iff the contact has at least one Safety-Number-VERIFIED device pinned
 * AND `incomingPub` doesn't match any of them (regardless of `deviceId`).
 * Callers surface this as the same "safety number changed" banner as a
 * genuine key_changed event (Dashboard.tsx's `keyChangedSenders`) — never
 * a thrown/rejected envelope. Deliberately never fires when the contact
 * has no verified device yet (nothing to compare against — matches the
 * existing first-contact-is-silent TOFU default everywhere else here).
 */
export function isUnrecognizedForVerifiedContact(
    myUserId: string,
    theirUserId: string,
    incomingPub: string,
): boolean {
    const store = readStore(myUserId, theirUserId);
    const verifiedPubs = Object.values(store.devices).filter(r => r.verified);
    if (!verifiedPubs.length) return false;
    return !verifiedPubs.some(r => r.pub === incomingPub);
}

/**
 * Update the stored pub for a device when a key change is acknowledged
 * (e.g. user clicks "I understand" on the warning). Resets verified state
 * to false for that device only.
 */
export function acknowledgeKeyChange(
    myUserId: string,
    theirUserId: string,
    newPub: string,
    deviceId?: string,
): void {
    const store = readStore(myUserId, theirUserId);
    const key = deviceId ?? pubBucketKey(newPub);
    const now = Date.now();
    store.devices[key] = {
        pub: newPub,
        verified: false,
        first_seen: store.devices[key]?.first_seen ?? now,
        last_seen: now,
    };
    writeStore(myUserId, theirUserId, store);
}

/**
 * Mark one specific device as verified after the user confirms its safety
 * number matches out-of-band. Verification is per-device — verifying one
 * device of a contact says nothing about their other devices.
 *
 * Stamps `sv: VERIFICATION_STRENGTH`. Every caller compares a current-strength
 * check (a v2 safety number or the per-party contact code), and re-marking a
 * legacy record is how it is refreshed.
 */
export function markVerified(
    myUserId: string,
    theirUserId: string,
    theirPub: string,
    deviceId?: string,
): void {
    const store = readStore(myUserId, theirUserId);
    if (deviceId) adopt(store, deviceId, theirPub);
    const key = deviceId ?? pubBucketKey(theirPub);
    const now = Date.now();
    store.devices[key] = {
        pub: theirPub,
        verified: true,
        first_seen: store.devices[key]?.first_seen ?? now,
        last_seen: now,
        sv: VERIFICATION_STRENGTH,
    };
    writeStore(myUserId, theirUserId, store);
}

/**
 * Retrieve the stored identity pub for one of a contact's devices, or null
 * if not seen yet. Without `deviceId`, only returns a value when exactly
 * one device has ever been pinned for this contact — with more than one,
 * "the" pub is ambiguous and callers should pass a specific device id.
 */
export function getStoredPub(myUserId: string, theirUserId: string, deviceId?: string): string | null {
    const store = readStore(myUserId, theirUserId);
    if (deviceId) return store.devices[deviceId]?.pub ?? null;
    const all = Object.values(store.devices);
    return all.length === 1 ? all[0].pub : null;
}

/** All known devices pinned for a contact, keyed by device id (or pub-bucket
 *  key for a device seen before `sd` existed). Used by SafetyVerificationModal
 *  to show one safety number per known device instead of just the first. */
export function getKnownDevices(myUserId: string, theirUserId: string): Record<string, DeviceRecord> {
    return readStore(myUserId, theirUserId).devices;
}
