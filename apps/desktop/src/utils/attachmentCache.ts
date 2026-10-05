/**
 * Local persistent cache for attachment ciphertext, keyed by attachment UUID.
 *
 * TWO LAYERS OF PROTECTION:
 *
 *   1. The attachment is already end-to-end encrypted with a per-message key
 *      (`file_key_b64`) that lives only inside the E2EE message envelope.
 *
 *   2. Before we write to IndexedDB we additionally wrap the ciphertext with
 *      AES-256-GCM using a *blob-cache key* that the main process derives from
 *      the device master key, which is itself stored via Electron `safeStorage`
 *      (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). The
 *      result: a malware process running as the same OS user that reads the raw
 *      IndexedDB files gets doubly-encrypted bytes with no viable path to the
 *      key without also hijacking the OS keystore.
 *
 * The key this cache holds is deliberately NOT the device master key. It is
 * HKDF(master, "cl-blob-cache") — see `blobCacheKey.ts` for why this one key is
 * still handed to the renderer at all (these are whole blobs, up to the 2 GiB
 * paid cap, so routing them through IPC would copy every byte twice) and for
 * what that scoping does and does not buy. HKDF is one-way, so a copy of this
 * key opens the blob caches and nothing else — not the encrypted key/value
 * store, not the Signal identity, not any backup container.
 *
 * If safeStorage is unavailable (Linux without a keyring, sandbox edge cases)
 * `wrapBlob` FALLS BACK to storing the E2EE ciphertext unwrapped — still
 * protected by the per-message key, just without the additional at-rest layer.
 */

import { wrapBlob, unwrapBlob } from './blobCacheKey';

const DB_NAME = 'cipherline';
const STORE = 'attachments_enc';
/** Stores decrypted avatar / icon / banner blobs, wrapped with the blob-cache key. */
const AVATAR_STORE = 'avatars_dec';
/** Encrypted key/value store backing `secureLocalStore.ts` (added in VERSION 3). */
export const KV_STORE = 'kv_enc';
/**
 * VERSION 4 — the two BLOB stores are dropped and recreated on upgrade.
 *
 * Their contents were wrapped with the device MASTER key. That key no longer
 * crosses the context bridge (see `blobCacheKey.ts`); these blobs are now
 * wrapped with HKDF(master, "cl-blob-cache") instead, so pre-existing records
 * are undecryptable. Both are pure caches — a miss re-downloads from MinIO and
 * re-decrypts — so dropping them costs one cold fetch and nothing else, and it
 * is better than leaving bytes on disk that will never open again.
 *
 * `kv_enc` is deliberately NOT touched. Its records hold the data that actually
 * matters (session pointers, settings, message history) and its format and key
 * derivation are unchanged by this work — main reads exactly the bytes the
 * renderer used to write. Dropping it here would be indistinguishable from
 * total data loss to the user.
 */
const VERSION = 4;

let dbPromise: Promise<IDBDatabase> | null = null;

// ── IndexedDB ─────────────────────────────────────────────────────────────
/**
 * Open (and upgrade) the shared `cipherline` IndexedDB. Exported so
 * `secureLocalStore` can transact against the `kv_enc` store using the same
 * connection + schema version — keeping all object-store creation in one place.
 */
