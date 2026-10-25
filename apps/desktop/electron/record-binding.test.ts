import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    WRITE_BOUND_RECORDS, encryptEntry, decryptEntry, isBoundEntry, migrateEntriesToBound,
    secureStoreEntryAad, kvRecordAad, type EncryptedEntry,
} from './record-binding';
import { KvCrypto, TAG_WRAPPED, TAG_WRAPPED_BOUND, TAG_RAW } from './kv-crypto';

const KEY = Buffer.alloc(32, 7);

/** The pre-binding SecureStore encrypt, verbatim, to produce real legacy entries. */
function legacyEncrypt(key: Buffer, plaintext: string): EncryptedEntry {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
    ciphertext += cipher.final('base64');
    return { iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext };
}
/** The pre-binding SecureStore decrypt, verbatim: what an OLDER build would do. */
function legacyDecrypt(key: Buffer, entry: EncryptedEntry): string {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
    d.setAuthTag(Buffer.from(entry.authTag, 'base64'));
    return d.update(entry.ciphertext, 'base64', 'utf8') + d.final('utf8');
}

describe('rollout guard', () => {
    it('phase 1: bound WRITES are off — flip only in a later release than the reader (see record-binding.ts)', () => {
        expect(WRITE_BOUND_RECORDS).toBe(false);
    });
});

describe('AAD encoding', () => {
    it('is unambiguous across names, owners and stores', () => {
        expect(secureStoreEntryAad('a:b')).not.toEqual(secureStoreEntryAad('a').toString() + ':b');
        expect(kvRecordAad(null, 'k')).not.toEqual(kvRecordAad('', 'k'));
        expect(kvRecordAad('u', 'k')).not.toEqual(kvRecordAad(null, 'k'));
        expect(kvRecordAad(null, 'k').equals(secureStoreEntryAad('k'))).toBe(false);
    });
});

describe('SecureStore entries', () => {
    it('legacy entries (written by older builds) still decrypt', () => {
        const e = legacyEncrypt(KEY, 'identity-secret');
        expect(isBoundEntry(e)).toBe(false);
        expect(decryptEntry(KEY, 'identity_priv', e)).toBe('identity-secret');
    });

    it('unbound writes are byte-format identical to the legacy writer (phase 1 changes nothing on disk)', () => {
        const e = encryptEntry(KEY, 'x', 'v', false);
        expect(Object.keys(e).sort()).toEqual(['authTag', 'ciphertext', 'iv']);
        expect(legacyDecrypt(KEY, e)).toBe('v');
    });

    it('bound entries round-trip under their own name', () => {
        const e = encryptEntry(KEY, 'channel_key:A:1', 'kA', true);
        expect(e.a).toBe(1);
        expect(decryptEntry(KEY, 'channel_key:A:1', e)).toBe('kA');
    });

    it('a bound entry moved to another name fails to decrypt', () => {
        const e = encryptEntry(KEY, 'channel_key:A:1', 'kA', true);
        expect(() => decryptEntry(KEY, 'channel_key:B:1', e)).toThrow();
    });

    it('negative control: a LEGACY entry moved to another name still decrypts (the gap binding closes)', () => {
        const e = legacyEncrypt(KEY, 'kA');
        expect(decryptEntry(KEY, 'channel_key:B:1', e)).toBe('kA');
    });

    it('stripping the bound marker does not downgrade a bound entry into an openable legacy one', () => {
        const e = encryptEntry(KEY, 'n', 'v', true);
        const { a: _a, ...stripped } = e;
        expect(() => decryptEntry(KEY, 'other', stripped)).toThrow();
        expect(() => decryptEntry(KEY, 'n', stripped)).toThrow();
    });

    it('why the write switch is off: an older build cannot read a bound entry', () => {
        const e = encryptEntry(KEY, 'identity_priv', 'secret', true);
        expect(() => legacyDecrypt(KEY, e)).toThrow();
    });

    it('migrateEntriesToBound re-seals legacy entries, keeps values, leaves bad entries untouched', () => {
        const bad: EncryptedEntry = { ...legacyEncrypt(Buffer.alloc(32, 9), 'other-key') };
        const alreadyBound = encryptEntry(KEY, 'c', 'vc', true);
        const data: Record<string, EncryptedEntry> = {
            a: legacyEncrypt(KEY, 'va'),
            b: legacyEncrypt(KEY, 'vb'),
            c: alreadyBound,
            broken: bad,
        };
        expect(migrateEntriesToBound(KEY, data)).toBe(2);
        expect(isBoundEntry(data.a) && isBoundEntry(data.b)).toBe(true);
        expect(decryptEntry(KEY, 'a', data.a)).toBe('va');
        expect(decryptEntry(KEY, 'b', data.b)).toBe('vb');
        expect(data.c).toBe(alreadyBound);   // not rewritten
        expect(data.broken).toBe(bad);       // never dropped or replaced
        expect(migrateEntriesToBound(KEY, data)).toBe(0); // idempotent
    });
});

