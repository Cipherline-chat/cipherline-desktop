import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';

/**
 * C5 — forward secrecy, verified against REAL Node crypto.
 *
 * Two properties are proven here, both end to end rather than by inspection:
 *
 *   1. A one-time prekey is actually mixed into the key schedule and is
 *      CONSUMED — its private half is gone after the message is read, so the
 *      same prekey cannot open a second message. Before this change the
 *      desktop client never requested a prekey at all (prod: 15,277 uploaded,
 *      0 ever claimed), so every envelope used signed-prekey-only ECDH.
 *
 *   2. A superseded signed prekey is retained exactly long enough for messages
 *      in flight and then deleted. Both halves matter: deleting too eagerly
 *      loses real messages, and never deleting — the behaviour before this
 *      change — meant one dump of a device's SecureStore decrypted every
 *      message ever delivered to it, because every signed-prekey private ever
 *      generated was still there and the decrypt path tries them all.
 *
 * Only SecureStore is mocked (it imports `electron` and cannot load outside a
 * real Electron process). The crypto, the key schedule and the retention
 * arithmetic are all the real implementations.
 */

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
        initialize: async () => {},
    },
}));

const { encryptForDevices, decryptEnvelope } = await import('../../electron/e2ee-engine');
const { pruneSupersededSignedPrekeys, SPK_RETENTION_MS, SERVER_ENVELOPE_RETENTION_MS } =
    await import('../../electron/signal-identity');

const DAY = 24 * 60 * 60 * 1000;

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
const DEVICE_ID = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';

/** Recipient identity + a signed prekey stored under `spkId`. */
function installSpk(spkId: number) {
    const recipIdentity = ed25519Pair();
    const spk = x25519Pair();
    const sig = Buffer.from(
        ed25519.sign(Buffer.from(spk.pubB64, 'base64'), Buffer.from(recipIdentity.privHex, 'hex')),
    ).toString('base64');

    store.set(`signed_prekey_priv_${spkId}`, spk.privHex);
    store.set(`signed_prekey_pub_${spkId}`, spk.pubB64);
    store.set(`signed_prekey_sig_${spkId}`, sig);
    store.set('signed_prekey_active_id', String(spkId));

    return { device_id: DEVICE_ID, spk_pub_b64: spk.pubB64, sig_b64: sig, identity_pub_b64: recipIdentity.pubB64 };
}

/**
 * Mirrors how electron/main.ts builds the candidate list for decryptEnvelope:
 * every signed-prekey private still in the store, active one first. Pruning is
 * only meaningful through this path, because this is what actually gets tried.
 */
function spkCandidatesFromStore() {
    const activeId = parseInt(store.get('signed_prekey_active_id') ?? '', 10);
    return [...store.keys()]
        .map(k => /^signed_prekey_priv_(\d+)$/.exec(k)?.[1])
        .filter((v): v is string => v != null)
        .map(Number)
        .sort((a, b) => (a === activeId ? -1 : b === activeId ? 1 : b - a))
        .map(id => ({
            id,
            privHex: store.get(`signed_prekey_priv_${id}`)!,
            pubB64: store.get(`signed_prekey_pub_${id}`)!,
        }));
}

beforeEach(() => {
    store.clear();
    const senderIdentity = ed25519Pair();
    store.set('identity_priv', senderIdentity.privHex);
    store.set('identity_pub', senderIdentity.pubB64);
});

