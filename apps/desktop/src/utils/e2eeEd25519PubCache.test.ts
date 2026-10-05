import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'crypto';

/**
 * The freeze fix caches imported sender Ed25519 PUBLIC keys in
 * electron/e2ee-engine.ts. These pin the two properties that make that safe:
 * a hit is the same key (not a different sender's), and signature checks are
 * still performed against it — a forged signature is still rejected.
 */
vi.mock('../../electron/storage', () => ({
    secureStore: { get: () => null, set: () => {}, setDeferred: () => {}, delete: () => {}, deleteDeferred: () => {}, batch: <T>(fn: () => T): T => fn(), keys: () => [] },
}));
const { importEd25519Pub } = await import('../../electron/e2ee-engine');

function ed25519() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    return { privateKey, pubB64: Buffer.from(x, 'base64url').toString('base64') };
}

describe('importEd25519Pub (cached sender public keys)', () => {
    it('returns the same KeyObject for the same key, including a lenient base64 spelling', () => {
        const a = ed25519();
        const k1 = importEd25519Pub(a.pubB64);
        expect(importEd25519Pub(a.pubB64)).toBe(k1);
        expect(importEd25519Pub(a.pubB64.replace(/=+$/, ''))).toBe(k1);
    });

    it('never hands one sender another sender\'s key', () => {
        const a = ed25519(); const b = ed25519();
        const ka = importEd25519Pub(a.pubB64);
        const kb = importEd25519Pub(b.pubB64);
        expect(ka).not.toBe(kb);
        expect(ka.export({ format: 'jwk' })).not.toEqual(kb.export({ format: 'jwk' }));
    });

    it('verification still happens against the cached key: a forged signature fails', () => {
        const a = ed25519(); const mallory = ed25519();
        const msg = Buffer.from('ciphertext bytes');
        const good = crypto.sign(null, msg, a.privateKey);
        const forged = crypto.sign(null, msg, mallory.privateKey);
        const key = importEd25519Pub(a.pubB64);
        expect(crypto.verify(null, msg, importEd25519Pub(a.pubB64), good)).toBe(true);
        expect(crypto.verify(null, msg, key, forged)).toBe(false);
    });

    it('a malformed key still throws, and is not cached', () => {
        expect(() => importEd25519Pub(Buffer.from('short').toString('base64'))).toThrow();
        expect(() => importEd25519Pub(Buffer.from('short').toString('base64'))).toThrow();
    });
});
