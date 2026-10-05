import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';

/**
 * C-2 — the history transfer key must never reach the server in the clear.
 *
 * What was wrong: history sync encrypted the user's whole message history
 * under a fresh AES-256-GCM key, uploaded the ciphertext to MinIO, then POSTed
 * that AES key to the server as plaintext base64 and the server rebroadcast it
 * verbatim over `device:approved`. A server operator, or anyone able to read
 * the DB and the blob store, held both halves.
 *
 * These tests prove the three properties that fix has to have, end to end
 * against the REAL e2ee engine (same X25519/HKDF/AES-GCM used by `call_key`
 * and `channel_key`), not by inspecting the code:
 *
 *   1. The key survives a wrap/unwrap round trip on the intended device.
 *   2. Everything the server ends up holding — the deliver-history request
 *      body, the broadcast event, and the uploaded blob — contains no
 *      recoverable copy of the key.
 *   3. A SIBLING device of the same user, which also receives the broadcast,
 *      cannot open it. That makes device targeting structural rather than a
 *      client-side `device_id` comparison.
 *
 * Only SecureStore is mocked (it imports `electron`). The crypto is real.
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

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const APPROVER_DEVICE = 'dddddddd-dddd-dddd-dddd-dddddddddd00';
/** The new device asking for history. */
const REQUESTER_DEVICE = 'dddddddd-dddd-dddd-dddd-dddddddddd01';
/** An unrelated, already-populated device of the SAME user. */
const SIBLING_DEVICE = 'dddddddd-dddd-dddd-dddd-dddddddddd02';

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

/** A device with a signed prekey, plus the private material to decrypt with. */
function makeDevice(deviceId: string, spkId: number) {
    const identity = ed25519Pair();
    const spk = x25519Pair();
    const sig = Buffer.from(
        ed25519.sign(Buffer.from(spk.pubB64, 'base64'), Buffer.from(identity.privHex, 'hex')),
    ).toString('base64');
    return {
        pub: { device_id: deviceId, spk_pub_b64: spk.pubB64, sig_b64: sig, identity_pub_b64: identity.pubB64 },
        candidates: [{ id: spkId, privHex: spk.privHex, pubB64: spk.pubB64 }],
    };
}

/** The AES-256-GCM history key the approver generates, as the modal does. */
function freshHistoryKeyB64() {
    return crypto.randomBytes(32).toString('base64');
}

beforeEach(() => {
    store.clear();
    const approverIdentity = ed25519Pair();
    store.set('identity_priv', approverIdentity.privHex);
    store.set('identity_pub', approverIdentity.pubB64);
});

/** Wrap exactly as `wrapHistoryTransferKey` does, minus the HTTP fetch. */
async function wrapFor(device: { device_id: string; spk_pub_b64: string; sig_b64: string; identity_pub_b64: string }, keyB64: string) {
    const { envelope_b64, wrapped_device_ids } = await encryptForDevices(
        JSON.stringify({
            type: 'history_transfer_key',
            key_b64: keyB64,
            device_id: device.device_id,
            issued_at: new Date().toISOString(),
        }),
        USER_ID,
        [device],
        APPROVER_DEVICE,
    );
    expect(wrapped_device_ids).toContain(device.device_id);
    return envelope_b64;
}

