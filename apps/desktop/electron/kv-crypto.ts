/**
 * kv-crypto — the main-process half of `secureLocalStore`'s at-rest encryption.
 *
 * WHAT MOVED AND WHY
 * `secure:get-local-master-key-ex` used to hand the renderer the raw device
 * master key so the renderer could do this crypto itself. That key is the root
 * of everything this device stores at rest: the Signal identity private key,
 * every prekey, channel and avatar key, the Drive OAuth tokens, every record in
 * the encrypted key/value store, and every backup container the device has ever
 * written. It does not rotate and it does not expire, so a single copy is good
 * against the whole vault, offline, forever. This module exists so those bytes
 * never cross the context bridge: the renderer sends ciphertext up and gets
 * plaintext back (and vice versa), and the key stays in main.
 *
 * BE PRECISE ABOUT WHAT THIS BUYS — AND WHAT IT DOES NOT
 * A compromised renderer still sees plaintext VALUES. It must: it renders them.
 * It can also ask this module to decrypt every record on disk, one call at a
 * time, for as long as it is running. So this is NOT confidentiality of the
 * store's contents from renderer-resident attacker code, and nothing here
 * should be described that way.
 *
 * What it removes is the PERSISTENT, OFFLINE capability. Before, a single
 * `invoke()` yielded 32 bytes that an attacker could exfiltrate once and then
 * use forever, on any machine, against the whole vault AND against every
 * backup the user has ever written to disk or Drive — long after the malware
 * was removed and with no further access to the device. After, an attacker's
 * reach is bounded by the lifetime of their code inside a running renderer, is
 * limited to records this store actually holds (no Signal identity key, no
 * backup containers), and leaves the backups unreadable. That reduction in
 * blast radius and in duration is the whole point of the change; it is worth
 * doing on its own terms even though it is not confidentiality.
 *
 * PER-ACCOUNT ISOLATION IS AN AT-REST PROPERTY, NOT A RENDERER SANDBOX
 * A record's owner (`o`) selects the key: null means the device master key,
 * otherwise HKDF(master, "cl-user-vault:<userId>"). Main derives from whatever
 * owner the caller names, so renderer code can ask for any account's records.
 * That is not a regression — the renderer previously held the master key and
 * could derive any subkey itself — and it is not what the tiering defends
 * against. HKDF tiering protects account A's data from a *different OS user*
 * or an offline attacker who has account B's subkey, which is the threat it
 * was written for. Gating main on "which account is signed in" would need main
 * to track session state it does not own, and getting that wrong fails hydrate
 * and lands boot on StorageLockedScreen, which users read as data loss.
 *
 * WIRE COMPATIBILITY IS LOAD-BEARING
 * The record layout is byte-identical to the renderer's previous `wrapBlob`
 * output — `[1-byte tag][12-byte IV][AES-256-GCM ciphertext || 16-byte tag]` —
 * and the key derivation is byte-identical to the renderer's WebCrypto HKDF.
 * Node's `hkdfSync(..., Buffer.alloc(0), ...)` and WebCrypto's HKDF with
 * `salt: new Uint8Array(0)` agree because HMAC pads a zero-length key and a
 * 32-zero-byte salt to the same all-zero block; WebCrypto appends the GCM auth
 * tag to the ciphertext where Node exposes it separately, so we concatenate.
 * Both facts are asserted in kv-crypto.test.ts against real WebCrypto rather
 * than assumed — if either drifts, every existing per-account record on every
 * installed client becomes undecryptable, which presents to the user as total
 * data loss. Do not "simplify" the salt, the info string, or the tag handling.
 *
 * No `electron` import, so the decision and crypto logic is unit-testable and
 * the renderer-facing tests can drive the REAL main-side code path rather than
 * a mock of it. main.ts injects the live keystore.
 */

import * as crypto from 'node:crypto';

/** AES-GCM IV length, in bytes. Must match the renderer's record reader. */
export const IV_LEN = 12;
/** AES-GCM authentication tag length, in bytes. */
export const GCM_TAG_LEN = 16;
/** Record tag byte: payload is AES-256-GCM wrapped under a key from this module. */
export const TAG_WRAPPED = 0x01;
/** Record tag byte: payload is stored as-is (no OS keystore on this platform). */
export const TAG_RAW = 0x00;

/**
 * HKDF `info` prefix for per-account subkeys. Byte-identical to the string the
 * renderer's `deriveUserSubkey` used, so records written before this module
 * existed still decrypt. Changing it orphans every per-account record.
 */
