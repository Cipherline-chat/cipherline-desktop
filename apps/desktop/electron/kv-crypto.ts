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
import { kvRecordAad, WRITE_BOUND_RECORDS } from './record-binding';

/** AES-GCM IV length, in bytes. Must match the renderer's record reader. */
export const IV_LEN = 12;
/** AES-GCM authentication tag length, in bytes. */
export const GCM_TAG_LEN = 16;
/** Record tag byte: payload is AES-256-GCM wrapped under a key from this module. */
export const TAG_WRAPPED = 0x01;
/** Record tag byte: payload is stored as-is (no OS keystore on this platform). */
export const TAG_RAW = 0x00;
/**
 * Record tag byte: AES-256-GCM like TAG_WRAPPED, with the record's owner and
 * store key as additional data (record-binding.ts), so the ciphertext only
 * opens under the name it was written for. Read always; written only once
 * WRITE_BOUND_RECORDS is on (see that module for the rollout order).
 */
export const TAG_WRAPPED_BOUND = 0x02;

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
    /**
     * Set when the record opened but is in a legacy format the caller should
     * write `v` back over — migration on read: the unbound format while bound
     * writes are on, or a legacy TAG_RAW record on the one migration boot
     * (see `openRaw`), which the write re-seals under the key.
     */
    m?: true;
}

export interface KvCryptoOptions {
    /** Seal new records bound to their name. Defaults to WRITE_BOUND_RECORDS. */
    writeBound?: boolean;
    /**
     * IVs (base64) of ciphertexts that are NOT key/value records and must
     * never be opened here — main passes SecureStore's entry IVs. See
     * {@link KvCrypto.open} ("domain separation").
     */
    reservedIvs?: () => ReadonlySet<string>;
    /**
     * Where the one-shot legacy TAG_RAW migration records that it has run.
     * Must be authenticated storage (main passes SecureStore). Omitted: no
     * migration window at all — TAG_RAW is refused whenever a key exists.
     */
    rawMigrationFlags?: RawMigrationFlagStore;
}