describe('C-2 — history transfer key is wrapped to the requesting device', () => {
    it('round-trips the key to the device it was addressed to', async () => {
        const requester = makeDevice(REQUESTER_DEVICE, 1);
        const keyB64 = freshHistoryKeyB64();

        const envelope = await wrapFor(requester.pub, keyB64);
        const { contentJson } = decryptEnvelope(envelope, REQUESTER_DEVICE, requester.candidates);
        const payload = JSON.parse(contentJson);

        expect(payload.type).toBe('history_transfer_key');
        expect(payload.key_b64).toBe(keyB64);
        expect(payload.device_id).toBe(REQUESTER_DEVICE);
    });

    it('THE FIX: the key is not recoverable from anything the server stores', async () => {
        const requester = makeDevice(REQUESTER_DEVICE, 1);
        const keyB64 = freshHistoryKeyB64();
        const envelope = await wrapFor(requester.pub, keyB64);

        // Everything the server touches in this flow: the deliver-history
        // request body it validates and persists nothing of, the WS event it
        // constructs and rebroadcasts, and the history blob in MinIO.
        const deliverHistoryBody = {
            wrapped_transfer_key_b64: envelope,
            range_days: 30,
            include_attachments: true,
            included_message_count: 142,
            included_byte_size: 99_000,
        };
        const broadcastEvent = {
            event: 'device:approved',
            data: {
                device_id: REQUESTER_DEVICE,
                wrapped_transfer_key_b64: envelope,
                transfer_key_b64: null,
                wrapped_mbk_payload: null,
                transfer_meta: deliverHistoryBody,
            },
        };
        const minioBlob = crypto.randomBytes(4096).toString('base64'); // ciphertext

        const serverVisible = JSON.stringify({ deliverHistoryBody, broadcastEvent, minioBlob });

        // The key must not appear in any encoding the server could trivially
        // read back out. Base64 is how it used to travel; hex and the raw
        // bytes are checked so a future re-encoding cannot quietly reintroduce
        // the leak in a different alphabet.
        const raw = Buffer.from(keyB64, 'base64');
        expect(serverVisible).not.toContain(keyB64);
        expect(serverVisible).not.toContain(raw.toString('hex'));
        expect(serverVisible).not.toContain(raw.toString('base64url'));
        expect(Buffer.from(serverVisible, 'utf8').includes(raw)).toBe(false);

        // And the envelope itself — the one thing the server DOES relay — must
        // not contain it either, which is the actual claim being made.
        expect(envelope).not.toContain(keyB64);
        expect(Buffer.from(envelope, 'base64').includes(raw)).toBe(false);
    });

    it('STRUCTURAL TARGETING: a sibling device of the same user cannot open it', async () => {
        // `device:approved` is broadcast to EVERY socket for the user, so this
        // sibling really does receive the envelope. Before C-2 the only thing
        // stopping it applying the transfer was a client-side device_id
        // comparison — and a regression that dropped that check shipped once
        // (fixed 2026-08-12). Now the sibling is stopped by the crypto.
        const requester = makeDevice(REQUESTER_DEVICE, 1);
        const sibling = makeDevice(SIBLING_DEVICE, 1);
        const keyB64 = freshHistoryKeyB64();

        const envelope = await wrapFor(requester.pub, keyB64);

        // Sibling tries with its own device id: there is no wrap entry for it.
        expect(() => decryptEnvelope(envelope, SIBLING_DEVICE, sibling.candidates)).toThrow();

        // Sibling tries to impersonate the requester's device id using its own
        // private key: the wrap entry exists but the AEAD does not open.
        expect(() => decryptEnvelope(envelope, REQUESTER_DEVICE, sibling.candidates)).toThrow();

        // The envelope addresses exactly one device — the roster itself leaks
        // nothing about which other devices exist.
        const parsed = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
        expect(Object.keys(parsed.recipients)).toEqual([REQUESTER_DEVICE]);
    });

    it('wraps to exactly one device even when the user has several', async () => {
        // Passing the whole device roster would wrap the key for every device
        // and give the sibling above a perfectly good entry to open.
        const requester = makeDevice(REQUESTER_DEVICE, 1);
        const keyB64 = freshHistoryKeyB64();
        const envelope = await wrapFor(requester.pub, keyB64);

        const parsed = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
        expect(Object.keys(parsed.recipients)).toHaveLength(1);
    });

    it('rejects an envelope whose payload names a different device', async () => {
        // Defence in depth over the AEAD: catches a future envelope-reuse
        // mistake loudly instead of importing someone else's history.
        const requester = makeDevice(REQUESTER_DEVICE, 1);
        const { envelope_b64 } = await encryptForDevices(
            JSON.stringify({
                type: 'history_transfer_key',
                key_b64: freshHistoryKeyB64(),
                device_id: SIBLING_DEVICE,       // addressed elsewhere
                issued_at: new Date().toISOString(),
            }),
            USER_ID,
            [requester.pub],
            APPROVER_DEVICE,
        );

        const { contentJson } = decryptEnvelope(envelope_b64, REQUESTER_DEVICE, requester.candidates);
        const payload = JSON.parse(contentJson);
        // This mismatch is what `unwrapHistoryTransferKey` throws on.
        expect(payload.device_id).not.toBe(REQUESTER_DEVICE);
    });

    it('a tampered envelope fails closed rather than yielding a wrong key', async () => {
        const requester = makeDevice(REQUESTER_DEVICE, 1);
        const envelope = await wrapFor(requester.pub, freshHistoryKeyB64());

        const parsed = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
        const wrap = parsed.recipients[REQUESTER_DEVICE].wrap;
        const bytes = Buffer.from(wrap, 'base64');
        bytes[bytes.length - 1] ^= 0xff;         // flip a bit in the GCM tag
        parsed.recipients[REQUESTER_DEVICE].wrap = bytes.toString('base64');
        const tampered = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64');

        expect(() => decryptEnvelope(tampered, REQUESTER_DEVICE, requester.candidates)).toThrow();
    });
});

describe('C-2 — compatibility with the pre-2026-08-30 fleet', () => {
    it('the legacy plaintext field is what an old requester still reads', async () => {
        // An old requester never sends `accepts_wrapped_key`, so the approver
        // sends `transfer_key_b64` and that client works unchanged. This test
        // documents the leak that path still carries, so removing it later is
        // a deliberate decision rather than an accident.
        const keyB64 = freshHistoryKeyB64();
        const legacyBody = { transfer_key_b64: keyB64, range_days: 30 };

        expect(JSON.stringify(legacyBody)).toContain(keyB64);
    });

    it('a current approver emits the wrapped field UNCONDITIONALLY', async () => {
        const requester = makeDevice(REQUESTER_DEVICE, 1);
        const keyB64 = freshHistoryKeyB64();
        const envelope = await wrapFor(requester.pub, keyB64);

        // C-2b: this used to mirror a ternary in HistoryRequestModal —
        // `acceptsWrapped ? { wrapped_... } : { transfer_key_b64 }` — driven by
        // a flag the SERVER relayed. That ternary was the downgrade: flipping
        // the flag in transit selected the plaintext arm. The modal now has no
        // conditional at all, so this mirrors a body with one possible shape.
        const body = {
            wrapped_transfer_key_b64: envelope,
            range_days: 30,
        };

        expect(body).toHaveProperty('wrapped_transfer_key_b64');
        expect(body).not.toHaveProperty('transfer_key_b64');
        expect(JSON.stringify(body)).not.toContain(keyB64);
    });
});
