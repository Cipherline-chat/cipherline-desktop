/**
 * The load-bearing half of these tests is WIRE COMPATIBILITY.
 *
 * `kv-crypto` took over encryption of the renderer's key/value store from
 * `src/utils/localMasterKey.ts`, which did the same job in WebCrypto. Every
 * record already on every installed client was written by that WebCrypto code.
 * If Node's HKDF or GCM framing differs from WebCrypto's by a single byte,
 * those records stop decrypting — and a user whose store will not open sees an
 * app that has forgotten their account, which is indistinguishable from losing
 * all their data and is a far worse outcome than the key exposure this change
 * was made to fix.
 *
 * So the compatibility tests below deliberately do NOT re-implement the old
 * format's assumptions. They run the REAL WebCrypto primitives (available on
 * `globalThis.crypto` under vitest's node environment — the same ones the
 * renderer used) and assert that main's output is interchangeable in both
 * directions.
 */

import { describe, it, expect } from 'vitest';
import {
    KvCrypto,
    BLOB_CACHE_INFO,
    deriveSubkey,
    IV_LEN,
    GCM_TAG_LEN,
    TAG_RAW,
    TAG_WRAPPED,
    USER_VAULT_INFO_PREFIX,
    type MasterKeySource,
    type KvKeyStatus,
} from './kv-crypto';

const MASTER = Buffer.alloc(32, 7);
const MASTER_ALT = Buffer.alloc(32, 9);
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

/** A MasterKeySource whose key and status the test can move underneath KvCrypto. */
function source(initial: Buffer | null = MASTER, status: KvKeyStatus = 'ok') {
    let key = initial;
    let st = status;
    const src: MasterKeySource & { set(k: Buffer | null, s?: KvKeyStatus): void } = {
        status: () => st,
        keyBytes: () => key,
        set(k, s = 'ok') { key = k; st = s; },
    };
    return src;
}

/** The exact WebCrypto derivation `deriveUserSubkey` used before this module. */
async function webcryptoSubkeyBits(master: Buffer, info: string): Promise<Buffer> {
    const base = await globalThis.crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
    const bits = await globalThis.crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
        base,
        256,
    );
    return Buffer.from(new Uint8Array(bits));
}

/** Build a record byte-for-byte the way the renderer's old `wrapBlob` did. */
async function webcryptoWrap(master: Buffer, info: string | null, value: string): Promise<Uint8Array> {
    const raw = info === null ? master : await webcryptoSubkeyBits(master, info);
    const key = await globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = new Uint8Array(
        await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)),
    );
    const out = new Uint8Array(1 + IV_LEN + ct.length);
    out[0] = TAG_WRAPPED;
    out.set(iv, 1);
    out.set(ct, 1 + IV_LEN);
    return out;
}

/** Read a record with WebCrypto, the way the renderer's old `unwrapBlob` did. */
async function webcryptoUnwrap(master: Buffer, info: string | null, stored: Uint8Array): Promise<string> {
    expect(stored[0]).toBe(TAG_WRAPPED);
    const raw = info === null ? master : await webcryptoSubkeyBits(master, info);
    const key = await globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const iv = stored.subarray(1, 1 + IV_LEN);
    const body = stored.subarray(1 + IV_LEN);
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
    return new TextDecoder().decode(pt);
}

