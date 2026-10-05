/**
 * Does the persistent avatar blob cache actually survive an app restart?
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * "Profile pictures have to re-cache after a reboot" has an obvious and much
 * scarier reading than the one that turned out to be true: that the IndexedDB
 * blob store is being emptied. There are two documented ways that could happen
 * and both look plausible on a quick read of `attachmentCache.ts`:
 *
 *   1. VERSION 4 drops and recreates `attachments_enc` / `avatars_dec`. If
 *      anything re-triggered that upgrade, every restart would be cold.
 *   2. The records are wrapped with HKDF(master, "cl-blob-cache"), fetched over
 *      IPC and memoized per session. If that key were not stable across
 *      sessions, every record would fail to unwrap — which `getAvatarBlob`
 *      correctly reports as a cache MISS, i.e. silently, and which is
 *      indistinguishable from an empty store.
 *
 * Both are ruled out here against the real module and a real IndexedDB, rather
 * than by reading the code. `restartFirstPaint.test.ts` measures the same
 * conclusion from the other end (a restarted session issues zero requests);
 * this one measures the store itself.
 *
 * A restart is modelled with `vi.resetModules()` — `openDb` memoizes its
 * connection in module scope and `blobCacheKey` memoizes the imported key, so
 * dropping the module registry drops exactly the state a process exit drops
 * while IndexedDB (fake-indexeddb, installed globally by vitest.setup.ts)
 * persists, exactly as the real one does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** One fixed key for the device, re-derived identically on every "boot". */
const KEY_B64 = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');

type TestGlobal = typeof globalThis & { window?: { electronAPI?: Record<string, unknown> } };

function installBridge(status: 'ok' | 'absent' = 'ok'): void {
    const g = globalThis as TestGlobal;
    g.window = g.window ?? {};
    g.window.electronAPI = {
        getBlobCacheKey: vi.fn(async () =>
            status === 'ok' ? { status: 'ok', keyB64: KEY_B64 } : { status: 'absent' }),
    };
}

async function wipeDb(): Promise<void> {
    await new Promise<void>(resolve => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
    });
}

/** Simulate a process restart: fresh module registry, same IndexedDB on disk. */
async function boot() {
    vi.resetModules();
    installBridge();
    return await import('./attachmentCache');
}

async function readText(b: Blob | null): Promise<string | null> {
    if (!b) return null;
    return Buffer.from(await b.arrayBuffer()).toString('utf8');
}

/** Build the DB at an arbitrary older version, the way a released client left it. */
function seedLegacyDb(version: number, stores: string[]): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('cipherline', version);
        req.onupgradeneeded = () => {
            for (const s of stores) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function put(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function count(db: IDBDatabase, store: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

beforeEach(async () => {
    await wipeDb();
    installBridge();
});

describe('the avatar blob cache survives a restart', () => {
    it('a blob written in one session reads back, decrypted, in the next', async () => {
        const s1 = await boot();
        await s1.putAvatarBlob('att-1', new Blob(['profile-picture-bytes']));
        expect(await readText(await s1.getAvatarBlob('att-1'))).toBe('profile-picture-bytes');

        // ── restart ──
        const s2 = await boot();
        // Both halves at once: the record is still in IndexedDB AND the
        // blob-cache key re-derived in the new session still opens it. Either
        // failing would surface here as null, which is what "it re-caches every
        // reboot" would look like.
        expect(await readText(await s2.getAvatarBlob('att-1'))).toBe('profile-picture-bytes');
    });

    it('the v4 upgrade fires ONCE — a later restart leaves the stores alone', async () => {
        // Land on v4 the way a real client does, from the v3 schema.
        const legacy = await seedLegacyDb(3, ['attachments_enc', 'avatars_dec', 'kv_enc']);
        await put(legacy, 'avatars_dec', 'old-master-key-era', new Blob(['undecryptable']));
        await put(legacy, 'kv_enc', 'cipherline_user_id', { k: 'x' });
        legacy.close();

        // First boot on the new code: the two blob stores are dropped because
        // their records were wrapped under the old master key. This is the
        // documented ONE-TIME cost, and it is not what the owner is seeing —
        // it cannot recur.
        const s1 = await boot();
        const db1 = await s1.openDb();
        expect(await count(db1, 'avatars_dec')).toBe(0);
        // kv_enc is deliberately NOT touched by that upgrade.
        expect(await count(db1, 'kv_enc')).toBe(1);

        await s1.putAvatarBlob('att-2', new Blob(['fresh']));
        db1.close();

        // ── restart, and another, on the same schema version ──
        for (let i = 0; i < 2; i++) {
            const s = await boot();
            expect(await readText(await s.getAvatarBlob('att-2'))).toBe('fresh');
            (await s.openDb()).close();
        }
    });

    it('pruning is the only thing that evicts, and its defaults do not bite a normal user', async () => {
        const s = await boot();
        await s.putAvatarBlob('recent', new Blob(['keep-me']));
        // Defaults: 90 days / 500 entries. `lastAccess` is stamped on write.
        await s.pruneAvatarCache();
        expect(await readText(await s.getAvatarBlob('recent'))).toBe('keep-me');
    });
});