describe('KvCrypto records', () => {
    const src = { status: () => 'ok' as const, keyBytes: () => KEY };
    const legacy = new KvCrypto(src, { writeBound: false });
    const bound = new KvCrypto(src, { writeBound: true });
    const seal1 = (kv: KvCrypto, k: string, o: string | null, v: string) => kv.seal([{ k, o, v }])[0].b!;

    it('default construction writes the legacy tag (phase 1: no on-disk change)', () => {
        expect(seal1(new KvCrypto(src), 'k', null, 'v')[0]).toBe(TAG_WRAPPED);
    });

    it('bound writes use the bound tag and round-trip under the same owner+key', () => {
        const b = seal1(bound, 'cipherline_token', 'user-1', 'tok');
        expect(b[0]).toBe(TAG_WRAPPED_BOUND);
        expect(bound.open([{ k: 'cipherline_token', o: 'user-1', b }])[0].v).toBe('tok');
    });

    it('a phase-1 reader (writeBound off) reads phase-2 records', () => {
        const b = seal1(bound, 'k', null, 'v');
        expect(legacy.open([{ k: 'k', o: null, b }])[0]).toEqual({ k: 'k', v: 'v' });
    });

    it('a bound record opened under another key or owner is unreadable (soft null)', () => {
        const b = seal1(bound, 'cipherline_token', 'user-1', 'tok');
        expect(bound.open([{ k: 'refresh_token', o: 'user-1', b }])[0].v).toBeNull();
        expect(bound.open([{ k: 'cipherline_token', o: null, b }])[0].v).toBeNull();
    });

    it('negative control: a legacy record opened under another key still decrypts', () => {
        const b = seal1(legacy, 'cipherline_token', null, 'tok');
        expect(legacy.open([{ k: 'refresh_token', o: null, b }])[0].v).toBe('tok');
    });

    it('relabelling a bound record as legacy does not make it openable', () => {
        const b = Uint8Array.from(seal1(bound, 'k', null, 'v'));
        b[0] = TAG_WRAPPED;
        expect(bound.open([{ k: 'k', o: null, b }])[0].v).toBeNull();
    });

    it('flags legacy records for migration only when bound writes are on', () => {
        const b = seal1(legacy, 'k', null, 'v');
        expect(bound.open([{ k: 'k', o: null, b }])[0]).toEqual({ k: 'k', v: 'v', m: true });
        expect(legacy.open([{ k: 'k', o: null, b }])[0]).toEqual({ k: 'k', v: 'v' });
        // Bound records are never flagged.
        expect(bound.open([{ k: 'k', o: null, b: seal1(bound, 'k', null, 'v') }])[0].m).toBeUndefined();
        // A raw record is unauthenticated: refused while a key exists unless
        // a migration boot is wired (kv-crypto.test.ts covers that window).
        const raw = Uint8Array.from([TAG_RAW, ...Buffer.from('v')]);
        expect(bound.open([{ k: 'k', o: null, b: raw }])[0]).toEqual({ k: 'k', v: null });
    });
});

describe('wiring', () => {
    const storage = readFileSync(join(__dirname, 'storage.ts'), 'utf8');
    it('SecureStore reads and writes through record-binding with the entry name', () => {
        expect(storage).toMatch(/encryptEntry\(this\.masterKey, key, plaintext, WRITE_BOUND_RECORDS\)/);
        expect(storage).toMatch(/decryptEntry\(this\.masterKey, key, entry\)/);
        expect(storage).not.toMatch(/createDecipheriv/);
    });
    it('recoverWithKey validates a candidate key with the format-aware decrypt (a bound probe must not read as "wrong key")', () => {
        const body = storage.slice(storage.indexOf('recoverWithKey(keyB64'), storage.indexOf('recoverWithKey(keyB64') + 1200);
        expect(body).toMatch(/decryptEntry\(key, probeName, this\.data\[probeName\]\)/);
    });
    it('the migration only runs behind the switch', () => {
        expect(storage).toMatch(/if \(!WRITE_BOUND_RECORDS \|\| !this\.masterKey \|\| this\._status !== 'ok'\) return;/);
    });
});
