/**
 * F1 (critical) — sender-identity forgery: reproduction and block.
 *
 * This file is the proof for the sender-binding fix. It is deliberately
 * structured in three acts:
 *
 *   Act 1 — REPRODUCE. Mount the actual attack against the actual crypto
 *           engine and show it succeeds. Nothing is mocked except the
 *           SecureStore (which needs a real Electron process). The forged
 *           envelope is built with nothing but PUBLIC information about the
 *           victim, and `decryptEnvelope` hands it back attributed to the
 *           impersonated user with every check green.
 *
 *   Act 2 — SHOW THE OLD TRUST LAYER MISSED IT. Run the exact predicates
 *           Dashboard.tsx used to gate on (`isKeyChanged` for the banner,
 *           `getStoredPub` for the call_key/channel_key pin gate) against the
 *           forgery and show both say "fine" — including for a contact whose
 *           safety number the user had verified.
 *
 *   Act 3 — SHOW THE NEW LAYER BLOCKS IT. `evaluateSender` + `actionFor`.
 *
 * Act 1 is expected to keep passing forever. That is not a gap: the engine
 * CANNOT distinguish this envelope from a real one, because the signature is
 * verified against a key the envelope itself names. Attribution is a
 * trust-layer property, and the fix lives there.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';

// ── SecureStore stand-in (same pattern as e2eeEngine.smoke.test.ts) ──────────
// This is the ATTACKER's process store in Act 1: the attacker runs the normal
// client code with their own identity key and simply lies in `su`.
const store = new Map<string, string>();
vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => { store.set(k, v); },
        setDeferred: (k: string, v: string) => { store.set(k, v); },
        delete: (k: string) => { store.delete(k); },
        deleteDeferred: (k: string) => { store.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.keys()],
    },
}));

// ── secureLocalStore stand-in for the TOFU pin store ─────────────────────────
const mem = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
    },
}));

const { encryptForDevices, decryptEnvelope } = await import('../../electron/e2ee-engine');
const { markVerified, recordFirstSeen, isKeyChanged, getStoredPub } = await import('./keyVerification');
const { evaluateSender, actionFor, isWarnable } = await import('./senderTrust');
const deviceDirectory = await import('./deviceDirectory');

function x25519Pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
    const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
    return {
        privHex: Buffer.from(privJwk.d, 'base64url').toString('hex'),
        pubB64: Buffer.from(pubJwk.x, 'base64url').toString('base64'),
    };
}

function ed25519Pair() {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    return { privHex: Buffer.from(priv).toString('hex'), pubB64: Buffer.from(pub).toString('base64') };
}

// Cast of characters.
const ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // the victim / recipient
const BOB   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // the impersonated contact
const ALICE_DEVICE  = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
const BOB_DEVICE    = 'dddddddd-dddd-dddd-dddd-ddddddddddd2';
/** The device id the attacker invents. Any unseen value works — that is the
 *  whole point, and omitting `sd` entirely works just as well (covered below). */
const FORGED_DEVICE = 'ffffffff-ffff-ffff-ffff-fffffffffff1';

/** Alice's long-term identity + published signed prekey. Everything the
 *  attacker uses from here is PUBLIC: `spk_pub_b64`, its signature, and her
 *  identity pub. All three are served by `GET /v1/keys/prekey_bundle` to any
 *  authenticated caller, and the server holds them outright. */
function makeAlice() {
    const identity = ed25519Pair();
    const spk = x25519Pair();
    const spkSig = Buffer.from(ed25519.sign(
        Buffer.from(spk.pubB64, 'base64'),
        Buffer.from(identity.privHex, 'hex'),
    )).toString('base64');
    return {
        identity,
        spk,
        devicePub: {
            device_id: ALICE_DEVICE,
            spk_pub_b64: spk.pubB64,
            sig_b64: spkSig,
            identity_pub_b64: identity.pubB64,
        },
        spkCandidates: [{ id: 1, privHex: spk.privHex, pubB64: spk.pubB64 }],
    };
}

beforeEach(() => {
    store.clear();
    mem.clear();
    deviceDirectory._reset();
});

// ═══════════════════════════════════════════════════════════════════════════
// Act 1 — the forgery itself
// ═══════════════════════════════════════════════════════════════════════════