describe('C5 — one-time prekeys are consumed', () => {
    it('mixes the one-time prekey in and deletes its private half once the message is read', async () => {
        const device = installSpk(1);
        const otp = x25519Pair();
        store.set('otp_priv_7', otp.privHex);
        store.set('otp_pub_7', otp.pubB64);

        const { envelope_b64 } = await encryptForDevices(
            JSON.stringify({ type: 'text', body: 'hello' }),
            SENDER_USER_ID,
            [{ ...device, otp_id: 7, otp_pub_b64: otp.pubB64 }],
            DEVICE_ID,
        );

        // The envelope must actually record which prekey was used — that is
        // what binds the wrap key to it (the id is HKDF info).
        const envelope = JSON.parse(Buffer.from(envelope_b64, 'base64').toString('utf8'));
        expect(envelope.recipients[DEVICE_ID].otp_id).toBe(7);

        const result = decryptEnvelope(envelope_b64, DEVICE_ID, spkCandidatesFromStore());
        expect(JSON.parse(result.contentJson)).toEqual({ type: 'text', body: 'hello' });
        // G3: the recipient learns, locally, that a one-time prekey was used.
        expect(result.usedOneTimePrekey).toBe(true);

        // Consumed: this is what makes it a ONE-time prekey.
        expect(store.get('otp_priv_7')).toBeUndefined();
        expect(store.get('otp_pub_7')).toBeUndefined();
    });

    it('cannot decrypt a second message wrapped to an already-consumed prekey', async () => {
        const device = installSpk(1);
        const otp = x25519Pair();
        store.set('otp_priv_7', otp.privHex);
        store.set('otp_pub_7', otp.pubB64);

        // Two DISTINCT envelopes against the same prekey. A correct server
        // never reissues one, but proving the client cannot be made to reuse
        // it is what makes the guarantee independent of the server.
        const first = await encryptForDevices(
            JSON.stringify({ type: 'text', body: 'one' }), SENDER_USER_ID,
            [{ ...device, otp_id: 7, otp_pub_b64: otp.pubB64 }], DEVICE_ID);
        const second = await encryptForDevices(
            JSON.stringify({ type: 'text', body: 'two' }), SENDER_USER_ID,
            [{ ...device, otp_id: 7, otp_pub_b64: otp.pubB64 }], DEVICE_ID);

        expect(JSON.parse(decryptEnvelope(first.envelope_b64, DEVICE_ID, spkCandidatesFromStore()).contentJson))
            .toEqual({ type: 'text', body: 'one' });

        // The prekey private is gone, so the second message's key schedule can
        // no longer be reproduced.
        expect(() => decryptEnvelope(second.envelope_b64, DEVICE_ID, spkCandidatesFromStore()))
            .toThrow(/WRAP_AUTH_FAILED/);
    });

    it('still delivers when no prekey is available (exhaustion degrades, never fails)', async () => {
        const device = installSpk(1);

        const { envelope_b64 } = await encryptForDevices(
            JSON.stringify({ type: 'text', body: 'spk only' }),
            SENDER_USER_ID, [device], DEVICE_ID,
        );

        const envelope = JSON.parse(Buffer.from(envelope_b64, 'base64').toString('utf8'));
        expect(envelope.recipients[DEVICE_ID].otp_id).toBeUndefined();
        const result = decryptEnvelope(envelope_b64, DEVICE_ID, spkCandidatesFromStore());
        expect(JSON.parse(result.contentJson)).toEqual({ type: 'text', body: 'spk only' });
        // G3: ...and that this one rested on the signed prekey alone — the
        // signal that drives an immediate prekey top-up check.
        expect(result.usedOneTimePrekey).toBe(false);
    });
});