export function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable in this environment'));
            return;
        }
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = (ev) => {
            const db = req.result;
            const from = (ev as IDBVersionChangeEvent).oldVersion;
            // v3 → v4: drop the two blob caches, whose records were wrapped
            // under the old master key and can no longer be opened. Deleting
            // and recreating inside onupgradeneeded is atomic with the version
            // change, so there is no window where a half-cleared store is
            // visible. Guarded on oldVersion so a fresh install (oldVersion 0)
            // just creates them and an existing v4 is left alone.
            if (from > 0 && from < 4) {
                if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
                if (db.objectStoreNames.contains(AVATAR_STORE)) db.deleteObjectStore(AVATAR_STORE);
                // KV_STORE is NOT dropped — see the VERSION comment.
            }
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            if (!db.objectStoreNames.contains(AVATAR_STORE)) db.createObjectStore(AVATAR_STORE);
            if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onclose = () => { dbPromise = null; };
            db.onversionchange = () => { db.close(); dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
}

function run<T>(storeName: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then(db =>
        new Promise<T>((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            const req = op(store);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            tx.onerror = () => reject(tx.error);
        })
    );
}

// ── Public API ────────────────────────────────────────────────────────────
/** Store the encrypted attachment blob for the given id. Overwrites any prior. */
export async function putEncryptedAttachment(attachmentId: string, blob: Blob): Promise<void> {
    const wrapped = await wrapBlob(blob);
    await run<IDBValidKey>(STORE, 'readwrite', store => store.put(wrapped, attachmentId));
}

/** Retrieve and unwrap the cached encrypted blob, or null on miss / failure. */
export async function getEncryptedAttachment(attachmentId: string): Promise<Blob | null> {
    try {
        const stored = await run<Blob | undefined>(STORE, 'readonly', store => store.get(attachmentId) as IDBRequest<Blob | undefined>);
        if (!stored) return null;
        return await unwrapBlob(stored);
    } catch (e) {
        console.warn('[attachmentCache] read/unwrap failed', e);
        return null;
    }
}

/** Existence check without materializing the blob. */
export async function hasEncryptedAttachment(attachmentId: string): Promise<boolean> {
    try {
        const count = await run<number>(STORE, 'readonly', store => store.count(attachmentId));
        return count > 0;
    } catch {
        return false;
    }
}

/** Remove a cached entry (called on unsave and retention-sweep eviction). */
export async function deleteEncryptedAttachment(attachmentId: string): Promise<void> {
    try {
        await run<undefined>(STORE, 'readwrite', store => store.delete(attachmentId) as IDBRequest<undefined>);
    } catch (e) {
        console.warn('[attachmentCache] delete failed', e);
    }
}

// ── Avatar / icon / banner persistent cache ───────────────────────────────
//
// Stores the *decrypted* image blob, re-wrapped with the OS master key for
// at-rest protection.  Cache key is the attachment UUID; on a cache hit the
// blob URL is created directly — no network call, no E2EE decrypt needed.
// Because attachment IDs are immutable UUIDs, no explicit invalidation is
// required: changing an avatar uploads a new attachment and the old entry is
// simply never accessed again (the old entry is evicted by pruneAvatarCache).
//
// P2-REND-16: Each entry is stored as { data: Blob, lastAccess: number } so
// pruneAvatarCache can evict by age and LRU count. Existing entries written
// by older code are raw Blobs; getAvatarBlob handles both formats transparently
// and upgrades them to the new format on access.

interface AvatarEntry {
    data: Blob;
    lastAccess: number;
}

/** How stale `lastAccess` may get before a read refreshes it. */
export const AVATAR_TOUCH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Persist a decrypted avatar/icon/banner blob so the next session can skip
 *  the MinIO download + decrypt.  Fire-and-forget — callers should not await. */
export async function putAvatarBlob(attachmentId: string, blob: Blob): Promise<void> {
    const wrapped = await wrapBlob(blob);
    const entry: AvatarEntry = { data: wrapped, lastAccess: Date.now() };
    await run<IDBValidKey>(AVATAR_STORE, 'readwrite', store => store.put(entry, attachmentId));
}

/** Retrieve a previously cached decrypted avatar blob, or null on miss / failure. */
export async function getAvatarBlob(attachmentId: string): Promise<Blob | null> {
    try {
        const stored = await run<AvatarEntry | Blob | undefined>(
            AVATAR_STORE, 'readonly',
            store => store.get(attachmentId) as IDBRequest<AvatarEntry | Blob | undefined>,
        );
        if (!stored) return null;
        // Backwards-compat: old entries are raw Blobs (pre-P2-REND-16).
        const rawBlob = stored instanceof Blob ? stored : (stored as AvatarEntry).data;
        // Update lastAccess so pruner can evict LRU entries (fire-and-forget).
        // Only when it is stale: the pruner works in days (90-day age, 500-entry
        // LRU), and every refresh is a readwrite transaction that RE-WRITES the
        // whole wrapped image blob — at boot that was one blob rewrite per
        // avatar on screen, every launch.
        const lastAccess = stored instanceof Blob ? 0 : (stored as AvatarEntry).lastAccess;
        if (!(Date.now() - lastAccess < AVATAR_TOUCH_INTERVAL_MS)) {
            const entry: AvatarEntry = { data: rawBlob, lastAccess: Date.now() };
            run<IDBValidKey>(AVATAR_STORE, 'readwrite', store => store.put(entry, attachmentId)).catch(() => {});
        }
        return await unwrapBlob(rawBlob);
    } catch (e) {
        console.warn('[attachmentCache] avatar read/unwrap failed', e);
        return null;
    }
}

/** Remove a cached avatar entry (for superseded attachment IDs). */
export async function deleteAvatarBlob(attachmentId: string): Promise<void> {
    try {
        await run<undefined>(AVATAR_STORE, 'readwrite', store => store.delete(attachmentId) as IDBRequest<undefined>);
    } catch (e) {
        console.warn('[attachmentCache] avatar delete failed', e);
    }
}

/**
 * P2-REND-16: Evict avatar cache entries older than maxAgeMs, keeping at
 * most maxCount entries (evicting LRU first). Called by the retention sweep.
 * Default: 90 days / 500 entries.
 */
export async function pruneAvatarCache(
    maxAgeMs = 90 * 24 * 60 * 60 * 1000,
    maxCount = 500,
): Promise<void> {
    try {
        const db = await openDb();
        const entries: Array<{ id: IDBValidKey; lastAccess: number }> = [];

        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(AVATAR_STORE, 'readonly');
            const req = tx.objectStore(AVATAR_STORE).openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) { resolve(); return; }
                const val = cursor.value as AvatarEntry | Blob;
                const lastAccess = val instanceof Blob ? 0 : (val as AvatarEntry).lastAccess;
                entries.push({ id: cursor.key, lastAccess });
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
            tx.onerror = () => reject(tx.error);
        });

        const now = Date.now();
        const expired = entries.filter(e => now - e.lastAccess > maxAgeMs);
        const fresh = entries.filter(e => now - e.lastAccess <= maxAgeMs);
        fresh.sort((a, b) => b.lastAccess - a.lastAccess); // newest first
        const overCount = fresh.slice(maxCount);

        const toDelete = [...expired, ...overCount];
        await Promise.allSettled(toDelete.map(e =>
            run<undefined>(AVATAR_STORE, 'readwrite', store => store.delete(e.id) as IDBRequest<undefined>),
        ));

        if (toDelete.length > 0) {
            console.log(`[attachmentCache] pruned ${toDelete.length} avatar cache entries`);
        }
    } catch (e) {
        console.warn('[attachmentCache] avatar prune failed', e);
    }
}
