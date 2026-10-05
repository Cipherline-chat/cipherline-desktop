/**
 * At-rest crypto for the renderer's BLOB caches (attachment ciphertext and
 * decrypted avatar/icon/banner images) — and nothing else.
 *
 * This file used to be `localMasterKey.ts` and it used to fetch the device
 * MASTER key over IPC. It no longer does, and the rename is deliberate: a
 * module named for a key it does not hold is a hazard in crypto code.
 *
 * WHAT CHANGED
 * The master key is the root of everything this device stores at rest — the
 * Signal identity private key, every prekey, channel and avatar key, the Drive
 * OAuth tokens, every record in the encrypted key/value store, and every backup
 * container the device has ever written. It does not rotate and it does not
 * expire, so one copy is good against the whole vault, offline, forever. The
 * key/value store's crypto moved into the main process (electron/kv-crypto.ts)
 * so those bytes stop crossing the context bridge at all.
 *
 * WHY THIS ONE KEY IS STILL HANDED OVER
 * `attachmentCache.ts` wraps whole blobs — attachment ciphertext up to the
 * 2 GiB paid cap, plus decrypted images. Routing those through IPC copies every
 * byte across the bridge twice, which is a real cost for no security gain. So
 * the crypto stays here and the KEY is narrowed instead: main returns
 * HKDF(master, "cl-blob-cache"). HKDF is one-way, so this key cannot be walked
 * back to the master key, and it opens the blob cache and nothing else — not
 * the key/value store, not the Signal identity, not a single backup container.
 * An attacker who lifts it from a compromised renderer gets a cache of data
 * that renderer could already read, and gains no offline reach beyond it.
 *
 * ONE-TIME COLD CACHE
 * Blobs written before this change were wrapped under the master key and cannot
 * be opened with the scoped key. That is handled by dropping and recreating the
 * two blob object stores on the IndexedDB version bump in `attachmentCache.ts`
 * (`kv_enc`, which holds the data that actually matters, is left untouched).
 * The visible effect is that avatars and saved attachments are re-fetched once.
 * Every read path here already treats a failed unwrap as a cache miss, so even
 * if a stale record survived, it degrades to a re-download and never to an error.
 *
 * Record format is unchanged:
 *
 *     [1-byte tag][12-byte IV][AES-256-GCM ciphertext || 16-byte auth tag]
 *
 * `TAG_RAW` records carry the payload unencrypted — the fallback used when the
 * platform has no keystore (e.g. headless Linux), so the app keeps working at
 * the cost of the at-rest layer. The read path tolerates a mix of the two.
 */
import { encryptBlobOffThread, decryptBlobOffThread } from './attachmentCryptoWorker';

export const IV_LEN = 12;

/** Record tag byte: payload is AES-256-GCM wrapped with the blob-cache key. */
export const TAG_WRAPPED = 0x01;
/** Record tag byte: payload is stored as-is (no keystore available). */
export const TAG_RAW = 0x00;

/**
 * Resolution state of the blob-cache key for this session:
 *   'ok'     — key available; at-rest blobs are AES-256-GCM encrypted.
 *   'absent' — no OS keystore (or no Electron bridge at all, which is how this
 *              module behaves when the website imports it); blobs degrade to
 *              TAG_RAW and the app keeps working without the at-rest layer.
 *   'locked' — a key file exists but cannot be unlocked. Encrypted records are
 *              unreadable AND must NOT be overwritten.
 */
export type BlobCacheKeyStatus = 'ok' | 'absent' | 'locked';

export interface BlobCacheKeyInfo {
    status: BlobCacheKeyStatus;
    /** The imported AES-GCM key, present only when status === 'ok'. */
    key: CryptoKey | null;
}

let keyInfoPromise: Promise<BlobCacheKeyInfo> | null = null;
let warnedNoKey = false;

/**
 * Fetch + import the scoped blob-cache key with its resolution status,
 * memoized for the session. The import is non-extractable.
 */