export const USER_VAULT_INFO_PREFIX = 'cl-user-vault:';

/**
 * HKDF `info` for the renderer's blob-cache key (attachment ciphertext and
 * decrypted avatar blobs). See `deriveBlobCacheKey` for why that one key is
 * still handed over.
 */
export const BLOB_CACHE_INFO = 'cl-blob-cache';

/** Resolution state of the device master key, as main sees it. */
export type KvKeyStatus = 'ok' | 'locked';

/** A stored record on its way IN to be decrypted. */
export interface KvCipherRecord {
    /** Store key, echoed back so callers can correlate without relying on order. */
    k: string;
    /** Owner userId, or null for master-tier. Selects the key. */
    o: string | null;
    /** `[tag][iv][ciphertext||gcmTag]` bytes. */
    b: Uint8Array;
}

/** A value on its way OUT to be encrypted. */
export interface KvPlainRecord {
    k: string;
    o: string | null;
    v: string;
}

/** Encrypted result for one key; `b` is null when encryption failed. */
export interface KvSealedRecord {
    k: string;
    b: Uint8Array | null;
}

/** Decrypted result for one key; `v` is null when the record was unreadable. */
export interface KvOpenedRecord {
    k: string;
    v: string | null;
}

/**
 * How main gets at the device master key. Injected so this module never
 * imports electron and tests can drive it with a fixed key.
 */
export interface MasterKeySource {
    /** 'locked' when a key file exists but could not be unwrapped. */
    status(): KvKeyStatus;
    /** Raw 32-byte master key, or null when status() is not 'ok'. */
    keyBytes(): Buffer | null;
}

/**
 * Stateless-per-call crypto over the device master key, with a small subkey
 * cache so a hydrate of N per-account records runs one HKDF, not N.
 */
export class KvCrypto {
    private subkeys = new Map<string, Buffer>();
    /**
     * The master key the cached subkeys were derived from. A factory reset or a
     * recovery re-key swaps the master key underneath us while this object
     * lives; without this check the cache would keep serving subkeys derived
     * from the retired key and every subsequent read and write would fail.
     */
    private subkeyEpoch: string | null = null;

    // An explicit field rather than a constructor parameter property: this
    // module is reached by `tsconfig.app.json`, which sets `erasableSyntaxOnly`
    // and rejects that shorthand. Keeping it plain is what lets the renderer's
    // own test suite drive the REAL main-side crypto instead of a mock of it.
    private readonly source: MasterKeySource;

    constructor(source: MasterKeySource) {
        this.source = source;
    }

    /** Current master-key state. Callers must not encrypt while 'locked'. */
    status(): KvKeyStatus {
        return this.source.status();
    }

    /**
     * Forget cached subkeys. Called when the master key is replaced
     * (recover-with-key / factory reset) so nothing stale survives.
     */
    resetSubkeyCache(): void {
        this.subkeys.clear();
        this.subkeyEpoch = null;
    }

    /**
     * Resolve the key a record with this owner is encrypted under.
     * Returns null when the store is locked or uninitialized.
     */
    private keyFor(owner: string | null): Buffer | null {
        const master = this.source.keyBytes();
        if (!master || this.source.status() !== 'ok') return null;
        if (owner === null) return master;

        // Fingerprint rather than the key itself so the epoch marker is not a
        // second copy of the master key sitting in a field.
        const epoch = crypto.createHash('sha256').update(master).digest('base64');
        if (this.subkeyEpoch !== epoch) {
            this.subkeys.clear();
            this.subkeyEpoch = epoch;
        }

        const cached = this.subkeys.get(owner);
        if (cached) return cached;
        const sub = deriveSubkey(master, `${USER_VAULT_INFO_PREFIX}${owner}`);
        this.subkeys.set(owner, sub);
        return sub;
    }

    /**
     * Decrypt a batch of stored records.
     *
     * Fails SOFT per record: an unreadable record yields `v: null` rather than
     * throwing, matching the renderer's previous `tryDecrypt` contract. One
     * corrupt record must not take down hydrate for the whole store, because
     * a failed hydrate is indistinguishable from data loss to the user.
     */
    open(records: readonly KvCipherRecord[]): KvOpenedRecord[] {
        return records.map(rec => {
            try {
                const plain = this.unwrap(rec.b, this.keyFor(rec.o));
                return { k: rec.k, v: plain };
            } catch (e) {
                console.warn('[kv-crypto] record decrypt failed — skipping', rec.k, e);
                return { k: rec.k, v: null };
            }
        });
    }