describe('kv-crypto — wire compatibility with the renderer WebCrypto format', () => {
    // GOLDEN VECTORS. These hex strings were produced by the ORIGINAL renderer
    // WebCrypto derivation, against MASTER (32 bytes of 0x07) and USER_A.
    //
    // They are literals on purpose. The obvious version of the test below
    // derives both sides from `USER_VAULT_INFO_PREFIX`, which makes it vacuous
    // with respect to the one value that matters most: change the constant and
    // both sides move together, so the test stays green while every existing
    // per-account record on every installed client is orphaned. That exact
    // failure was demonstrated before these vectors were added — renaming the
    // prefix broke nothing in the suite. Anything that alters the salt, the
    // info string, the hash or the output length must fail here.
    const GOLDEN_USER_A_SUBKEY = '70586196074892cf88bb6ea9f2eae2a2f0e9368c163914ddaec29b289e1b3b55';
    const GOLDEN_BLOB_CACHE_KEY = '5caa80881ff909d7e468600003755e7499cb428fa87ae1c906541a25334712bf';

    it('pins the HKDF info strings themselves — renaming one orphans every record', () => {
        expect(USER_VAULT_INFO_PREFIX).toBe('cl-user-vault:');
        expect(BLOB_CACHE_INFO).toBe('cl-blob-cache');
    });

    it('derives the golden per-account subkey byte-for-byte', () => {
        expect(deriveSubkey(MASTER, `cl-user-vault:${USER_A}`).toString('hex'))
            .toBe(GOLDEN_USER_A_SUBKEY);
    });

    it('derives the golden blob-cache key byte-for-byte', () => {
        const kv = new KvCrypto(source());
        expect(kv.deriveBlobCacheKey()!.toString('hex')).toBe(GOLDEN_BLOB_CACHE_KEY);
    });

    it('derives per-account subkeys identically to WebCrypto HKDF with an empty salt', async () => {
        // Node's hkdfSync(..., Buffer.alloc(0), ...) and WebCrypto's
        // salt: new Uint8Array(0) agree only because HMAC pads a zero-length
        // key and a 32-zero-byte salt to the same all-zero block. That is an
        // implementation-level coincidence worth pinning rather than assuming.
        // Spelled out rather than built from the constant, for the reason above.
        const info = `cl-user-vault:${USER_A}`;
        expect(deriveSubkey(MASTER, info)).toEqual(await webcryptoSubkeyBits(MASTER, info));
        // And the golden vector agrees with live WebCrypto, so the literal
        // above is pinned to the real format rather than to a past mistake.
        expect((await webcryptoSubkeyBits(MASTER, info)).toString('hex')).toBe(GOLDEN_USER_A_SUBKEY);
    });

    it('derives a DIFFERENT subkey per account (per-account isolation at rest)', () => {
        const a = deriveSubkey(MASTER, `${USER_VAULT_INFO_PREFIX}${USER_A}`);
        const b = deriveSubkey(MASTER, `${USER_VAULT_INFO_PREFIX}${USER_B}`);
        expect(a).not.toEqual(b);
        expect(a).not.toEqual(MASTER);
    });

    it('reads master-tier records written by the old WebCrypto path', async () => {
        const kv = new KvCrypto(source());
        const stored = await webcryptoWrap(MASTER, null, 'bootstrap-pointer');
        expect(kv.open([{ k: 'cipherline_user_id', o: null, b: stored }])).toEqual([
            { k: 'cipherline_user_id', v: 'bootstrap-pointer' },
        ]);
    });

    it('reads per-account records written by the old WebCrypto path', async () => {
        const kv = new KvCrypto(source());
        const stored = await webcryptoWrap(MASTER, `cl-user-vault:${USER_A}`, 'history for A');
        expect(kv.open([{ k: `cipherline_msgs_${USER_A}`, o: USER_A, b: stored }])).toEqual([
            { k: `cipherline_msgs_${USER_A}`, v: 'history for A' },
        ]);
    });

    it('writes records the old WebCrypto path can still read (rollback safety)', async () => {
        // If this change is ever reverted, the records main wrote in the
        // meantime must still open under the renderer's reader.
        const kv = new KvCrypto(source());
        const [sealed] = kv.seal([{ k: 'k', o: USER_A, v: 'written by main' }]);
        expect(sealed.b).not.toBeNull();
        await expect(webcryptoUnwrap(MASTER, `cl-user-vault:${USER_A}`, sealed.b!))
            .resolves.toBe('written by main');
    });

    it('emits the documented [tag][iv][ct||gcmTag] layout', () => {
        const kv = new KvCrypto(source());
        const [sealed] = kv.seal([{ k: 'k', o: null, v: 'abc' }]);
        expect(sealed.b![0]).toBe(TAG_WRAPPED);
        // 3 plaintext bytes + the 16-byte GCM tag appended after the ciphertext.
        expect(sealed.b!.length).toBe(1 + IV_LEN + 3 + GCM_TAG_LEN);
    });

    it('uses a fresh IV per record (never reuses an IV under one key)', () => {
        const kv = new KvCrypto(source());
        const out = kv.seal([
            { k: 'a', o: null, v: 'same value' },
            { k: 'b', o: null, v: 'same value' },
        ]);
        const ivA = Buffer.from(out[0].b!.subarray(1, 1 + IV_LEN));
        const ivB = Buffer.from(out[1].b!.subarray(1, 1 + IV_LEN));
        expect(ivA).not.toEqual(ivB);
        // Identical plaintext under an identical key must not yield identical
        // ciphertext — GCM IV reuse is a total break of confidentiality.
        expect(Buffer.from(out[0].b!)).not.toEqual(Buffer.from(out[1].b!));
    });
});

