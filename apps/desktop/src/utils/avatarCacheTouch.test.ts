/**
 * getAvatarBlob used to re-`put` the whole wrapped avatar blob on EVERY read,
 * just to bump `lastAccess` for the pruner (which works in days: 90-day age,
 * 500-entry LRU). At boot that is one readwrite transaction + one blob rewrite
 * per avatar on screen, every launch. It now refreshes only a stale stamp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(5)).toString('base64');
type TestGlobal = typeof globalThis & { window?: { electronAPI?: Record<string, unknown> } };

async function wipeDb(): Promise<void> {
    await new Promise<void>(resolve => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
    });
}

describe('avatar cache lastAccess refresh', () => {
    beforeEach(async () => {
        vi.resetModules();
        const g = globalThis as TestGlobal;
        g.window = g.window ?? {};
        (g.window as unknown as Record<string, unknown>).electronAPI = { getBlobCacheKey: vi.fn(async () => ({ status: 'ok' as const, keyB64: KEY_B64 })) };
        await wipeDb();
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('a read of a fresh entry writes nothing; a read of a stale one refreshes it once', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
        const cache = await import('./attachmentCache');
        await cache.putAvatarBlob('av-1', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));

        const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
        for (let i = 0; i < 5; i++) expect(await cache.getAvatarBlob('av-1')).not.toBeNull();
        await new Promise(r => setTimeout(r, 20));
        expect(putSpy).toHaveBeenCalledTimes(0);

        vi.setSystemTime(new Date(Date.now() + cache.AVATAR_TOUCH_INTERVAL_MS + 1000));
        expect(await cache.getAvatarBlob('av-1')).not.toBeNull();
        await new Promise(r => setTimeout(r, 20));
        expect(putSpy).toHaveBeenCalledTimes(1);

        // …and the refreshed stamp makes the next read free again.
        expect(await cache.getAvatarBlob('av-1')).not.toBeNull();
        await new Promise(r => setTimeout(r, 20));
        expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it('legacy raw-Blob entries (no stamp) are upgraded on first read', async () => {
        const cache = await import('./attachmentCache');
        const db = await cache.openDb();
        await new Promise<void>((res, rej) => {
            const tx = db.transaction('avatars_dec', 'readwrite');
            tx.objectStore('avatars_dec').put(new Blob([new Uint8Array([0, 9, 9])]), 'legacy');
            tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
        });
        const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
        await cache.getAvatarBlob('legacy');
        await new Promise(r => setTimeout(r, 20));
        expect(putSpy).toHaveBeenCalledTimes(1);
    });
});
