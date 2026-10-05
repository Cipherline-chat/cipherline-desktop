import { describe, it, expect, beforeEach, vi } from 'vitest';

// keyVerification.ts only touches secureLocalStore.getItem/setItem — a
// simple in-memory Map stands in for the real (IndexedDB + WebCrypto-backed)
// store, same pattern as e2eeEngine.smoke.test.ts's electron/storage mock.
const mem = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
    },
}));

const {
    getVerificationState,
    recordFirstSeen,
    isKeyChanged,
    acknowledgeKeyChange,
    markVerified,
    getStoredPub,
    getKnownDevices,
    isUnrecognizedForVerifiedContact,
} = await import('./keyVerification');

const ME = 'me-user';
const THEM = 'them-user';
const DEV_A = 'device-aaaa';
const DEV_B = 'device-bbbb';
const PUB_A = 'pubA==';
const PUB_B = 'pubB==';

beforeEach(() => {
    mem.clear();
});

describe('RC-7: per-device TOFU pinning', () => {
    it('first sighting of a device is never a key change', () => {
        expect(isKeyChanged(ME, THEM, PUB_A, DEV_A)).toBe(false);
    });

    it('a second, previously-unseen device is never a key change — the core RC-7 fix', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        // Same contact, a DIFFERENT device with a DIFFERENT identity key —
        // this is exactly the multi-device case that used to hard-reject
        // channel keys under the old per-(user) pin.
        expect(isKeyChanged(ME, THEM, PUB_B, DEV_B)).toBe(false);
        recordFirstSeen(ME, THEM, PUB_B, DEV_B);
        // Both devices are now known, independently, with their own pubs.
        expect(getStoredPub(ME, THEM, DEV_A)).toBe(PUB_A);
        expect(getStoredPub(ME, THEM, DEV_B)).toBe(PUB_B);
    });

    it('a genuine change on an ALREADY-KNOWN device is flagged', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        expect(isKeyChanged(ME, THEM, PUB_B, DEV_A)).toBe(true);
    });

    it('no deviceId supplied is never treated as a change (permissive — old distributor)', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        expect(isKeyChanged(ME, THEM, PUB_B, undefined)).toBe(false);
    });

    it('acknowledging a change resets verified and updates the pinned pub for that device only', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        recordFirstSeen(ME, THEM, PUB_B, DEV_B);
        acknowledgeKeyChange(ME, THEM, PUB_B, DEV_A);
        expect(getVerificationState(ME, THEM, undefined, DEV_A)).toBe('unverified');
        expect(getStoredPub(ME, THEM, DEV_A)).toBe(PUB_B);
        // DEV_B untouched.
        expect(getVerificationState(ME, THEM, undefined, DEV_B)).toBe('unverified');
    });

    it('verifying one device says nothing about another', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        recordFirstSeen(ME, THEM, PUB_B, DEV_B);
        markVerified(ME, THEM, PUB_A, DEV_A);
        expect(getVerificationState(ME, THEM, undefined, DEV_A)).toBe('verified');
        expect(getVerificationState(ME, THEM, undefined, DEV_B)).toBe('unverified');
    });
});

describe('getVerificationState per-device', () => {
    it('unverified when nothing pinned yet', () => {
        expect(getVerificationState(ME, THEM, PUB_A, DEV_A)).toBe('unverified');
    });

    it('key_changed only against a known device with a differing pub', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        expect(getVerificationState(ME, THEM, PUB_B, DEV_A)).toBe('key_changed');
        // A different, unseen device with the "changed" pub is not a change.
        expect(getVerificationState(ME, THEM, PUB_B, DEV_B)).toBe('unverified');
    });

    it('verified once markVerified is called for that exact device+pub', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        markVerified(ME, THEM, PUB_A, DEV_A);
        expect(getVerificationState(ME, THEM, PUB_A, DEV_A)).toBe('verified');
    });
});

describe('getVerificationState aggregate (no deviceId)', () => {
    it('unverified with no known devices', () => {
        expect(getVerificationState(ME, THEM)).toBe('unverified');
    });

    it('unverified while ANY known device is unverified', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        recordFirstSeen(ME, THEM, PUB_B, DEV_B);
        expect(getVerificationState(ME, THEM)).toBe('unverified');
    });

    it('verified only once EVERY known device is verified', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        markVerified(ME, THEM, PUB_B, DEV_B);
        expect(getVerificationState(ME, THEM)).toBe('verified');
    });

    it('never returns key_changed', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        expect(getVerificationState(ME, THEM, PUB_B)).not.toBe('key_changed');
    });
});

