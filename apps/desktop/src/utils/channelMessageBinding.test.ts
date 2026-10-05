import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { isChannelServeRejection, oldestFirst } from './channelIntegrity';

/**
 * G4 — server-channel message replay / context binding.
 *
 * Runs the REAL electron/e2ee-engine.ts, electron/channel-keys.ts and
 * electron/channel-replay.ts; only SecureStore (which imports `electron`) is
 * stubbed with an in-memory map, the same pattern as channelKeys.smoke.test.ts.
 *
 * Threat: the server stores channel rows and assigns their ids, so it can
 * re-insert a genuine row under a new id, re-label its sender, or move it to a
 * channel/epoch that happens to share the key. These tests pin that each of
 * those is refused, that legacy (v1, unbound) rows still decrypt, and that an
 * OLD client can still read a NEW (v2) message.
 */

const store = new Map<string, string>();
vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => { store.set(k, v); },
        setDeferred: (k: string, v: string) => { store.set(k, v); },
        setMany: (entries: Record<string, string>) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); },
        delete: (k: string) => { store.delete(k); },
        deleteDeferred: (k: string) => { store.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.keys()],
    },
}));

type Engine = typeof import('../../electron/e2ee-engine');
type Keys = typeof import('../../electron/channel-keys');

let engine: Engine;
let keys: Keys;

/** Fresh module state (replay ledger + channel-key cache) — models a restart. */
async function loadModules(): Promise<void> {
    vi.resetModules();
    keys = await import('../../electron/channel-keys');
    engine = await import('../../electron/e2ee-engine');
}

const ROTATES = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const ALICE_USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ALICE_DEV = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const MALLORY_USER = 'mmmmmmmm-0000-4000-8000-000000000002';
const MALLORY_DEV = 'mmmmmmmm-0000-4000-8000-0000000000d2';

let alicePubB64 = '';
let chanSeq = 0;
const newChannel = () => `cccccccc-0000-4000-8000-${String(++chanSeq).padStart(12, '0')}`;
const keyB64 = () => crypto.randomBytes(32).toString('base64');

/** Install Alice's Ed25519 identity in the store the engine signs with. */
function installIdentity(): void {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const priv = privateKey.export({ format: 'jwk' }) as { d: string };
    const pub = publicKey.export({ format: 'jwk' }) as { x: string };
    store.set('identity_priv', Buffer.from(priv.d, 'base64url').toString('hex'));
    alicePubB64 = Buffer.from(pub.x, 'base64url').toString('base64');
    store.set('identity_pub', alicePubB64);
}

function signWithAlice(data: Buffer): string {
    const x = Buffer.from(alicePubB64, 'base64').toString('base64url');
    const d = Buffer.from(store.get('identity_priv')!, 'hex').toString('base64url');
    const k = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d, x }, format: 'jwk' });
    return Buffer.from(crypto.sign(null, data, k)).toString('base64');
}

/** What every pre-G4 client wrote: plain content, no AAD, sig over ciphertext. */
function encryptLegacyV1(contentJson: string, keyB: string): { nonce_b64: string; ciphertext_b64: string; signature_b64: string } {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyB, 'base64'), nonce);
    const ct = Buffer.concat([c.update(Buffer.from(contentJson, 'utf8')), c.final(), c.getAuthTag()]);
    return { nonce_b64: nonce.toString('base64'), ciphertext_b64: ct.toString('base64'), signature_b64: signWithAlice(ct) };
}

/** What every pre-G4 client does on receive — verbatim logic of the old
 *  decryptChannelMessage — followed by the renderer's JSON.parse. */
function oldClientDecrypt(row: { nonce_b64: string; ciphertext_b64: string; signature_b64: string }, keyB: string, senderPubB64: string): Record<string, unknown> {
    const ct = Buffer.from(row.ciphertext_b64, 'base64');
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(senderPubB64, 'base64').toString('base64url') }, format: 'jwk' });
    if (!crypto.verify(null, ct, pub, Buffer.from(row.signature_b64, 'base64'))) throw new Error('old client: sig invalid');
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB, 'base64'), Buffer.from(row.nonce_b64, 'base64'));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'));
}

function decrypt(row: { epoch: number; nonce_b64: string; ciphertext_b64: string; signature_b64: string }, over: Partial<{
    channel_id: string; epoch: number; message_id: string; sender_user_id: string | null; sender_device_id: string | null; nonce_b64: string; sender_identity_pub_b64: string;
}> & { channel_id: string }): string {
    return engine.decryptChannelMessage({
        epoch: row.epoch,
        nonce_b64: row.nonce_b64,
        ciphertext_b64: row.ciphertext_b64,
        signature_b64: row.signature_b64,
        sender_identity_pub_b64: alicePubB64,
        message_id: 'row-1',
        sender_user_id: ALICE_USER,
        sender_device_id: ALICE_DEV,
        ...over,
    });
}

