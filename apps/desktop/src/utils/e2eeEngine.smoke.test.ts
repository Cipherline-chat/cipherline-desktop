import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';

/**
 * Direct round-trip verification of electron/e2ee-engine.ts against real
 * Node crypto — not a mock of the crypto itself, only of the SecureStore
 * dependency (which imports the `electron` module and cannot load outside
 * a real Electron process). This is the one file in the repo with no prior
 * test coverage at all, and Phase 2/3 of the reliability program changed
 * its live crypto control flow (AAD derivation ordering, replay-cache
 * admission timing, multi-SPK retry) — those are exactly the kind of
 * changes that "read correct" but need an actual round trip to be sure of.
 */

// In-memory stand-in for SecureStore's get/set/delete/keys surface.
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

// Must import AFTER the mock is registered.
const { encryptForDevices, decryptEnvelope } = await import('../../electron/e2ee-engine');

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

const SENDER_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RECIPIENT_DEVICE_ID = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';

describe('e2ee-engine round trip (Phase 2/3 crypto changes)', () => {
    beforeEach(() => {
        store.clear();
        const identity = ed25519Pair();
        store.set('identity_priv', identity.privHex);
        store.set('identity_pub', identity.pubB64);
    });

    it('encrypts and decrypts a message end to end', async () => {
        const identitySig = ed25519Pair(); // recipient's own identity, signs their SPK
        const spk = x25519Pair();
        const sig = Buffer.from(ed25519.sign(
            Buffer.from(spk.pubB64, 'base64'),
            Buffer.from(identitySig.privHex, 'hex'),
        )).toString('base64');

        const content = JSON.stringify({ type: 'text', text: 'hello' });
        const result = await encryptForDevices(content, SENDER_USER_ID, [{
            device_id: RECIPIENT_DEVICE_ID,
            spk_pub_b64: spk.pubB64,
            sig_b64: sig,
            identity_pub_b64: identitySig.pubB64,
        }]);

        expect(result.wrapped_device_ids).toEqual([RECIPIENT_DEVICE_ID]);

        const decrypted = decryptEnvelope(result.envelope_b64, RECIPIENT_DEVICE_ID, [
            { id: 1, privHex: spk.privHex, pubB64: spk.pubB64 },
        ]);
        expect(JSON.parse(decrypted.contentJson)).toEqual({ type: 'text', text: 'hello' });
        expect(decrypted.senderUserId).toBe(SENDER_USER_ID);
    });

    // CRIT-7, now verified with Node's native Ed25519 instead of the pure-JS
    // one (perf): a signature made by noble still verifies (interop), and a
    // forged / foreign-identity / garbage signature still skips the device.
    it('encrypts only to devices whose SPK signature verifies against their identity key', async () => {
        const good = ed25519Pair();
        const spkGood = x25519Pair();
        const sigGood = Buffer.from(ed25519.sign(Buffer.from(spkGood.pubB64, 'base64'), Buffer.from(good.privHex, 'hex'))).toString('base64');

        const spkForged = x25519Pair();
        const forgedSig = Buffer.from(sigGood, 'base64'); forgedSig[5] ^= 0x01;   // flipped bit
        const foreign = ed25519Pair();
        const spkForeign = x25519Pair();
        const sigByForeign = Buffer.from(ed25519.sign(Buffer.from(spkForeign.pubB64, 'base64'), Buffer.from(foreign.privHex, 'hex'))).toString('base64');

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await encryptForDevices(JSON.stringify({ type: 'text', text: 'x' }), SENDER_USER_ID, [
            { device_id: 'dev-good', spk_pub_b64: spkGood.pubB64, sig_b64: sigGood, identity_pub_b64: good.pubB64 },
            { device_id: 'dev-forged', spk_pub_b64: spkForged.pubB64, sig_b64: forgedSig.toString('base64'), identity_pub_b64: good.pubB64 },
            // Signed by a DIFFERENT identity than the one the bundle names.
            { device_id: 'dev-foreign', spk_pub_b64: spkForeign.pubB64, sig_b64: sigByForeign, identity_pub_b64: good.pubB64 },
            { device_id: 'dev-garbage', spk_pub_b64: spkGood.pubB64, sig_b64: 'AAAA', identity_pub_b64: 'not-a-key' },
        ]);
        warn.mockRestore();
        expect(result.wrapped_device_ids).toEqual(['dev-good']);
    });

    // Phase 3a (RC-6): the active SPK is wrong (rotated away since the
    // sender fetched this device's bundle) — the OLD SPK the message was
    // actually wrapped for must still be tried and succeed.
    it('falls back to an older SPK when the active one cannot unwrap the envelope', async () => {
        const identitySig = ed25519Pair();
        const oldSpk = x25519Pair();
        const oldSig = Buffer.from(ed25519.sign(
            Buffer.from(oldSpk.pubB64, 'base64'),
            Buffer.from(identitySig.privHex, 'hex'),
        )).toString('base64');

        const content = JSON.stringify({ type: 'text', text: 'wrapped for the old SPK' });
        const result = await encryptForDevices(content, SENDER_USER_ID, [{
            device_id: RECIPIENT_DEVICE_ID,
            spk_pub_b64: oldSpk.pubB64,
            sig_b64: oldSig,
            identity_pub_b64: identitySig.pubB64,
        }]);

        // A newer SPK the recipient has since rotated to — listed FIRST, as
        // main.ts's active-id-first ordering would do.
        const newSpk = x25519Pair();

        const decrypted = decryptEnvelope(result.envelope_b64, RECIPIENT_DEVICE_ID, [
            { id: 2, privHex: newSpk.privHex, pubB64: newSpk.pubB64 }, // active, wrong
            { id: 1, privHex: oldSpk.privHex, pubB64: oldSpk.pubB64 }, // retained, correct
        ]);
        expect(JSON.parse(decrypted.contentJson)).toEqual({ type: 'text', text: 'wrapped for the old SPK' });
    });

    it('throws WRAP_AUTH_FAILED when no candidate SPK can unwrap it', async () => {
        const identitySig = ed25519Pair();
        const realSpk = x25519Pair();
        const sig = Buffer.from(ed25519.sign(
            Buffer.from(realSpk.pubB64, 'base64'),
            Buffer.from(identitySig.privHex, 'hex'),
        )).toString('base64');

        const result = await encryptForDevices(JSON.stringify({ type: 'text', text: 'x' }), SENDER_USER_ID, [{
            device_id: RECIPIENT_DEVICE_ID, spk_pub_b64: realSpk.pubB64, sig_b64: sig, identity_pub_b64: identitySig.pubB64,
        }]);

        const wrongSpk = x25519Pair();
        expect(() => decryptEnvelope(result.envelope_b64, RECIPIENT_DEVICE_ID, [
            { id: 1, privHex: wrongSpk.privHex, pubB64: wrongSpk.pubB64 },
        ])).toThrow(/\[E2EE:WRAP_AUTH_FAILED\]/);
    });

    // Phase 3b (RC-9): replay admission must happen only after the FULL
    // decrypt succeeds — a second decrypt of the SAME envelope must be
    // rejected as a replay once the first one actually succeeded.
    it('rejects a second decrypt of the same envelope as a replay', async () => {
        const identitySig = ed25519Pair();
        const spk = x25519Pair();
        const sig = Buffer.from(ed25519.sign(
            Buffer.from(spk.pubB64, 'base64'),
            Buffer.from(identitySig.privHex, 'hex'),
        )).toString('base64');

        const result = await encryptForDevices(JSON.stringify({ type: 'text', text: 'once' }), SENDER_USER_ID, [{
            device_id: RECIPIENT_DEVICE_ID, spk_pub_b64: spk.pubB64, sig_b64: sig, identity_pub_b64: identitySig.pubB64,
        }]);
        const candidates = [{ id: 1, privHex: spk.privHex, pubB64: spk.pubB64 }];

        decryptEnvelope(result.envelope_b64, RECIPIENT_DEVICE_ID, candidates); // succeeds, admits to replay cache
        expect(() => decryptEnvelope(result.envelope_b64, RECIPIENT_DEVICE_ID, candidates))
            .toThrow(/\[E2EE:REPLAY\]/);
    });

    // Phase 3b's actual point: a message that fails for a REAL reason
    // (tampered ciphertext) before ever reaching the replay-admission line
    // must report that real reason, not REPLAY, on a subsequent retry.
    it('reports the real failure (not REPLAY) on retry after content tampering', async () => {
        const identitySig = ed25519Pair();
        const spk = x25519Pair();
        const sig = Buffer.from(ed25519.sign(
            Buffer.from(spk.pubB64, 'base64'),
            Buffer.from(identitySig.privHex, 'hex'),
        )).toString('base64');

        const result = await encryptForDevices(JSON.stringify({ type: 'text', text: 'tampered' }), SENDER_USER_ID, [{
            device_id: RECIPIENT_DEVICE_ID, spk_pub_b64: spk.pubB64, sig_b64: sig, identity_pub_b64: identitySig.pubB64,
        }]);

        const envelope = JSON.parse(Buffer.from(result.envelope_b64, 'base64').toString('utf8'));
        envelope.ct = Buffer.from('tampered-ciphertext-not-base64-of-real-data').toString('base64');
        const tamperedB64 = Buffer.from(JSON.stringify(envelope)).toString('base64');
        const candidates = [{ id: 1, privHex: spk.privHex, pubB64: spk.pubB64 }];

        expect(() => decryptEnvelope(tamperedB64, RECIPIENT_DEVICE_ID, candidates))
            .toThrow(/\[E2EE:CONTENT_AUTH_FAILED\]/);
        // Retrying the SAME (still-tampered) envelope again must report the
        // SAME real error, not REPLAY — proves admission never happened on
        // the failed attempt.
        expect(() => decryptEnvelope(tamperedB64, RECIPIENT_DEVICE_ID, candidates))
            .toThrow(/\[E2EE:CONTENT_AUTH_FAILED\]/);
    });

    it('throws NO_SPK when no candidates are supplied', () => {
        // A validly-v3-shaped (but unwrappable) envelope — the empty-candidates
        // check happens after the version check, so the shell must parse.
        const shell = Buffer.from(JSON.stringify({ v: 3, eph: '', recipients: {}, iv: '', ct: '', sig: '' })).toString('base64');
        expect(() => decryptEnvelope(shell, RECIPIENT_DEVICE_ID, []))
            .toThrow(/\[E2EE:NO_SPK\]/);
    });

    // RC-7 / Phase 5: `sd` (sender device id) round-trips inside the sealed
    // wrapper — this is what lets the receiver pin TOFU per (contact,
    // device) instead of per contact.
    it('round-trips senderDeviceId when the caller supplies one', async () => {
        const identitySig = ed25519Pair();
        const spk = x25519Pair();
        const sig = Buffer.from(ed25519.sign(
            Buffer.from(spk.pubB64, 'base64'),
            Buffer.from(identitySig.privHex, 'hex'),
        )).toString('base64');
        const SENDER_DEVICE_ID = 'ssssssss-ssss-ssss-ssss-ssssssssssss';

        const result = await encryptForDevices(
            JSON.stringify({ type: 'text', text: 'hi' }),
            SENDER_USER_ID,
            [{ device_id: RECIPIENT_DEVICE_ID, spk_pub_b64: spk.pubB64, sig_b64: sig, identity_pub_b64: identitySig.pubB64 }],
            SENDER_DEVICE_ID,
        );

        const decrypted = decryptEnvelope(result.envelope_b64, RECIPIENT_DEVICE_ID, [
            { id: 1, privHex: spk.privHex, pubB64: spk.pubB64 },
        ]);
        expect(decrypted.senderDeviceId).toBe(SENDER_DEVICE_ID);
    });

    it('omits senderDeviceId (undefined, not empty string) when the caller supplies none — old-caller compatibility', async () => {
        const identitySig = ed25519Pair();
        const spk = x25519Pair();
        const sig = Buffer.from(ed25519.sign(
            Buffer.from(spk.pubB64, 'base64'),
            Buffer.from(identitySig.privHex, 'hex'),
        )).toString('base64');

        const result = await encryptForDevices(
            JSON.stringify({ type: 'text', text: 'hi' }),
            SENDER_USER_ID,
            [{ device_id: RECIPIENT_DEVICE_ID, spk_pub_b64: spk.pubB64, sig_b64: sig, identity_pub_b64: identitySig.pubB64 }],
            // no senderDeviceId argument at all
        );

        const decrypted = decryptEnvelope(result.envelope_b64, RECIPIENT_DEVICE_ID, [
            { id: 1, privHex: spk.privHex, pubB64: spk.pubB64 },
        ]);
        expect(decrypted.senderDeviceId).toBeUndefined();
    });
});