describe('getStoredPub without deviceId (ambiguous-with-multiple-devices)', () => {
    it('returns the pub when exactly one device is known', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        expect(getStoredPub(ME, THEM)).toBe(PUB_A);
    });

    it('returns null once a second device is known — no single answer is correct', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        recordFirstSeen(ME, THEM, PUB_B, DEV_B);
        expect(getStoredPub(ME, THEM)).toBeNull();
    });
});

describe('pub-bucket adoption (pre-Phase-5 sender upgrading to send sd)', () => {
    it('a device-id-less sighting is later adopted by the real device id, carrying verified forward', () => {
        // Old distributor: no device id available yet.
        recordFirstSeen(ME, THEM, PUB_A, undefined);
        markVerified(ME, THEM, PUB_A, undefined);
        expect(Object.keys(getKnownDevices(ME, THEM))).toHaveLength(1);

        // Same device, now sending `sd` (upgraded build).
        expect(isKeyChanged(ME, THEM, PUB_A, DEV_A)).toBe(false); // unknown-by-id, not a change
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);

        // Adopted into the real device id; verified status preserved; the
        // pub-bucket entry is gone (no duplicate/stale record left behind).
        const devices = getKnownDevices(ME, THEM);
        expect(Object.keys(devices)).toEqual([DEV_A]);
        expect(devices[DEV_A].verified).toBe(true);
        expect(getVerificationState(ME, THEM, PUB_A, DEV_A)).toBe('verified');
    });

    it('adoption does not fire for a different pub under a colliding-looking scenario', () => {
        recordFirstSeen(ME, THEM, PUB_A, undefined);
        recordFirstSeen(ME, THEM, PUB_B, DEV_A); // different pub, real device id — no bucket to adopt
        const devices = getKnownDevices(ME, THEM);
        // Both records exist independently — nothing was incorrectly merged.
        expect(Object.keys(devices)).toHaveLength(2);
        expect(devices[DEV_A].pub).toBe(PUB_B);
    });
});

// Hardening follow-up (F1 — critical): closes the sd-omission TOFU bypass.
// A missing/unrecognized deviceId must stay permissive (RC-7 — never a hard
// reject), but must no longer be completely SILENT for a contact the user
// has already Safety-Number-verified a device for.
describe('isUnrecognizedForVerifiedContact — the sd-omission gap fix', () => {
    it('never flags a contact with no verified device yet (nothing to compare against)', () => {
        recordFirstSeen(ME, THEM, PUB_A, DEV_A); // pinned but NOT verified
        expect(isUnrecognizedForVerifiedContact(ME, THEM, PUB_B)).toBe(false);
    });

    it('never flags a pub that matches the verified device, even with no deviceId', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        expect(isUnrecognizedForVerifiedContact(ME, THEM, PUB_A)).toBe(false);
    });

    // The actual exploit this closes: an sd-omitted envelope (attacker-
    // crafted, or a stale pre-Phase-5 client) presenting a DIFFERENT pub for
    // an already-verified contact used to be completely indistinguishable
    // from first contact — isKeyChanged(ME, THEM, PUB_B, undefined) is
    // false (by design, permissive), and nothing else was checked.
    it('flags a DIFFERENT pub for an already-verified contact, even though isKeyChanged stays permissive', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        expect(isKeyChanged(ME, THEM, PUB_B, undefined)).toBe(false); // unchanged — still permissive
        expect(isUnrecognizedForVerifiedContact(ME, THEM, PUB_B)).toBe(true); // NEW — now flagged
    });

    it('flags even when the incoming envelope DOES carry a deviceId, as long as it is a new/unrecognized one', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        expect(isUnrecognizedForVerifiedContact(ME, THEM, PUB_B)).toBe(true);
    });

    it('does not flag a second device whose pub happens to equal an already-verified pub (legit key reuse across devices is not "unrecognized")', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        recordFirstSeen(ME, THEM, PUB_A, DEV_B);
        expect(isUnrecognizedForVerifiedContact(ME, THEM, PUB_A)).toBe(false);
    });

    it('checks against ALL verified devices, not just the first', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        markVerified(ME, THEM, PUB_B, DEV_B);
        expect(isUnrecognizedForVerifiedContact(ME, THEM, PUB_A)).toBe(false);
        expect(isUnrecognizedForVerifiedContact(ME, THEM, PUB_B)).toBe(false);
        expect(isUnrecognizedForVerifiedContact(ME, THEM, 'pubC==')).toBe(true);
    });

    it('an UNVERIFIED pinned device does not count as a baseline to compare against', () => {
        // DEV_A is pinned (recordFirstSeen) but never verified — only a
        // Safety-Number-VERIFIED device should establish a baseline.
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        recordFirstSeen(ME, THEM, PUB_B, DEV_B);
        expect(isUnrecognizedForVerifiedContact(ME, THEM, 'pubC==')).toBe(false);
    });
});