export async function getBlobCacheKeyInfo(): Promise<BlobCacheKeyInfo> {
    if (keyInfoPromise) return keyInfoPromise;
    keyInfoPromise = (async (): Promise<BlobCacheKeyInfo> => {
        try {
            const api = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI;
            const bridge = api?.getBlobCacheKey;
            if (typeof bridge !== 'function') {
                // No Electron bridge — the website imports this graph. Degrade
                // to TAG_RAW rather than failing, exactly as before.
                warnAbsent();
                return { status: 'absent', key: null };
            }
            const res = await (bridge as () => Promise<{ status: string; keyB64?: string }>)();
            if (res?.status === 'ok' && res.keyB64) {
                return { status: 'ok', key: await importKey(res.keyB64) };
            }
            if (res?.status === 'locked') {
                console.warn('[blobCacheKey] keystore is LOCKED — cached blobs preserved, writes must be blocked');
                return { status: 'locked', key: null };
            }
            warnAbsent();
            return { status: 'absent', key: null };
        } catch (e) {
            console.error('[blobCacheKey] getBlobCacheKeyInfo failed', e);
            // Unknown failure: be conservative and report 'locked' so callers
            // never overwrite a possibly-recoverable encrypted store.
            return { status: 'locked', key: null };
        }
    })();
    return keyInfoPromise;
}

/**
 * Convenience accessor returning just the CryptoKey (or null for absent/locked).
 * Used by consumers that only need to encrypt/decrypt and treat any
 * non-'ok' state as "no key".
 */
export async function getBlobCacheKey(): Promise<CryptoKey | null> {
    return (await getBlobCacheKeyInfo()).key;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
    const raw = base64ToBytes(keyB64);
    // Non-extractable so the key can't be exported from the renderer.
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function warnAbsent(): void {
    if (!warnedNoKey) {
        console.warn('[blobCacheKey] no OS-wrapped blob-cache key available — cached blobs will not be encrypted');
        warnedNoKey = true;
    }
}

/** Test/teardown hook — forget the memoized key so the next call re-fetches. */
export function _resetBlobCacheKeyForTest(): void {
    keyInfoPromise = null;
    warnedNoKey = false;
}

// Return type is annotated as Uint8Array<ArrayBuffer> (not bare Uint8Array,
// which TS 5.7+ widens to Uint8Array<ArrayBufferLike> = possibly SharedArrayBuffer-
// backed). `new Uint8Array(len)` is always plain-ArrayBuffer-backed, so this is
// accurate — and it's what lets the result satisfy WebCrypto's BufferSource
// params (crypto.subtle.importKey) without a cast. Without it the website's
// tsc -b (which type-checks this file via the account crypto graph) fails.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Wrap a Blob into a tagged at-rest record. Uses AES-256-GCM under the given
 * key (defaulting to the session blob-cache key); falls back to TAG_RAW when no
 * key is available.
 */
export async function wrapBlob(plain: Blob, key?: CryptoKey | null): Promise<Blob> {
    // Composed from Blob parts and encrypted in the attachment crypto worker
    // (utils/attachmentCryptoWorker.ts): no full-size copy on the UI thread.
    // Byte layout unchanged — [tag][12-byte IV][ciphertext+tag] or [tag][raw].
    const k = key === undefined ? await getBlobCacheKey() : key;
    if (!k) {
        return new Blob([new Uint8Array([TAG_RAW]), plain]);
    }
    const { encryptedBlob } = await encryptBlobOffThread(plain, k, /* bundleIv= */ true);
    return new Blob([new Uint8Array([TAG_WRAPPED]), encryptedBlob]);
}

/**
 * Reverse of {@link wrapBlob}. Handles both TAG_RAW and TAG_WRAPPED records, so
 * a store written across a keystore-availability change still reads back.
 * Throws if a wrapped record is encountered but no key is available — callers
 * treat that as a cache miss.
 */
export async function unwrapBlob(stored: Blob, key?: CryptoKey | null): Promise<Blob> {
    if (stored.size === 0) throw new Error('empty record');
    // Only the tag byte is read here; the payload is sliced (a handle, not a
    // copy) and decrypted in the attachment crypto worker.
    const tag = new Uint8Array(await stored.slice(0, 1).arrayBuffer())[0];
    if (tag === TAG_RAW) {
        return stored.slice(1, stored.size, '');
    }
    if (tag === TAG_WRAPPED) {
        const k = key === undefined ? await getBlobCacheKey() : key;
        if (!k) throw new Error('record is wrapped but no blob-cache key is available');
        return decryptBlobOffThread(stored.slice(1), k, null, '');
    }
    throw new Error(`unknown record tag 0x${tag.toString(16)}`);
}
