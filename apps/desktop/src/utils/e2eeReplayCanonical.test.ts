import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

/**
 * DM replay admission is keyed on the DECODED ephemeral key, not on its wire
 * spelling.
 *
 * The HKDF info, the content AAD and the signed transcript all use the decoded
 * `eph` bytes, so any spelling Node's lenient base64 decoder maps to the same 32
 * bytes is an equally valid envelope. The replay set used to key on the raw
 * string, so a re-spelled `eph` was admitted a second time.
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
        keysWithPrefix: (p: string) => [...store.keys()].filter(k => k.startsWith(p)),
    },
}));

const { encryptForDevices, decryptEnvelope, flushReplayCache } = await import('../../electron/e2ee-engine');

function x25519Pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const pj = privateKey.export({ format: 'jwk' }) as { d: string };
    const uj = publicKey.export({ format: 'jwk' }) as { x: string };
    return {
        privHex: Buffer.from(pj.d, 'base64url').toString('hex'),
        pubB64: Buffer.from(uj.x, 'base64url').toString('base64'),
    };
}
function ed25519Pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const pj = privateKey.export({ format: 'jwk' }) as { d: string };
    const uj = publicKey.export({ format: 'jwk' }) as { x: string };
    return {
        privKey: privateKey,
        privHex: Buffer.from(pj.d, 'base64url').toString('hex'),
        pubB64: Buffer.from(uj.x, 'base64url').toString('base64'),
    };
}

const DEV = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
let spk: ReturnType<typeof x25519Pair>;
let recipientIdentity: ReturnType<typeof ed25519Pair>;
let spkSig: string;

beforeEach(() => {
    store.clear();
    const sender = ed25519Pair();
    store.set('identity_priv', sender.privHex);
    store.set('identity_pub', sender.pubB64);
    spk = x25519Pair();
    recipientIdentity = ed25519Pair();
    spkSig = crypto.sign(null, Buffer.from(spk.pubB64, 'base64'), recipientIdentity.privKey).toString('base64');
});

const device = () => ({ device_id: DEV, spk_pub_b64: spk.pubB64, sig_b64: spkSig, identity_pub_b64: recipientIdentity.pubB64 });
const cands = () => [{ id: 1, privHex: spk.privHex, pubB64: spk.pubB64 }];

function respell(envB64: string, f: (eph: string) => string): string {
    const env = JSON.parse(Buffer.from(envB64, 'base64').toString('utf8'));
    const before = env.eph;
    env.eph = f(env.eph);
    expect(env.eph).not.toBe(before);
    return Buffer.from(JSON.stringify(env)).toString('base64');
}

const toUrlSafe = (e: string) => e.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('DM replay set keys on the canonical ephemeral key', () => {
    it('positive control: a fresh envelope decrypts once, an exact replay is refused', async () => {
        const r = await encryptForDevices(JSON.stringify({ type: 'text', text: 'hi' }), 'u', [device()], 'sender-dev');
        const out = decryptEnvelope(r.envelope_b64, DEV, cands());
        expect(JSON.parse(out.contentJson).text).toBe('hi');
        expect(() => decryptEnvelope(r.envelope_b64, DEV, cands())).toThrow(/REPLAY/);
    });

    it.each([
        ['padding stripped', (e: string) => e.replace(/=+$/, '')],
        ['URL-safe alphabet', toUrlSafe],
        ['embedded whitespace', (e: string) => e.slice(0, 10) + ' ' + e.slice(10)],
    ])('refuses a re-delivery with eph %s', async (_label, f) => {
        const r = await encryptForDevices(JSON.stringify({ type: 'text', text: 'pay me' }), 'u', [device()], 'sender-dev');
        decryptEnvelope(r.envelope_b64, DEV, cands());
        const replay = respell(r.envelope_b64, f);
        expect(() => decryptEnvelope(replay, DEV, cands())).toThrow(/REPLAY/);
    });

    it('refuses the canonical spelling after a re-spelled first delivery', async () => {
        const r = await encryptForDevices(JSON.stringify({ type: 'text', text: 'x' }), 'u', [device()], 'sender-dev');
        decryptEnvelope(respell(r.envelope_b64, e => e.replace(/=+$/, '')), DEV, cands());
        expect(() => decryptEnvelope(r.envelope_b64, DEV, cands())).toThrow(/REPLAY/);
    });

    it('rejects an eph that does not decode to 32 bytes', async () => {
        const r = await encryptForDevices(JSON.stringify({ type: 'text', text: 'x' }), 'u', [device()], 'sender-dev');
        const bad = respell(r.envelope_b64, e => e.slice(0, 20));
        expect(() => decryptEnvelope(bad, DEV, cands())).toThrow(/MALFORMED/);
    });

    it('failed (unauthenticated) attempts neither enter nor evict the replay set', async () => {
        const r1 = await encryptForDevices(JSON.stringify({ type: 'text', text: 'a' }), 'u', [device()], 'sender-dev');
        decryptEnvelope(r1.envelope_b64, DEV, cands());
        const forged = JSON.parse(Buffer.from(r1.envelope_b64, 'base64').toString('utf8'));
        forged.eph = x25519Pair().pubB64;
        const forgedB64 = Buffer.from(JSON.stringify(forged)).toString('base64');
        for (let i = 0; i < 3; i++) {
            expect(() => decryptEnvelope(forgedB64, DEV, cands())).toThrow(/WRAP_AUTH_FAILED/);
        }
        expect(() => decryptEnvelope(r1.envelope_b64, DEV, cands())).toThrow(/REPLAY/);
        // The persisted set stores the canonical spelling — the same string
        // older builds persisted, so an existing on-disk set stays valid.
        flushReplayCache();
        const persisted = JSON.parse(store.get('__eph_replay__') ?? '[]') as string[];
        const eph = JSON.parse(Buffer.from(r1.envelope_b64, 'base64').toString('utf8')).eph;
        expect(persisted).toContain(eph);
        expect(persisted).not.toContain(forged.eph);
    });
});