describe('F1 Act 1 — a forged envelope passes every check in the crypto engine', () => {
    it('attributes an attacker-signed envelope to any user the attacker names', async () => {
        const alice = makeAlice();

        // The attacker's identity key. Freshly generated; never published by
        // Bob; never seen by Alice. It is what the envelope will be signed with.
        const attacker = ed25519Pair();
        store.set('identity_priv', attacker.privHex);
        store.set('identity_pub', attacker.pubB64);

        // The attacker encrypts to Alice's PUBLISHED signed prekey and claims
        // to be Bob. No secret of Bob's is used or needed anywhere.
        const forged = await encryptForDevices(
            JSON.stringify({ type: 'text', text: 'transfer the money to this account' }),
            BOB,                       // ← the lie. Nothing checks it.
            [alice.devicePub],
            FORGED_DEVICE,             // ← an invented device id
        );

        const decrypted = decryptEnvelope(forged.envelope_b64, ALICE_DEVICE, alice.spkCandidates);

        // Every property the engine can check is satisfied:
        expect(JSON.parse(decrypted.contentJson)).toEqual({
            type: 'text', text: 'transfer the money to this account',
        });
        // ...and it is attributed to Bob, who had nothing to do with it.
        expect(decrypted.senderUserId).toBe(BOB);
        // The signing key is the attacker's, not Bob's. Nothing correlates them.
        expect(decrypted.senderPub).toBe(attacker.pubB64);
        expect(decrypted.senderPub).not.toBe(alice.identity.pubB64);
    });

    it('works identically with `sd` omitted — the per-device checks never engage', async () => {
        const alice = makeAlice();
        const attacker = ed25519Pair();
        store.set('identity_priv', attacker.privHex);
        store.set('identity_pub', attacker.pubB64);

        const forged = await encryptForDevices(
            JSON.stringify({ type: 'text', text: 'no device id at all' }),
            BOB,
            [alice.devicePub],
            // no senderDeviceId
        );

        const decrypted = decryptEnvelope(forged.envelope_b64, ALICE_DEVICE, alice.spkCandidates);
        expect(decrypted.senderUserId).toBe(BOB);
        expect(decrypted.senderDeviceId).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Act 2 — the trust layer as it stood: silent
// ═══════════════════════════════════════════════════════════════════════════

describe('F1 Act 2 — the pre-fix trust predicates do not notice', () => {
    /** Alice has met Bob's real device and VERIFIED its safety number
     *  out of band. This is the strongest trust state the product offers. */
    function aliceHasVerifiedBob(bobPub: string) {
        recordFirstSeen(ALICE, BOB, bobPub, BOB_DEVICE);
        markVerified(ALICE, BOB, bobPub, BOB_DEVICE);
    }

    it('isKeyChanged (the banner gate) stays false for the forged key', () => {
        const bob = ed25519Pair();
        const attacker = ed25519Pair();
        aliceHasVerifiedBob(bob.pubB64);

        // Dashboard.tsx's pinAndDetect asked exactly this. An unseen device id
        // is "new device", never "changed" — so no banner, for a VERIFIED
        // contact, on a key Bob never published.
        expect(isKeyChanged(ALICE, BOB, attacker.pubB64, FORGED_DEVICE)).toBe(false);
    });

    it('the call_key / channel_key pin gate admits the forged key', () => {
        const bob = ed25519Pair();
        const attacker = ed25519Pair();
        aliceHasVerifiedBob(bob.pubB64);

        // The literal gate: `const pinned = getStoredPub(...); if (!pinned || pinned === sp)`.
        const pinned = getStoredPub(ALICE, BOB, FORGED_DEVICE);
        expect(pinned).toBeNull();
        const admittedByOldGate = !pinned || pinned === attacker.pubB64;
        expect(admittedByOldGate).toBe(true); // ← full call-media MITM
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Act 3 — the fix
// ═══════════════════════════════════════════════════════════════════════════

describe('F1 Act 3 — evaluateSender blocks the forgery', () => {
    function aliceHasVerifiedBob(bobPub: string) {
        recordFirstSeen(ALICE, BOB, bobPub, BOB_DEVICE);
        markVerified(ALICE, BOB, bobPub, BOB_DEVICE);
    }

    it('flags a forged key for a verified contact as unrecognized_verified', () => {
        const bob = ed25519Pair();
        const attacker = ed25519Pair();
        aliceHasVerifiedBob(bob.pubB64);

        const verdict = evaluateSender({
            myUserId: ALICE, theirUserId: BOB,
            senderPub: attacker.pubB64, senderDeviceId: FORGED_DEVICE,
            directory: 'unknown',   // worst case: no directory evidence at all
        });
        expect(verdict).toBe('unrecognized_verified');
        expect(isWarnable(verdict)).toBe(true);
    });

    it('catches the same forgery when `sd` is omitted (the bypass F1 names)', () => {
        const bob = ed25519Pair();
        const attacker = ed25519Pair();
        aliceHasVerifiedBob(bob.pubB64);

        const verdict = evaluateSender({
            myUserId: ALICE, theirUserId: BOB,
            senderPub: attacker.pubB64, senderDeviceId: undefined,
            directory: 'unknown',
        });
        expect(verdict).toBe('unrecognized_verified');
    });

    it('REJECTS forged call_key / channel_key and only WARNS on forged text', () => {
        const bob = ed25519Pair();
        const attacker = ed25519Pair();
        aliceHasVerifiedBob(bob.pubB64);

        const verdict = evaluateSender({
            myUserId: ALICE, theirUserId: BOB,
            senderPub: attacker.pubB64, senderDeviceId: FORGED_DEVICE,
            directory: 'unknown',
        });

        expect(actionFor(verdict, 'key_material')).toBe('reject');
        expect(actionFor(verdict, 'content')).toBe('accept_warn');
    });

    it('still accepts Bob real key from his real verified device', () => {
        const bob = ed25519Pair();
        aliceHasVerifiedBob(bob.pubB64);

        const verdict = evaluateSender({
            myUserId: ALICE, theirUserId: BOB,
            senderPub: bob.pubB64, senderDeviceId: BOB_DEVICE,
            directory: 'match',
        });
        expect(verdict).toBe('ok');
        expect(actionFor(verdict, 'key_material')).toBe('accept');
        expect(actionFor(verdict, 'content')).toBe('accept');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Directory attribution — the layer that also covers UNVERIFIED contacts
// ═══════════════════════════════════════════════════════════════════════════

describe('F1 — directory attribution covers contacts the user never verified', () => {
    it('rejects key material whose key the account does not publish', () => {
        const bob = ed25519Pair();
        const attacker = ed25519Pair();

        // Alice has never verified Bob — the pin store is empty for him, so
        // `unrecognized_verified` cannot fire. This is the majority case.
        deviceDirectory.recordFullUser(BOB, [
            { device_id: BOB_DEVICE, identity_key_pub_b64: bob.pubB64 },
        ]);

        const status = deviceDirectory.status(BOB, attacker.pubB64, FORGED_DEVICE);
        expect(status).toBe('mismatch');

        const verdict = evaluateSender({
            myUserId: ALICE, theirUserId: BOB,
            senderPub: attacker.pubB64, senderDeviceId: FORGED_DEVICE,
            directory: status,
        });
        expect(verdict).toBe('unattributed');
        expect(actionFor(verdict, 'key_material')).toBe('reject');
        expect(actionFor(verdict, 'content')).toBe('accept_warn');
    });

    it('catches an omitted `sd` too — the pub must be published for SOME device', () => {
        const bob = ed25519Pair();
        const attacker = ed25519Pair();
        deviceDirectory.recordFullUser(BOB, [
            { device_id: BOB_DEVICE, identity_key_pub_b64: bob.pubB64 },
        ]);
        expect(deviceDirectory.status(BOB, attacker.pubB64, undefined)).toBe('mismatch');
        expect(deviceDirectory.status(BOB, bob.pubB64, undefined)).toBe('match');
    });

    it('stays permissive (unknown, not mismatch) when no snapshot was ever fetched', () => {
        const attacker = ed25519Pair();
        expect(deviceDirectory.status(BOB, attacker.pubB64, FORGED_DEVICE)).toBe('unknown');

        // ...and a genuine first contact is therefore still accepted.
        const verdict = evaluateSender({
            myUserId: ALICE, theirUserId: BOB,
            senderPub: attacker.pubB64, senderDeviceId: FORGED_DEVICE,
            directory: 'unknown',
        });
        expect(verdict).toBe('first_contact');
        expect(actionFor(verdict, 'key_material')).toBe('accept');
    });

    it('a partial (conversation-scoped) record never manufactures a mismatch', () => {
        const bobLaptop = ed25519Pair();
        const bobPhone = ed25519Pair();

        // Learned from conversation A: only the laptop.
        deviceDirectory.record([
            { user_id: BOB, device_id: BOB_DEVICE, identity_pub_b64: bobLaptop.pubB64 },
        ]);
        expect(deviceDirectory.status(BOB, bobPhone.pubB64)).toBe('mismatch');

        // Learned from conversation B: the phone as well. The merge must not
        // drop the laptop, and the phone must now attribute cleanly.
        deviceDirectory.record([
            { user_id: BOB, device_id: 'dddddddd-dddd-dddd-dddd-ddddddddddd3', identity_pub_b64: bobPhone.pubB64 },
        ]);
        expect(deviceDirectory.status(BOB, bobPhone.pubB64)).toBe('match');
        expect(deviceDirectory.status(BOB, bobLaptop.pubB64)).toBe('match');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// End-to-end: forged envelope → engine → trust layer → rejected call_key
// ═══════════════════════════════════════════════════════════════════════════

describe('F1 — end to end: the call_key injection path', () => {
    it('a real forged envelope carrying call_key is refused by the new gate', async () => {
        const alice = makeAlice();
        const bob = ed25519Pair();

        // Alice verified Bob's real device out of band.
        recordFirstSeen(ALICE, BOB, bob.pubB64, BOB_DEVICE);
        markVerified(ALICE, BOB, bob.pubB64, BOB_DEVICE);
        deviceDirectory.recordFullUser(BOB, [
            { device_id: BOB_DEVICE, identity_key_pub_b64: bob.pubB64 },
        ]);

        // The attacker forges a call_key envelope as Bob.
        const attacker = ed25519Pair();
        store.set('identity_priv', attacker.privHex);
        store.set('identity_pub', attacker.pubB64);
        const forged = await encryptForDevices(
            JSON.stringify({
                type: 'call_key',
                call_id: 'call-1234',
                e2ee_key_b64: Buffer.from('attacker-controlled-media-key!!!').toString('base64'),
                rotates_at: new Date(Date.now() + 3600_000).toISOString(),
            }),
            BOB,
            [alice.devicePub],
            FORGED_DEVICE,
        );

        // It decrypts and verifies — the engine is happy, as Act 1 established.
        const d = decryptEnvelope(forged.envelope_b64, ALICE_DEVICE, alice.spkCandidates);
        const content = JSON.parse(d.contentJson);
        expect(content.type).toBe('call_key');
        expect(d.senderUserId).toBe(BOB);

        // The trust gate is what stops it.
        const verdict = evaluateSender({
            myUserId: ALICE,
            theirUserId: d.senderUserId!,
            senderPub: d.senderPub!,
            senderDeviceId: d.senderDeviceId,
            directory: deviceDirectory.status(d.senderUserId!, d.senderPub!, d.senderDeviceId),
        });
        expect(verdict).toBe('unattributed');
        expect(actionFor(verdict, 'key_material')).toBe('reject');

        // Simulating the Dashboard call site: the key must NOT be adopted.
        const callKeyStore: Record<string, string> = {};
        if (actionFor(verdict, 'key_material') === 'accept') {
            callKeyStore[content.call_id] = content.e2ee_key_b64;
        }
        expect(callKeyStore['call-1234']).toBeUndefined();
    });

    it('Bob real device, same path, still gets its call key adopted', async () => {
        const alice = makeAlice();

        // Bob's real identity is in the attacker-free store; he is the sender.
        const bob = ed25519Pair();
        store.set('identity_priv', bob.privHex);
        store.set('identity_pub', bob.pubB64);

        recordFirstSeen(ALICE, BOB, bob.pubB64, BOB_DEVICE);
        markVerified(ALICE, BOB, bob.pubB64, BOB_DEVICE);
        deviceDirectory.recordFullUser(BOB, [
            { device_id: BOB_DEVICE, identity_key_pub_b64: bob.pubB64 },
        ]);

        const real = await encryptForDevices(
            JSON.stringify({
                type: 'call_key', call_id: 'call-5678',
                e2ee_key_b64: Buffer.from('a-legitimate-call-media-key-32b!').toString('base64'),
                rotates_at: new Date(Date.now() + 3600_000).toISOString(),
            }),
            BOB, [alice.devicePub], BOB_DEVICE,
        );

        const d = decryptEnvelope(real.envelope_b64, ALICE_DEVICE, alice.spkCandidates);
        const content = JSON.parse(d.contentJson);
        const verdict = evaluateSender({
            myUserId: ALICE,
            theirUserId: d.senderUserId!,
            senderPub: d.senderPub!,
            senderDeviceId: d.senderDeviceId,
            directory: deviceDirectory.status(d.senderUserId!, d.senderPub!, d.senderDeviceId),
        });
        expect(verdict).toBe('ok');

        const callKeyStore: Record<string, string> = {};
        if (actionFor(verdict, 'key_material') === 'accept') {
            callKeyStore[content.call_id] = content.e2ee_key_b64;
        }
        expect(callKeyStore['call-5678']).toBe(content.e2ee_key_b64);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// The `su`-omission path — a message evaluated by nothing at all
// ═══════════════════════════════════════════════════════════════════════════

describe('F1 — an envelope with no claimed sender user id is refused', () => {
    it('rejects it in the engine rather than showing it unevaluated', async () => {
        const alice = makeAlice();
        const attacker = ed25519Pair();
        store.set('identity_priv', attacker.privHex);
        store.set('identity_pub', attacker.pubB64);

        // `su` empty. Every predicate in the trust layer keys on the claimed
        // user id and early-returns without it, so before this check the
        // message reached the UI having been judged by nothing at all.
        const noSu = await encryptForDevices(
            JSON.stringify({ type: 'text', text: 'from nobody' }),
            '',
            [alice.devicePub],
            FORGED_DEVICE,
        );

        expect(() => decryptEnvelope(noSu.envelope_b64, ALICE_DEVICE, alice.spkCandidates))
            .toThrow(/missing sender user id/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Directory cache population
// ═══════════════════════════════════════════════════════════════════════════

describe('F1 — directory capture', () => {
    it('recognises the directory-bearing response URLs and ignores others', () => {
        expect(deviceDirectory.isDirectoryUrl('http://h/v1/conversations/abc/devices')).toBe(true);
        expect(deviceDirectory.isDirectoryUrl('http://h/v1/servers/s/channels/c/recipient-devices')).toBe(true);
        expect(deviceDirectory.isDirectoryUrl('http://h/v1/keys/identity_keys?user_id=x')).toBe(true);
        expect(deviceDirectory.isDirectoryUrl('http://h/v1/messages')).toBe(false);
        expect(deviceDirectory.isDirectoryUrl(undefined)).toBe(false);
    });

    it('warms the cache from a conversation-devices response with no extra request', () => {
        const bob = ed25519Pair();
        const handlers: ((res: unknown) => unknown)[] = [];
        const fakeAxios = {
            interceptors: {
                response: {
                    use: (fn: (res: unknown) => unknown) => { handlers.push(fn); return handlers.length - 1; },
                    eject: () => { /* no-op */ },
                },
            },
        };

        const eject = deviceDirectory.installDirectoryCapture(fakeAxios);
        expect(deviceDirectory.status(BOB, bob.pubB64)).toBe('unknown');

        handlers[0]({
            config: { url: 'http://h/v1/conversations/abc/devices' },
            data: [{ user_id: BOB, device_id: BOB_DEVICE, identity_pub_b64: bob.pubB64 }],
        });

        expect(deviceDirectory.status(BOB, bob.pubB64, BOB_DEVICE)).toBe('match');
        const attacker = ed25519Pair();
        expect(deviceDirectory.status(BOB, attacker.pubB64, FORGED_DEVICE)).toBe('mismatch');
        eject();
    });

    it('treats an identity_keys response as the authoritative full set (replace, not merge)', () => {
        const stale = ed25519Pair();
        const current = ed25519Pair();
        const handlers: ((res: unknown) => unknown)[] = [];
        deviceDirectory.installDirectoryCapture({
            interceptors: {
                response: {
                    use: (fn: (res: unknown) => unknown) => { handlers.push(fn); return 0; },
                    eject: () => { /* no-op */ },
                },
            },
        });

        deviceDirectory.record([{ user_id: BOB, device_id: 'old-device', identity_pub_b64: stale.pubB64 }]);
        expect(deviceDirectory.status(BOB, stale.pubB64)).toBe('match');

        // A revoked device must stop attributing once the full set is refetched,
        // or a retired (or forged, then removed) key stays valid in the cache
        // for as long as the app is open.
        handlers[0]({
            config: { url: `http://h/v1/keys/identity_keys?user_id=${BOB}` },
            data: [{ device_id: BOB_DEVICE, identity_key_pub_b64: current.pubB64 }],
        });

        expect(deviceDirectory.status(BOB, current.pubB64)).toBe('match');
        expect(deviceDirectory.status(BOB, stale.pubB64)).toBe('mismatch');
    });
});