describe('kv-crypto — failure handling', () => {
    it('fails SOFT per record so one bad record cannot break hydrate', () => {
        const kv = new KvCrypto(source());
        const good = kv.seal([{ k: 'good', o: null, v: 'fine' }])[0].b!;
        const corrupt = Uint8Array.from(good);
        corrupt[corrupt.length - 1] ^= 0xff; // break the GCM tag

        const opened = kv.open([
            { k: 'good', o: null, b: good },
            { k: 'corrupt', o: null, b: corrupt },
            { k: 'empty', o: null, b: new Uint8Array(0) },
            { k: 'badtag', o: null, b: Uint8Array.from([0x7f, 1, 2, 3]) },
            { k: 'truncated', o: null, b: Uint8Array.from([TAG_WRAPPED, 1, 2]) },
        ]);
        expect(opened).toEqual([
            { k: 'good', v: 'fine' },
            { k: 'corrupt', v: null },
            { k: 'empty', v: null },
            { k: 'badtag', v: null },
            { k: 'truncated', v: null },
        ]);
    });

    it('rejects a record decrypted under the WRONG account subkey', () => {
        const kv = new KvCrypto(source());
        const forA = kv.seal([{ k: 'k', o: USER_A, v: 'A only' }])[0].b!;
        expect(kv.open([{ k: 'k', o: USER_B, b: forA }])).toEqual([{ k: 'k', v: null }]);
    });

    it('refuses to encrypt anything while the store is LOCKED', () => {
        // The one unrecoverable mistake available here is overwriting preserved
        // ciphertext, so seal() must produce nothing at all in this state.
        const src = source(null, 'locked');
        const kv = new KvCrypto(src);
        expect(kv.seal([{ k: 'a', o: null, v: 'x' }, { k: 'b', o: USER_A, v: 'y' }])).toEqual([
            { k: 'a', b: null },
            { k: 'b', b: null },
        ]);
    });

    it('cannot read wrapped records while LOCKED, and does not throw doing so', () => {
        const kv = new KvCrypto(source());
        const sealed = kv.seal([{ k: 'k', o: null, v: 'v' }])[0].b!;
        const locked = new KvCrypto(source(null, 'locked'));
        expect(locked.open([{ k: 'k', o: null, b: sealed }])).toEqual([{ k: 'k', v: null }]);
    });
});

describe('kv-crypto — no-keystore (TAG_RAW) fallback', () => {
    it('round-trips TAG_RAW records when no key is available', () => {
        // Platforms with no OS keystore kept working, unencrypted, before this
        // module; that behaviour is preserved rather than turned into a lockout.
        const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => null });
        const [sealed] = kv.seal([{ k: 'k', o: null, v: 'plain' }]);
        expect(sealed.b![0]).toBe(TAG_RAW);
        expect(kv.open([{ k: 'k', o: null, b: sealed.b! }])).toEqual([{ k: 'k', v: 'plain' }]);
    });

    it('reads a TAG_RAW record even when a key IS available (mixed store)', () => {
        const kv = new KvCrypto(source());
        const raw = new Uint8Array([TAG_RAW, ...Buffer.from('legacy', 'utf8')]);
        expect(kv.open([{ k: 'k', o: null, b: raw }])).toEqual([{ k: 'k', v: 'legacy' }]);
    });
});

