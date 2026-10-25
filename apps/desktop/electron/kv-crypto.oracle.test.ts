/**
 * E-2 (carry-forward 21/H-1): `securekv:open` must not decrypt SecureStore
 * entries.
 *
 * SecureStore seals `secure-store.json` entries as `{iv, authTag, ciphertext}`
 * AES-256-GCM under the device master key, with no AAD while
 * WRITE_BOUND_RECORDS is off — byte-for-byte the shape of a master-tier
 * (`o === null`) legacy key/value record. A renderer that got hold of the
 * vault file could rebuild an entry as `[0x01][iv][ct||tag]` and have main
 * decrypt the Signal identity key for it. This is the audit PoC, kept as a
 * regression test against the REAL KvCrypto and the REAL SecureStore entry
 * encoder.
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KvCrypto, TAG_WRAPPED, TAG_WRAPPED_BOUND } from './kv-crypto';
import { encryptEntry, type EncryptedEntry } from './record-binding';

const master = crypto.randomBytes(32);
const src = { status: () => 'ok' as const, keyBytes: () => master };

/** What a renderer would submit after reading secure-store.json. */
function asKvRecord(e: EncryptedEntry, tag = TAG_WRAPPED): Uint8Array {
    return new Uint8Array(Buffer.concat([
        Buffer.from([tag]), Buffer.from(e.iv, 'base64'), Buffer.from(e.ciphertext, 'base64'), Buffer.from(e.authTag, 'base64'),
    ]));
}

function vault(): Record<string, EncryptedEntry> {
    return {
        identity_priv: encryptEntry(master, 'identity_priv', 'TOP-SECRET-IDENTITY-KEY', false),
        'channel_keys:abc:1': encryptEntry(master, 'channel_keys:abc:1', 'CHANNEL-KEY', false),
        gdrive_refresh_token: encryptEntry(master, 'gdrive_refresh_token', 'DRIVE-TOKEN', false),
    };
}
const ivsOf = (v: Record<string, EncryptedEntry>) => new Set(Object.values(v).map(e => e.iv));

describe('securekv oracle (E-2)', () => {
    it('baseline: WITHOUT the guard, KvCrypto opens a SecureStore entry (the audited bug)', () => {
        const v = vault();
        const kv = new KvCrypto(src);
        expect(kv.open([{ k: 'anything', o: null, b: asKvRecord(v.identity_priv) }])[0].v).toBe('TOP-SECRET-IDENTITY-KEY');
    });

    it('with the guard, every SecureStore entry is refused, whatever name or tag the caller claims', () => {
        const v = vault();
        const kv = new KvCrypto(src, { reservedIvs: () => ivsOf(v) });
        const recs = Object.values(v).flatMap(e => [
            { k: 'cipherline_user_id', o: null, b: asKvRecord(e) },
            { k: 'identity_priv', o: null, b: asKvRecord(e) },
            { k: 'x', o: null, b: asKvRecord(e, TAG_WRAPPED_BOUND) },
            { k: 'x', o: '11111111-1111-4111-8111-111111111111', b: asKvRecord(e) },
        ]);
        for (const r of kv.open(recs)) expect(r.v).toBeNull();
    });

    it('positive control: genuine KV records (both tiers) still open with the guard on', () => {
        const v = vault();
        const kv = new KvCrypto(src, { reservedIvs: () => ivsOf(v) });
        const sealed = kv.seal([
            { k: 'cipherline_user_id', o: null, v: 'u-1' },
            { k: 'cipherline_msgs_u-1', o: 'u-1', v: '[1,2]' },
        ]);
        const opened = kv.open([
            { k: 'cipherline_user_id', o: null, b: sealed[0].b! },
            { k: 'cipherline_msgs_u-1', o: 'u-1', b: sealed[1].b! },
        ]);
        expect(opened.map(r => r.v)).toEqual(['u-1', '[1,2]']);
    });

    it('the reserved set is read lazily, once per batch', () => {
        let calls = 0;
        const kv = new KvCrypto(src, { reservedIvs: () => { calls++; return new Set(); } });
        const sealed = kv.seal([{ k: 'a', o: null, v: '1' }, { k: 'b', o: null, v: '2' }]);
        kv.open(sealed.map(s => ({ k: s.k, o: null, b: s.b! })));
        expect(calls).toBe(1);
        kv.open([]);
        expect(calls).toBe(1);
    });

    it('main.ts wires SecureStore entry IVs into the KvCrypto behind securekv:open', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        const i = main.indexOf('const kvCrypto = new KvCrypto(');
        expect(i).toBeGreaterThan(-1);
        expect(main.slice(i, i + 600)).toContain('reservedIvs: () => secureStore.entryIvs()');
        const storage = fs.readFileSync(path.join(__dirname, 'storage.ts'), 'utf8');
        expect(storage).toMatch(/entryIvs\(\): Set<string>/);
    });
});
