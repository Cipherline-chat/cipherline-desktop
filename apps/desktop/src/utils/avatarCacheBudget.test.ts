/**
 * The decrypted-image cache (`avatars_dec`) for avatars, banners and emojis:
 * keyed by attachment id, encrypted at rest, and budgeted per class.
 *
 * Runs the REAL attachmentCache + blobCacheKey against a real IndexedDB
 * (fake-indexeddb, installed by vitest.setup.ts) and real WebCrypto. Only the
 * preload bridge that hands over the OS-wrapped blob-cache key is stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
type TestGlobal = typeof globalThis & { window?: { electronAPI?: Record<string, unknown> } };

function installBridge(status: 'ok' | 'absent'): void {
    const g = globalThis as TestGlobal;
    g.window = g.window ?? {};
    (g.window as unknown as Record<string, unknown>).electronAPI = {
        getBlobCacheKey: vi.fn(async () => (status === 'ok' ? { status: 'ok' as const, keyB64: KEY_B64 } : { status: 'absent' as const })),
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

async function boot(status: 'ok' | 'absent' = 'ok') {
    vi.resetModules();
    installBridge(status);
    return await import('./attachmentCache');
}

/** Every raw record in avatars_dec, as stored on disk. */
async function rawRecords(cache: Awaited<ReturnType<typeof boot>>): Promise<Map<string, { data: Blob; lastAccess: number; kind?: string }>> {
    const db = await cache.openDb();
    const out = new Map<string, { data: Blob; lastAccess: number; kind?: string }>();
    await new Promise<void>((resolve, reject) => {
        const req = db.transaction('avatars_dec', 'readonly').objectStore('avatars_dec').openCursor();
        req.onsuccess = () => {
            const c = req.result;
            if (!c) { resolve(); return; }
            out.set(String(c.key), c.value);
            c.continue();
        };
        req.onerror = () => reject(req.error);
    });
    return out;
}

const PLAINTEXT = 'JFIF-pretend-this-is-a-decrypted-banner-image';

beforeEach(async () => { await wipeDb(); });

describe('decrypted image cache', () => {
    it('is keyed by attachment id and round-trips the decrypted bytes', async () => {
        const cache = await boot();
        await cache.putAvatarBlob('att-banner', new Blob([PLAINTEXT]), { kind: 'banner' });
        const back = await cache.getAvatarBlob('att-banner');
        expect(Buffer.from(await back!.arrayBuffer()).toString()).toBe(PLAINTEXT);
        expect([...(await rawRecords(cache)).keys()]).toEqual(['att-banner']);
    });

    it('is ENCRYPTED at rest: the stored record never contains the image bytes', async () => {
        const cache = await boot();
        await cache.putAvatarBlob('att-banner', new Blob([PLAINTEXT]), { kind: 'banner' });
        const rec = (await rawRecords(cache)).get('att-banner')!;
        const stored = Buffer.from(await rec.data.arrayBuffer());
        expect(stored.includes(Buffer.from(PLAINTEXT))).toBe(false);
        expect(stored[0]).toBe(0x01); // TAG_WRAPPED: AES-256-GCM under the blob-cache key
        expect(rec.kind).toBe('banner');
    });

    it('writes NOTHING when no blob-cache key is available (never plaintext on disk)', async () => {
        const cache = await boot('absent');
        await cache.putAvatarBlob('att-avatar', new Blob([PLAINTEXT]));
        await cache.putAvatarBlob('att-banner', new Blob([PLAINTEXT]), { kind: 'banner' });
        expect((await rawRecords(cache)).size).toBe(0);
        expect(await cache.getAvatarBlob('att-avatar')).toBeNull();
    });

    it('budgets each class separately: banners cannot evict avatars, and vice versa', async () => {
        const cache = await boot();
        const B = cache.AVATAR_CACHE_BUDGET;
        expect(B.banners).toBeLessThan(B.avatars); // banners are ~3x the bytes
        // Small budgets so the test stays quick; the rule is the same.
        for (let i = 0; i < 4; i++) await cache.putAvatarBlob(`av-${i}`, new Blob([`a${i}`]));
        for (let i = 0; i < 6; i++) await cache.putAvatarBlob(`bn-${i}`, new Blob([`b${i}`]), { kind: 'banner' });
        for (let i = 0; i < 3; i++) await cache.putAvatarBlob(`em-${i}`, new Blob([`e${i}`]), { kind: 'emoji' });
        await cache.pruneAvatarCache(B.maxAgeMs, /* avatars */ 3, /* emojis */ 10, /* banners */ 2);
        const left = [...(await rawRecords(cache)).keys()].sort();
        expect(left.filter(k => k.startsWith('av-'))).toHaveLength(3);
        expect(left.filter(k => k.startsWith('bn-'))).toHaveLength(2);
        expect(left.filter(k => k.startsWith('em-'))).toHaveLength(3);
    });

    it('evicts least-recently-used first within a class', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
            const cache = await boot();
            await cache.putAvatarBlob('bn-old', new Blob(['o']), { kind: 'banner' });
            vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
            await cache.putAvatarBlob('bn-new', new Blob(['n']), { kind: 'banner' });
            await cache.pruneAvatarCache(cache.AVATAR_CACHE_BUDGET.maxAgeMs, 500, 2000, 1);
            expect([...(await rawRecords(cache)).keys()]).toEqual(['bn-new']);
        } finally {
            vi.useRealTimers();
        }
    });
});