describe('kv-crypto — subkey cache invalidation', () => {
    it('re-derives subkeys after the master key is replaced', () => {
        // recover-with-key and factory-reset swap the master key under a live
        // KvCrypto. A cache keyed only by userId would keep serving subkeys
        // derived from the retired key, and every later read AND write would
        // fail — silently, and only for per-account records.
        const src = source();
        const kv = new KvCrypto(src);
        const sealedUnderOld = kv.seal([{ k: 'k', o: USER_A, v: 'old era' }])[0].b!;
        expect(kv.open([{ k: 'k', o: USER_A, b: sealedUnderOld }])).toEqual([{ k: 'k', v: 'old era' }]);

        src.set(MASTER_ALT);
        // Old ciphertext is correctly unreadable under the new master key...
        expect(kv.open([{ k: 'k', o: USER_A, b: sealedUnderOld }])).toEqual([{ k: 'k', v: null }]);
        // ...and new writes round-trip under the NEW subkey, not a stale cached one.
        const sealedUnderNew = kv.seal([{ k: 'k', o: USER_A, v: 'new era' }])[0].b!;
        expect(kv.open([{ k: 'k', o: USER_A, b: sealedUnderNew }])).toEqual([{ k: 'k', v: 'new era' }]);
        expect(deriveSubkey(MASTER_ALT, `${USER_VAULT_INFO_PREFIX}${USER_A}`))
            .not.toEqual(deriveSubkey(MASTER, `${USER_VAULT_INFO_PREFIX}${USER_A}`));
    });

    it('resetSubkeyCache() does not change derived output', () => {
        const kv = new KvCrypto(source());
        const before = kv.seal([{ k: 'k', o: USER_A, v: 'v' }])[0].b!;
        kv.resetSubkeyCache();
        expect(kv.open([{ k: 'k', o: USER_A, b: before }])).toEqual([{ k: 'k', v: 'v' }]);
    });
});

describe('kv-crypto — blob-cache subkey', () => {
    it('is NOT the master key and cannot open key/value records', () => {
        // This is the one key still handed to the renderer. Its whole
        // justification is that it opens the blob cache and nothing else.
        const kv = new KvCrypto(source());
        const blobKey = kv.deriveBlobCacheKey()!;
        expect(blobKey).not.toEqual(MASTER);

        const kvRecord = kv.seal([{ k: 'k', o: null, v: 'secret' }])[0].b!;
        // Treat the blob key as if it were the master key: a renderer holding
        // it must not be able to read the key/value store with it.
        const attacker = new KvCrypto({ status: () => 'ok', keyBytes: () => blobKey });
        expect(attacker.open([{ k: 'k', o: null, b: kvRecord }])).toEqual([{ k: 'k', v: null }]);
    });

    it('cannot be walked back to a per-account subkey either', () => {
        const kv = new KvCrypto(source());
        const blobKey = kv.deriveBlobCacheKey()!;
        const perAccount = kv.seal([{ k: 'k', o: USER_A, v: 'A secret' }])[0].b!;
        const attacker = new KvCrypto({ status: () => 'ok', keyBytes: () => blobKey });
        expect(attacker.open([{ k: 'k', o: USER_A, b: perAccount }])).toEqual([{ k: 'k', v: null }]);
        expect(attacker.open([{ k: 'k', o: null, b: perAccount }])).toEqual([{ k: 'k', v: null }]);
    });

    it('is stable across calls and null while locked', () => {
        const src = source();
        const kv = new KvCrypto(src);
        expect(kv.deriveBlobCacheKey()).toEqual(kv.deriveBlobCacheKey());
        src.set(null, 'locked');
        expect(kv.deriveBlobCacheKey()).toBeNull();
    });
});