/** Minimal authenticated flag storage for the legacy TAG_RAW migration. */
export interface RawMigrationFlagStore {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

/**
 * SecureStore key recording that this device has had its one legacy-TAG_RAW
 * migration boot. Once present, an unauthenticated record is never accepted
 * again while a master key exists.
 */
export const KV_RAW_MIGRATION_FLAG = 'kv_raw_migration_closed_v1';

/**
 * Record families whose whole value is TRUST state: safety-number verification
 * pins, unresolved sender-identity warnings, and the own-device ledger. These
 * are never accepted from an unauthenticated (TAG_RAW) record when a key
 * exists — not even during the migration boot — because forging them is the
 * point of writing one. Losing a legacy one costs a re-verification; accepting
 * a forged one silently vouches for an attacker's key.
 */
export const SECURITY_STATE_KV_PREFIXES: readonly string[] = ['kv_verify_', 'kv_warn_', 'kv_own_devices_'];

export function isSecurityStateKvKey(name: string): boolean {
    return SECURITY_STATE_KV_PREFIXES.some(p => name.startsWith(p));
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
    private readonly writeBound: boolean;
    private readonly reservedIvs: (() => ReadonlySet<string>) | null;
    private readonly rawFlags: RawMigrationFlagStore | null;
    /** null until first asked; then fixed for this process's lifetime. */
    private rawMigrationOpen: boolean | null = null;

    constructor(source: MasterKeySource, options: KvCryptoOptions = {}) {
        this.source = source;
        this.writeBound = options.writeBound ?? WRITE_BOUND_RECORDS;
        this.reservedIvs = options.reservedIvs ?? null;
        this.rawFlags = options.rawMigrationFlags ?? null;
    }

    /**
     * Whether THIS boot is the legacy-TAG_RAW migration boot. Decided once per
     * process: the first time a keyed store meets the question, the flag is
     * read and — if absent — written straight away, so the window is exactly
     * this process and every later boot refuses raw records. Fails closed: a
     * flag store that throws means no migration.
     */
    private legacyRawMigrationOpen(): boolean {
        if (this.rawMigrationOpen !== null) return this.rawMigrationOpen;
        if (!this.rawFlags) { this.rawMigrationOpen = false; return false; }
        try {
            const closed = this.rawFlags.get(KV_RAW_MIGRATION_FLAG);
            this.rawMigrationOpen = closed === null;
            if (this.rawMigrationOpen) this.rawFlags.set(KV_RAW_MIGRATION_FLAG, new Date().toISOString());
        } catch (e) {
            console.warn('[kv-crypto] raw-migration flag unavailable — refusing legacy raw records', e);
            this.rawMigrationOpen = false;
        }
        return this.rawMigrationOpen;
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
        // DOMAIN SEPARATION. SecureStore (secure-store.json) seals its entries
        // as AES-256-GCM under this same master key with no AAD, and a
        // master-tier legacy record here is exactly that shape, so this method
        // used to be a decryption oracle for the whole keystore — the Signal
        // identity, prekeys, channel keys, Drive tokens — for anyone who could
        // put a vault entry's bytes in front of it. A key or AAD change would
        // separate the two cryptographically, but builds that cannot read the
        // new format are still installable and a downgrade would then lose the
        // device identity (record-binding.ts). Until phase 2 lands, refuse any
        // ciphertext whose IV belongs to a live SecureStore entry: a GCM
        // ciphertext cannot be re-IV'd without failing its tag, so this is
        // exact for every entry the vault holds.
        let reserved: ReadonlySet<string> | null = null;
        const isReserved = (b: Uint8Array): boolean => {
            if (!this.reservedIvs || b.byteLength < 1 + IV_LEN) return false;
            if (b[0] !== TAG_WRAPPED && b[0] !== TAG_WRAPPED_BOUND) return false;
            const set = reserved ?? (reserved = this.reservedIvs());
            const iv = Buffer.from(b.buffer, b.byteOffset + 1, IV_LEN).toString('base64');
            return set.has(iv);
        };
        // Decide the migration window on the first keyed open, whether or not
        // this batch holds a raw record — otherwise the window would stay open
        // until the first raw record arrived, i.e. until someone planted one.
        if (this.source.status() === 'ok' && this.source.keyBytes()) this.legacyRawMigrationOpen();
        return records.map(rec => {
            try {
                if (isReserved(rec.b)) throw new Error('ciphertext belongs to the keystore, not the kv store');
                const key = this.keyFor(rec.o);
                if (rec.b.byteLength > 0 && rec.b[0] === TAG_RAW) {
                    // A raw record carries no authentication at all, so anyone
                    // who can write the profile's IndexedDB can mint one. It is
                    // only meaningful on a platform with no keystore (status
                    // ok, no key) — the case `wrap` still writes it for. With a
                    // key present it is either a pre-2026-06 legacy record,
                    // re-sealed once on the migration boot (`m`), or a forgery.
                    const v = this.openRaw(rec, key);
                    return key ? { k: rec.k, v, m: true as const } : { k: rec.k, v };
                }
                const plain = this.unwrap(rec.b, key, rec.o, rec.k);
                const legacyWrapped = rec.b.byteLength > 0 && rec.b[0] === TAG_WRAPPED;
                return this.writeBound && legacyWrapped ? { k: rec.k, v: plain, m: true as const } : { k: rec.k, v: plain };
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
        // A keyed write also settles the migration window (see open): on a
        // fresh install the first boot may write before it ever reads.
        if (this.source.keyBytes()) this.legacyRawMigrationOpen();
        return records.map(rec => {
            try {
                return { k: rec.k, b: this.wrap(rec.v, this.keyFor(rec.o), this.writeBound ? kvRecordAad(rec.o, rec.k) : null) };
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
    private wrap(value: string, key: Buffer | null, aad: Buffer | null): Uint8Array {
        const plaintext = Buffer.from(value, 'utf8');
        if (!key) {
            const out = Buffer.allocUnsafe(1 + plaintext.length);
            out[0] = TAG_RAW;
            plaintext.copy(out, 1);
            return new Uint8Array(out);
        }
        const iv = crypto.randomBytes(IV_LEN);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        if (aad) cipher.setAAD(aad);
        const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        // WebCrypto's AES-GCM output is ciphertext||tag; Node hands the tag back
        // separately, so append it to keep the two formats interchangeable.
        const gcmTag = cipher.getAuthTag();
        const out = Buffer.allocUnsafe(1 + IV_LEN + ct.length + gcmTag.length);
        out[0] = aad ? TAG_WRAPPED_BOUND : TAG_WRAPPED;
        iv.copy(out, 1);
        ct.copy(out, 1 + IV_LEN);
        gcmTag.copy(out, 1 + IV_LEN + ct.length);
        return new Uint8Array(out);
    }

    /** Policy for an unauthenticated TAG_RAW record; see {@link open}. */
    private openRaw(rec: KvCipherRecord, key: Buffer | null): string {
        const value = () => Buffer.from(rec.b.buffer, rec.b.byteOffset, rec.b.byteLength).subarray(1).toString('utf8');
        if (!key) {
            // Locked: nothing authenticated can be read either, and a raw
            // record must not be the one thing that still "works".
            if (this.source.status() !== 'ok') throw new Error('raw record refused while the store is locked');
            return value();
        }
        if (isSecurityStateKvKey(rec.k)) throw new Error('unauthenticated raw record refused for a security-state key');
        if (!this.legacyRawMigrationOpen()) throw new Error('unauthenticated raw record refused (a master key exists)');
        return value();
    }

    /** Reverse of {@link wrap}. Reads every tag, so a store written across a
     *  keystore-availability change (or across the bound-record rollout)
     *  still reads back. A bound record opens only under its own owner+key. */
    private unwrap(stored: Uint8Array, key: Buffer | null, owner: string | null, name: string): string {
        const buf = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
        if (buf.length === 0) throw new Error('empty record');
        const tag = buf[0];
        if (tag === TAG_RAW) throw new Error('raw record reached unwrap'); // handled by openRaw
        if (tag !== TAG_WRAPPED && tag !== TAG_WRAPPED_BOUND) throw new Error(`unknown record tag 0x${tag.toString(16)}`);
        if (!key) throw new Error('record is wrapped but no master key is available');
        if (buf.length < 1 + IV_LEN + GCM_TAG_LEN) throw new Error('wrapped record is truncated');
        const iv = buf.subarray(1, 1 + IV_LEN);
        const ct = buf.subarray(1 + IV_LEN, buf.length - GCM_TAG_LEN);
        const gcmTag = buf.subarray(buf.length - GCM_TAG_LEN);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        if (tag === TAG_WRAPPED_BOUND) decipher.setAAD(kvRecordAad(owner, name));
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
