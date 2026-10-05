import { describe, it, expect, beforeAll, vi } from 'vitest';

// Real 600k-iteration PBKDF2 per encrypt/decrypt call — under full-suite
// parallel load (many worker threads doing this simultaneously), a single
// call can occasionally exceed vitest's 5s default from CPU contention
// alone, not a logic issue. Same fix as driveBackup.test.ts.
vi.setConfig({ testTimeout: 30_000 });

// crypto.ts calls window.crypto.subtle / window.btoa / window.atob directly.
// vitest's `environment: 'node'` setup (vitest.setup.ts) stubs a plain
// `window` object for modules that reference it, but doesn't alias
// window.crypto/btoa/atob to the real Node globals — do that here, scoped to
// this test file, rather than touching the shared setup for every test.
beforeAll(() => {
    const w = window as any;
    w.crypto = globalThis.crypto;
    w.btoa = globalThis.btoa;
    w.atob = globalThis.atob;
});

const {
    encryptBackup, decryptBackup,
    deriveBackupKey, encryptWithKey, decryptWithKey, parseBackupHeader,
} = await import('./crypto');

describe('encryptBackup / decryptBackup — v2 round trip', () => {
    it('round-trips arbitrary JSON payloads', async () => {
        const payload = JSON.stringify({ hello: 'world', n: 42, nested: { a: [1, 2, 3] } });
        const blob = await encryptBackup(payload, 'correct horse battery staple');
        const out = await decryptBackup(blob, 'correct horse battery staple');
        expect(out).toBe(payload);
    });

    it('produces the v2 magic-prefixed format', async () => {
        const blob = await encryptBackup('{}', 'pw');
        const buf = new Uint8Array(await blob.arrayBuffer());
        expect(buf[0]).toBe(0x43); // 'C'
        expect(buf[1]).toBe(0x4c); // 'L'
        expect(buf[2]).toBe(0x02); // version 2
    });

    it('rejects the wrong password', async () => {
        const blob = await encryptBackup('secret data', 'right-password');
        await expect(decryptBackup(blob, 'wrong-password')).rejects.toThrow();
    });

    it('produces a different ciphertext (and salt/IV) on every call for the same plaintext+password — never reuses randomness', async () => {
        const a = new Uint8Array(await (await encryptBackup('same payload', 'same pw')).arrayBuffer());
        const b = new Uint8Array(await (await encryptBackup('same payload', 'same pw')).arrayBuffer());
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    });

    it('rejects a too-small blob', async () => {
        const tooSmall = new Blob([new Uint8Array([0x43, 0x4c, 0x02, 1, 2, 3])]);
        await expect(decryptBackup(tooSmall, 'pw')).rejects.toThrow(/too small/i);
    });
});

describe('decryptBackup — v1 legacy format (no magic prefix)', () => {
    it('still decrypts a hand-built v1 blob (PBKDF2-SHA-256/100k, no magic)', async () => {
        const password = 'legacy-pw';
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveBackupKey(password, salt, 100_000, 'SHA-256');
        const ivAndCt = await encryptWithKey('legacy payload', key);
        // v1 format: [salt 16B][IV 12B][ciphertext] — no magic prefix.
        const v1Bytes = new Uint8Array(16 + ivAndCt.length);
        v1Bytes.set(salt, 0);
        v1Bytes.set(ivAndCt, 16);
        const blob = new Blob([v1Bytes]);

        const out = await decryptBackup(blob, password);
        expect(out).toBe('legacy payload');
    });
});

describe('parseBackupHeader', () => {
    it('parses a v2 blob correctly', async () => {
        const blob = await encryptBackup('{"x":1}', 'pw');
        const header = parseBackupHeader(await blob.arrayBuffer());
        expect(header).not.toBeNull();
        expect(header!.iterations).toBe(600_000);
        expect(header!.hash).toBe('SHA-512');
        expect(header!.salt.length).toBe(16);
        expect(header!.iv.length).toBe(12);
    });

    it('returns null for a buffer too small to be either format', () => {
        expect(parseBackupHeader(new Uint8Array([1, 2, 3]).buffer)).toBeNull();
    });

    // The header (salt/KDF params) is intentionally readable WITHOUT the
    // password — standard PBKDF2 practice, and what lets
    // incrementalBackup.ts recover an existing manifest's salt to reuse for
    // chunk dedup before it has confirmed the password is even correct.
    it('parses the header successfully even though the password is unknown/irrelevant to parsing', async () => {
        const blob = await encryptBackup('{}', 'some-password');
        const header = parseBackupHeader(await blob.arrayBuffer());
        expect(header).not.toBeNull();
    });
});

describe('deriveBackupKey / encryptWithKey / decryptWithKey — the shared-key primitives incrementalBackup.ts is built on', () => {
    it('round-trips when reusing ONE derived key across multiple encrypt calls', async () => {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveBackupKey('shared-pw', salt, 600_000, 'SHA-512');

        const a = await encryptWithKey('payload A', key);
        const b = await encryptWithKey('payload B', key);

        // Different IVs (random per call) even under the same key.
        expect(Buffer.from(a.slice(0, 12)).equals(Buffer.from(b.slice(0, 12)))).toBe(false);

        expect(await decryptWithKey(a, key)).toBe('payload A');
        expect(await decryptWithKey(b, key)).toBe('payload B');
    });

    it('fails to decrypt with a DIFFERENT key derived from a different password', async () => {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key1 = await deriveBackupKey('pw-one', salt, 600_000, 'SHA-512');
        const key2 = await deriveBackupKey('pw-two', salt, 600_000, 'SHA-512');
        const bytes = await encryptWithKey('secret', key1);
        await expect(decryptWithKey(bytes, key2)).rejects.toThrow();
    });

    it('rejects a payload too short to contain an IV', async () => {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveBackupKey('pw', salt, 600_000, 'SHA-512');
        await expect(decryptWithKey(new Uint8Array([1, 2, 3]), key)).rejects.toThrow(/too small/i);
    });
});