const CONTENT = { client_msg_id: 'cm-1', type: 'text', text: 'approve the transfer' };
const SENDER = { user_id: ALICE_USER, device_id: ALICE_DEV };

beforeEach(async () => {
    store.clear();
    installIdentity();
    await loadModules();
});

describe('G4 — v2 round trip', () => {
    it('decrypts to the original content with the binding stripped', () => {
        const ch = newChannel();
        keys.setChannelKey(ch, 1, keyB64(), ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        const out = JSON.parse(decrypt(row, { channel_id: ch }));
        expect(out).toEqual(CONTENT);
        expect(out).not.toHaveProperty('_cb');
    });

    it('actually carries a v2 binding naming channel, epoch, nonce, message id and sender', () => {
        const ch = newChannel();
        const k = keyB64();
        keys.setChannelKey(ch, 3, k, ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        const inner = oldClientDecrypt(row, k, alicePubB64);
        expect(inner._cb).toEqual({ v: 2, c: ch, e: 3, n: row.nonce_b64, m: 'cm-1', d: ALICE_DEV, u: ALICE_USER });
    });
});

describe('G4 — replay (same ciphertext, new server id)', () => {
    it('refuses a re-post under a new id, while re-reading the SAME row stays accepted', () => {
        const ch = newChannel();
        keys.setChannelKey(ch, 1, keyB64(), ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        expect(() => decrypt(row, { channel_id: ch, message_id: 'orig' })).not.toThrow();
        // Every history refresh re-decrypts the newest page — must not trip.
        expect(() => decrypt(row, { channel_id: ch, message_id: 'orig' })).not.toThrow();
        expect(() => decrypt(row, { channel_id: ch, message_id: 'replayed' })).toThrow(/\[E2EE:CHANNEL_REPLAY\]/);
    });

    it('is not bypassed by re-encoding the nonce (base64 decoding is lenient)', () => {
        const ch = newChannel();
        keys.setChannelKey(ch, 1, keyB64(), ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        decrypt(row, { channel_id: ch, message_id: 'orig' });
        const reencoded = ' ' + row.nonce_b64; // decodes to the same 12 bytes
        expect(Buffer.from(reencoded, 'base64').equals(Buffer.from(row.nonce_b64, 'base64'))).toBe(true);
        expect(() => decrypt(row, { channel_id: ch, message_id: 'replayed', nonce_b64: reencoded })).toThrow(/\[E2EE:CHANNEL_REPLAY\]/);
    });

    it('catches replays of LEGACY (v1) rows too — the ledger is version-independent', () => {
        const ch = newChannel();
        const k = keyB64();
        keys.setChannelKey(ch, 1, k, ROTATES);
        const row = { epoch: 1, ...encryptLegacyV1(JSON.stringify(CONTENT), k) };
        decrypt(row, { channel_id: ch, message_id: 'orig' });
        expect(() => decrypt(row, { channel_id: ch, message_id: 'replayed' })).toThrow(/\[E2EE:CHANNEL_REPLAY\]/);
    });

    it('survives a restart: the ledger is persisted and reloaded', async () => {
        const ch = newChannel();
        const k = keyB64();
        keys.setChannelKey(ch, 1, k, ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        decrypt(row, { channel_id: ch, message_id: 'orig' });
        engine.flushReplayCache(); // before-quit hook
        expect(store.has('__chan_replay__')).toBe(true);

        await loadModules(); // fresh process: empty in-memory ledger + key cache
        expect(() => decrypt(row, { channel_id: ch, message_id: 'orig' })).not.toThrow();
        expect(() => decrypt(row, { channel_id: ch, message_id: 'replayed' })).toThrow(/\[E2EE:CHANNEL_REPLAY\]/);
    });

    it('never overwrites an unreadable on-disk ledger with an empty one', async () => {
        store.set('__chan_replay__', '{not json');
        await loadModules();
        const ch = newChannel();
        keys.setChannelKey(ch, 1, keyB64(), ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        decrypt(row, { channel_id: ch, message_id: 'orig' });
        engine.flushReplayCache();
        errSpy.mockRestore();
        expect(store.get('__chan_replay__')).toBe('{not json');
        // In-session protection still holds.
        expect(() => decrypt(row, { channel_id: ch, message_id: 'replayed' })).toThrow(/\[E2EE:CHANNEL_REPLAY\]/);
    });

    it('does not admit a row that failed another check into the ledger', () => {
        const ch = newChannel();
        keys.setChannelKey(ch, 1, keyB64(), ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        // A mis-labelled copy arrives first and is refused...
        expect(() => decrypt(row, { channel_id: ch, message_id: 'forged', sender_device_id: MALLORY_DEV })).toThrow(/CHANNEL_BINDING/);
        // ...and must not have claimed the slot from the genuine row.
        expect(() => decrypt(row, { channel_id: ch, message_id: 'genuine' })).not.toThrow();
    });
});

describe('G4 — cross-channel / cross-epoch', () => {
    it('refuses a v2 message moved into another channel that shares the key', () => {
        // A member who created both channels can hand out the same key for
        // each, so key separation alone does not stop a move.
        const a = newChannel();
        const b = newChannel();
        const k = keyB64();
        keys.setChannelKey(a, 1, k, ROTATES);
        keys.setChannelKey(b, 1, k, ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), a, SENDER);
        expect(() => decrypt(row, { channel_id: b, message_id: 'moved' })).toThrow(/\[E2EE:CHANNEL_BINDING\] channel/);
    });

    it('refuses a v2 message re-labelled to another epoch that shares the key', () => {
        const ch = newChannel();
        const k = keyB64();
        keys.setChannelKey(ch, 1, k, ROTATES);
        keys.setChannelKey(ch, 2, k, ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER); // latest = 2
        expect(row.epoch).toBe(2);
        expect(() => decrypt({ ...row, epoch: 1 }, { channel_id: ch, message_id: 'm' })).toThrow(/\[E2EE:CHANNEL_BINDING\] epoch/);
    });

    it('a channel with a DIFFERENT key cannot even decrypt it (key separation, unchanged)', () => {
        const a = newChannel();
        const b = newChannel();
        keys.setChannelKey(a, 1, keyB64(), ROTATES);
        keys.setChannelKey(b, 1, keyB64(), ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), a, SENDER);
        expect(() => decrypt(row, { channel_id: b, message_id: 'moved' })).toThrow();
    });
});

describe('G4 — tamper', () => {
    const setup = () => {
        const ch = newChannel();
        keys.setChannelKey(ch, 1, keyB64(), ROTATES);
        return { ch, row: engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER) };
    };

    it('refuses a row whose sender DEVICE label was changed (misattribution)', () => {
        const { ch, row } = setup();
        expect(() => decrypt(row, { channel_id: ch, sender_device_id: MALLORY_DEV })).toThrow(/\[E2EE:CHANNEL_BINDING\] sender device/);
    });

    it('refuses a row whose sender USER label was changed (misattribution)', () => {
        const { ch, row } = setup();
        expect(() => decrypt(row, { channel_id: ch, sender_user_id: MALLORY_USER })).toThrow(/\[E2EE:CHANNEL_BINDING\] sender user/);
    });

    it('a flipped ciphertext bit fails the signature', () => {
        const { ch, row } = setup();
        const ct = Buffer.from(row.ciphertext_b64, 'base64');
        ct[5] ^= 0x01;
        expect(() => decrypt({ ...row, ciphertext_b64: ct.toString('base64') }, { channel_id: ch })).toThrow(/signature verification failed/);
    });

    it('a different 12-byte nonce fails GCM authentication', () => {
        const { ch, row } = setup();
        const n = Buffer.from(row.nonce_b64, 'base64');
        n[0] ^= 0x01;
        expect(() => decrypt({ ...row, nonce_b64: n.toString('base64') }, { channel_id: ch })).toThrow();
    });

    it('a non-12-byte nonce is refused as malformed', () => {
        const { ch, row } = setup();
        expect(() => decrypt({ ...row, nonce_b64: crypto.randomBytes(16).toString('base64') }, { channel_id: ch })).toThrow(/\[E2EE:CHANNEL_MALFORMED\]/);
    });

    it('a key holder cannot re-bind a genuine message: re-encrypting changes the ciphertext, which Alice never signed', () => {
        const ch = newChannel();
        const other = newChannel();
        const k = keyB64();
        keys.setChannelKey(ch, 1, k, ROTATES);
        keys.setChannelKey(other, 1, k, ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        const inner = oldClientDecrypt(row, k, alicePubB64);
        const cb = inner._cb as Record<string, unknown>;
        const forgedPt = JSON.stringify({ ...inner, _cb: { ...cb, c: other } });
        const nonce = Buffer.from(row.nonce_b64, 'base64');
        const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(k, 'base64'), nonce);
        const forgedCt = Buffer.concat([c.update(forgedPt, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
        // Keeps Alice's ORIGINAL signature — the forger does not hold her key.
        expect(() => decrypt({ ...row, ciphertext_b64: forgedCt }, { channel_id: other, message_id: 'x' })).toThrow(/signature verification failed/);
    });
});

describe('G4 — compatibility', () => {
    it('NEW client reads an OLD-format (v1, unbound) message unchanged', () => {
        const ch = newChannel();
        const k = keyB64();
        keys.setChannelKey(ch, 1, k, ROTATES);
        const row = { epoch: 1, ...encryptLegacyV1(JSON.stringify(CONTENT), k) };
        expect(JSON.parse(decrypt(row, { channel_id: ch }))).toEqual(CONTENT);
    });

    it('OLD client reads a NEW (v2) message: sig and GCM still verify, content fields intact', () => {
        const ch = newChannel();
        const k = keyB64();
        keys.setChannelKey(ch, 1, k, ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        const seen = oldClientDecrypt(row, k, alicePubB64);
        expect(seen.type).toBe('text');
        expect(seen.text).toBe(CONTENT.text);
        expect(seen.client_msg_id).toBe(CONTENT.client_msg_id);
    });

    it('a `_cb` copied along inside content (nonce does not match) is stripped and treated as legacy', () => {
        const ch = newChannel();
        const k = keyB64();
        keys.setChannelKey(ch, 1, k, ROTATES);
        const stale = { v: 2, c: 'some-other-channel', e: 9, n: 'AAAAAAAAAAAAAAAA', m: 'old' };
        const row = { epoch: 1, ...encryptLegacyV1(JSON.stringify({ ...CONTENT, _cb: stale }), k) };
        expect(JSON.parse(decrypt(row, { channel_id: ch }))).toEqual(CONTENT);
    });

    it('binds a random message id when content has no usable client_msg_id', () => {
        const ch = newChannel();
        const k = keyB64();
        keys.setChannelKey(ch, 1, k, ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify({ type: 'reaction', target_id: 't', emoji: 'x', action: 'add' }), ch, SENDER);
        const m = (oldClientDecrypt(row, k, alicePubB64)._cb as { m: string }).m;
        expect(m).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('an unlabelled row (no sender ids passed) still decrypts; only present labels are compared', () => {
        const ch = newChannel();
        keys.setChannelKey(ch, 1, keyB64(), ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        expect(() => decrypt(row, { channel_id: ch, sender_user_id: null, sender_device_id: null })).not.toThrow();
    });
});

describe('G4 — renderer helpers', () => {
    it('recognises the engine tags through the ipcRenderer.invoke wrapper, and nothing else', () => {
        const wrap = (m: string) => new Error(`Error invoking remote method 'channel:decrypt-message': Error: ${m}`);
        expect(isChannelServeRejection(wrap('[E2EE:CHANNEL_REPLAY] x'))).toBe(true);
        expect(isChannelServeRejection(wrap('[E2EE:CHANNEL_BINDING] channel mismatch'))).toBe(true);
        expect(isChannelServeRejection(wrap('[E2EE:CHANNEL_MALFORMED] nonce'))).toBe(true);
        // A missing key must keep the placeholder + key-request path.
        expect(isChannelServeRejection(wrap('[E2EE] Channel key for channel c epoch 1 not in local store'))).toBe(false);
        expect(isChannelServeRejection(wrap('[E2EE] Channel message signature verification failed'))).toBe(false);
        expect(isChannelServeRejection(undefined)).toBe(false);
    });

    it('orders rows oldest-first without mutating the input', () => {
        const rows = [
            { id: 'new', created_at: '2026-09-02T00:00:00Z' },
            { id: 'bad', created_at: 'nope' },
            { id: 'old', created_at: '2026-09-01T00:00:00Z' },
        ];
        expect(oldestFirst(rows).map(r => r.id)).toEqual(['old', 'new', 'bad']);
        expect(rows[0].id).toBe('new');
    });

    it('oldest-first decryption keeps the ORIGINAL when a fresh device sees both copies', () => {
        const ch = newChannel();
        keys.setChannelKey(ch, 1, keyB64(), ROTATES);
        const row = engine.encryptChannelMessage(JSON.stringify(CONTENT), ch, SENDER);
        const page = [ // server order: newest first
            { ...row, id: 'replay', created_at: '2026-09-20T00:00:00Z' },
            { ...row, id: 'original', created_at: '2026-09-01T00:00:00Z' },
        ];
        const accepted: string[] = [];
        for (const r of oldestFirst(page)) {
            try { decrypt(r, { channel_id: ch, message_id: r.id }); accepted.push(r.id); } catch { /* dropped */ }
        }
        expect(accepted).toEqual(['original']);
    });
});