describe('C5 — superseded signed prekeys are deleted', () => {
    it('keeps a superseded key inside the retention window, and an in-flight message still decrypts', async () => {
        // A message was wrapped to SPK 1 just before the device rotated to SPK 2.
        const oldDevice = installSpk(1);
        const { envelope_b64 } = await encryptForDevices(
            JSON.stringify({ type: 'text', body: 'in flight' }),
            SENDER_USER_ID, [oldDevice], DEVICE_ID,
        );

        installSpk(2); // rotate; SPK 1 stays in the store
        const supersededAt = Date.now();
        store.set('signed_prekey_superseded_1', new Date(supersededAt).toISOString());

        // One day short of the window — the message is still deliverable, so
        // the key MUST still be here.
        const deleted = pruneSupersededSignedPrekeys(supersededAt + SPK_RETENTION_MS - DAY);
        expect(deleted).toEqual([]);
        expect(store.get('signed_prekey_priv_1')).toBeDefined();

        expect(JSON.parse(decryptEnvelope(envelope_b64, DEVICE_ID, spkCandidatesFromStore()).contentJson))
            .toEqual({ type: 'text', body: 'in flight' });
    });

    it('deletes the superseded key past the window, and the old message is then unreadable', async () => {
        const oldDevice = installSpk(1);
        const { envelope_b64 } = await encryptForDevices(
            JSON.stringify({ type: 'text', body: 'ancient' }),
            SENDER_USER_ID, [oldDevice], DEVICE_ID,
        );

        installSpk(2);
        const supersededAt = Date.now();
        store.set('signed_prekey_superseded_1', new Date(supersededAt).toISOString());

        const deleted = pruneSupersededSignedPrekeys(supersededAt + SPK_RETENTION_MS + DAY);
        expect(deleted).toEqual([1]);

        // Every trace gone — this is what bounds a SecureStore dump.
        expect(store.get('signed_prekey_priv_1')).toBeUndefined();
        expect(store.get('signed_prekey_pub_1')).toBeUndefined();
        expect(store.get('signed_prekey_sig_1')).toBeUndefined();
        expect(store.get('signed_prekey_superseded_1')).toBeUndefined();

        // The deletion is real, not bookkeeping: the ciphertext can no longer
        // be opened even holding the whole remaining key store.
        expect(() => decryptEnvelope(envelope_b64, DEVICE_ID, spkCandidatesFromStore()))
            .toThrow(/WRAP_AUTH_FAILED/);
    });

    it('never deletes the active key, however old it is', () => {
        installSpk(1);
        store.set('signed_prekey_superseded_1', new Date(0).toISOString());

        expect(pruneSupersededSignedPrekeys(Date.now() + 10 * SPK_RETENTION_MS)).toEqual([]);
        expect(store.get('signed_prekey_priv_1')).toBeDefined();
        // A stamp on the active key is cleared rather than honoured.
        expect(store.get('signed_prekey_superseded_1')).toBeUndefined();
    });

    it('stamps an unstamped superseded key instead of deleting it (existing-fleet migration)', () => {
        // Every device in the field has been accumulating signed-prekey
        // privates with no supersession stamps. Deleting those on sight would
        // destroy keys for genuinely in-flight messages.
        installSpk(1);
        installSpk(2);
        store.delete('signed_prekey_superseded_1');

        const now = Date.now();
        expect(pruneSupersededSignedPrekeys(now)).toEqual([]);
        expect(store.get('signed_prekey_priv_1')).toBeDefined();
        expect(store.get('signed_prekey_superseded_1')).toBe(new Date(now).toISOString());

        // ...and it ages out normally from the stamp, not from key creation.
        expect(pruneSupersededSignedPrekeys(now + SPK_RETENTION_MS - DAY)).toEqual([]);
        expect(pruneSupersededSignedPrekeys(now + SPK_RETENTION_MS + DAY)).toEqual([1]);
    });

    it('does nothing when the active key cannot be identified (fails closed)', () => {
        installSpk(1);
        installSpk(2);
        store.set('signed_prekey_superseded_1', new Date(0).toISOString());
        store.delete('signed_prekey_active_id');

        expect(pruneSupersededSignedPrekeys(Date.now())).toEqual([]);
        expect(store.get('signed_prekey_priv_1')).toBeDefined();
    });

    it('re-stamps rather than deleting when the clock has moved backwards', () => {
        installSpk(1);
        installSpk(2);
        const now = Date.now();
        store.set('signed_prekey_superseded_1', new Date(now + 5 * DAY).toISOString());

        expect(pruneSupersededSignedPrekeys(now)).toEqual([]);
        expect(store.get('signed_prekey_superseded_1')).toBe(new Date(now).toISOString());
    });

    it('retains long enough to cover the server-side envelope ceiling', () => {
        // The retention window is DERIVED from how long the server can hold an
        // undelivered envelope. If sweepOldMessageEnvelopes' 30-day cutoff is
        // ever raised without raising this, old-but-still-deliverable messages
        // silently stop decrypting — which reads as a delivery bug, not a key
        // retention bug. Pin the relationship so the coupling is checked.
        expect(SPK_RETENTION_MS).toBeGreaterThan(SERVER_ENVELOPE_RETENTION_MS);
        expect(SERVER_ENVELOPE_RETENTION_MS).toBe(30 * DAY);
    });
});