describe('legacy v1 migration', () => {
    it('a pre-Phase-5 legacy record is folded into a pub-bucket on first v2 read, and left in place on disk', () => {
        mem.set(`kv_verify_${ME}_${THEM}`, JSON.stringify({ pub: PUB_A, verified: true }));
        // Reading via the new API sees the migrated record.
        expect(getStoredPub(ME, THEM)).toBe(PUB_A);
        expect(getVerificationState(ME, THEM)).toBe('verified');
        // Legacy key untouched (rollback safety).
        expect(mem.get(`kv_verify_${ME}_${THEM}`)).toBe(JSON.stringify({ pub: PUB_A, verified: true }));
    });

    it('a migrated legacy record adopts into a real device id once sd arrives, preserving verified', () => {
        mem.set(`kv_verify_${ME}_${THEM}`, JSON.stringify({ pub: PUB_A, verified: true }));
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        expect(getVerificationState(ME, THEM, PUB_A, DEV_A)).toBe('verified');
    });
});

describe('the verification modal cannot seed the trust anchor from a server directory', () => {
    // `SafetyVerificationModal` used to call recordFirstSeen() on every row of
    // GET /keys/identity_keys, with a comment claiming the pin was needed for
    // per-device key-change detection. That comment was wrong and the pin was
    // dangerous: directory rows are server-authored and carry no signature, so
    // pinning them let a malicious server establish the trust anchor for a
    // device the user had never heard from — merely by the user OPENING the
    // modal. A later real envelope from that device id would then read `ok`
    // against a key the server chose.
    //
    // These tests pin the three properties that make removing it safe.

    beforeEach(() => { mem.clear(); });

    it('an unseen device reads unverified WITHOUT being pinned', () => {
        // The honest answer for a device you have never received a message
        // from — and crucially, asking must not create the record.
        expect(getVerificationState(ME, THEM, PUB_A, DEV_A)).toBe('unverified');
        expect(getStoredPub(ME, THEM, DEV_A)).toBeNull();
        expect(getKnownDevices(ME, THEM)).toEqual({});
    });

    it('verifying still works, and IT is what creates the anchor', () => {
        // The anchor now comes from an explicit user act instead of a server
        // response — which is the whole point of the change.
        expect(getStoredPub(ME, THEM, DEV_A)).toBeNull();
        markVerified(ME, THEM, PUB_A, DEV_A);
        expect(getStoredPub(ME, THEM, DEV_A)).toBe(PUB_A);
        expect(getVerificationState(ME, THEM, PUB_A, DEV_A)).toBe('verified');
    });

    it('key-change detection is UNAFFECTED for a genuinely known device', () => {
        // The record that makes this work comes from a real envelope, never
        // from the modal — so nothing was lost by removing the pin.
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        expect(getVerificationState(ME, THEM, PUB_B, DEV_A)).toBe('key_changed');
        expect(isKeyChanged(ME, THEM, PUB_B, DEV_A)).toBe(true);
    });

    it('a server-invented device id stays unknown even after being asked about', () => {
        // The attack this closes, end to end: the server serves a device the
        // user has never talked to. Asking about it must leave the store empty,
        // so a later envelope from that id is still first-contact and not `ok`.
        const INVENTED = 'device-server-invented';
        getVerificationState(ME, THEM, PUB_B, INVENTED);
        expect(getKnownDevices(ME, THEM)).toEqual({});
        expect(isKeyChanged(ME, THEM, PUB_B, INVENTED)).toBe(false);
    });
});

describe('SafetyVerificationModal source guard', () => {
    it('does not pin directory rows', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(
            join(__dirname, '..', 'components', 'SafetyVerificationModal.tsx'), 'utf8',
        );
        // Sanity: the file was actually read, so this cannot pass vacuously.
        // (The per-row lookup is `getDeviceVerification` since safety-number v2.)
        expect(src).toContain('getDeviceVerification(');
        expect(src).not.toContain('recordFirstSeen');
    });
});