    /**
     * Encrypt a batch of values for storage.
     *
     * Refuses outright when the store is locked: overwriting preserved
     * ciphertext with anything is the one unrecoverable mistake available here.
     * Per-record failures yield `b: null` so the caller can re-queue that key
     * instead of silently dropping the write.
     */
    seal(records: readonly KvPlainRecord[]): KvSealedRecord[] {
        if (this.status() === 'locked') {
            return records.map(r => ({ k: r.k, b: null }));
        }
        return records.map(rec => {
            try {
                return { k: rec.k, b: this.wrap(rec.v, this.keyFor(rec.o)) };
            } catch (e) {
                console.error('[kv-crypto] record encrypt failed', rec.k, e);
                return { k: rec.k, b: null };
            }
        });
    }

    /**
     * `[tag][iv][ct||gcmTag]`, or a TAG_RAW record when no key is available.
     * The TAG_RAW fallback preserves the pre-existing behaviour on platforms
     * with no OS keystore: the app keeps working, without the at-rest layer.
     */
    private wrap(value: string, key: Buffer | null): Uint8Array {
        const plaintext = Buffer.from(value, 'utf8');
        if (!key) {
            const out = Buffer.allocUnsafe(1 + plaintext.length);
            out[0] = TAG_RAW;
            plaintext.copy(out, 1);
            return new Uint8Array(out);
        }
        const iv = crypto.randomBytes(IV_LEN);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        // WebCrypto's AES-GCM output is ciphertext||tag; Node hands the tag back
        // separately, so append it to keep the two formats interchangeable.
        const gcmTag = cipher.getAuthTag();
        const out = Buffer.allocUnsafe(1 + IV_LEN + ct.length + gcmTag.length);
        out[0] = TAG_WRAPPED;
        iv.copy(out, 1);
        ct.copy(out, 1 + IV_LEN);
        gcmTag.copy(out, 1 + IV_LEN + ct.length);
        return new Uint8Array(out);
    }

    /** Reverse of {@link wrap}. Reads both tags, so a store written across a
     *  keystore-availability change still reads back. */
    private unwrap(stored: Uint8Array, key: Buffer | null): string {
        const buf = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
        if (buf.length === 0) throw new Error('empty record');
        const tag = buf[0];
        if (tag === TAG_RAW) return buf.subarray(1).toString('utf8');
        if (tag !== TAG_WRAPPED) throw new Error(`unknown record tag 0x${tag.toString(16)}`);
        if (!key) throw new Error('record is wrapped but no master key is available');
        if (buf.length < 1 + IV_LEN + GCM_TAG_LEN) throw new Error('wrapped record is truncated');
        const iv = buf.subarray(1, 1 + IV_LEN);
        const ct = buf.subarray(1 + IV_LEN, buf.length - GCM_TAG_LEN);
        const gcmTag = buf.subarray(buf.length - GCM_TAG_LEN);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(gcmTag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    }

    /**
     * The one key still handed to the renderer, and deliberately NOT the
     * master key: HKDF(master, "cl-blob-cache").
     *
     * `src/utils/attachmentCache.ts` wraps whole blobs — attachment ciphertext
     * up to the 2 GiB paid cap, plus decrypted avatar images. Routing those
     * through IPC copies every byte across the bridge twice, so the crypto
     * stays in the renderer and the KEY is scoped instead. HKDF is one-way:
     * this subkey cannot be walked back to the master key, and it opens
     * nothing but the blob cache — not the key/value store, not the Signal
     * identity, and not a single backup container. An attacker who lifts it
     * gets a cache of data they could already read in the running renderer,
     * and gets no offline reach beyond it.
     *
     * Returns null when the store is locked, so the renderer degrades to a
     * cold cache rather than writing over preserved ciphertext.
     */
    deriveBlobCacheKey(): Buffer | null {
        const master = this.source.keyBytes();
        if (!master || this.source.status() !== 'ok') return null;
        return deriveSubkey(master, BLOB_CACHE_INFO);
    }
}

/**
 * HKDF-SHA256 to 32 bytes with an EMPTY salt, matching WebCrypto's
 * `deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info })`.
 * Exported so the compatibility test can pin it against real WebCrypto.
 */
export function deriveSubkey(master: Buffer, info: string): Buffer {
    return Buffer.from(
        crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32),
    );
}