// ── Safety-number v2 migration (G1) ─────────────────────────────────────────
// A `verified: true` written before v2 cannot say whether it rested on the
// collision-weak v1 digits or on the always-sound contact code, so it reads as
// LEGACY. It must keep every protective role (it is still a trust anchor), and
// only a fresh current-strength check clears the flag.
const { getDeviceVerification } = await import('./keyVerification');

const legacyStore = (extra: Record<string, unknown> = {}) => JSON.stringify({
    v: 2, devices: { [DEV_A]: { pub: PUB_A, verified: true, first_seen: 42, last_seen: 42, ...extra } },
});

describe('G1 migration: verification provenance (`sv`)', () => {
    it('a verification made today is stamped sv:2 and is not legacy', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        expect(getKnownDevices(ME, THEM)[DEV_A].sv).toBe(2);
        expect(getDeviceVerification(ME, THEM, PUB_A, DEV_A)).toEqual({ state: 'verified', legacy: false });
    });

    it('a pre-v2 verified record (no sv) is still VERIFIED, but flagged legacy', () => {
        mem.set(`kv_verify_v2_${ME}_${THEM}`, legacyStore());
        expect(getVerificationState(ME, THEM, PUB_A, DEV_A)).toBe('verified');
        expect(getDeviceVerification(ME, THEM, PUB_A, DEV_A)).toEqual({ state: 'verified', legacy: true });
        expect(getDeviceVerification(ME, THEM)).toEqual({ state: 'verified', legacy: true });
    });

    it('reading a legacy record never rewrites it (no silent upgrade, no silent downgrade)', () => {
        const raw = legacyStore();
        mem.set(`kv_verify_v2_${ME}_${THEM}`, raw);
        getDeviceVerification(ME, THEM, PUB_A, DEV_A);
        getVerificationState(ME, THEM);
        expect(mem.get(`kv_verify_v2_${ME}_${THEM}`)).toBe(raw);
    });

    it('an older sv value is legacy too', () => {
        mem.set(`kv_verify_v2_${ME}_${THEM}`, legacyStore({ sv: 1 }));
        expect(getDeviceVerification(ME, THEM, PUB_A, DEV_A).legacy).toBe(true);
    });

    it('re-verifying a legacy device refreshes it, keeping first_seen', () => {
        mem.set(`kv_verify_v2_${ME}_${THEM}`, legacyStore());
        markVerified(ME, THEM, PUB_A, DEV_A);
        const rec = getKnownDevices(ME, THEM)[DEV_A];
        expect(rec.sv).toBe(2);
        expect(rec.first_seen).toBe(42);
        expect(getDeviceVerification(ME, THEM, PUB_A, DEV_A).legacy).toBe(false);
    });

    it('a v1 (pre-Phase-5) verified record migrates as LEGACY, and stays legacy through sd adoption', () => {
        mem.set(`kv_verify_${ME}_${THEM}`, JSON.stringify({ pub: PUB_A, verified: true }));
        expect(getDeviceVerification(ME, THEM)).toEqual({ state: 'verified', legacy: true });
        recordFirstSeen(ME, THEM, PUB_A, DEV_A);
        expect(getDeviceVerification(ME, THEM, PUB_A, DEV_A)).toEqual({ state: 'verified', legacy: true });
    });

    it('legacy keeps its protective role: an unvouched key for that contact still raises the alarm', () => {
        // Had migration downgraded legacy vouches to unverified, this alarm
        // would have gone silent for every verified contact on upgrade day.
        mem.set(`kv_verify_v2_${ME}_${THEM}`, legacyStore());
        expect(isUnrecognizedForVerifiedContact(ME, THEM, PUB_B)).toBe(true);
        expect(isUnrecognizedForVerifiedContact(ME, THEM, PUB_A)).toBe(false);
        expect(isKeyChanged(ME, THEM, PUB_B, DEV_A)).toBe(true);
    });

    it('acknowledging a key change drops both verified and the provenance', () => {
        markVerified(ME, THEM, PUB_A, DEV_A);
        acknowledgeKeyChange(ME, THEM, PUB_B, DEV_A);
        const rec = getKnownDevices(ME, THEM)[DEV_A];
        expect(rec.verified).toBe(false);
        expect(rec.sv).toBeUndefined();
        expect(getDeviceVerification(ME, THEM, PUB_B, DEV_A)).toEqual({ state: 'unverified', legacy: false });
    });
});
