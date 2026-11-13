/**
 * Owner report: "animated profiles should not play unless hovered". Root cause: the
 * persistent avatar cache (IndexedDB, AES-GCM wrapped) stored the decrypted bytes
 * with NO type, and `unwrapBlob` hands them back as `type: ''`. The still gate
 * treats an unknown type as "static image" and plays it natively - so every
 * avatar that came off disk (i.e. every avatar after the first launch) animated
 * everywhere. Only a fresh download in the same session had its real type.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(5)).toString('base64');
type TestGlobal = typeof globalThis & { window?: { electronAPI?: Record<string, unknown> } };

const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]);
// RIFF....WEBPVP8X (animation flag set)
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

async function wipeDb(): Promise<void> {
    await new Promise<void>(resolve => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve(); req.onerror = () => resolve(); req.onblocked = () => resolve();
    });
}

describe('avatar blob keeps its image type across the persistent cache', () => {
    beforeEach(async () => {
        vi.resetModules();
        const g = globalThis as TestGlobal;
        g.window = g.window ?? {};
        (g.window as unknown as Record<string, unknown>).electronAPI = { getBlobCacheKey: vi.fn(async () => ({ status: 'ok' as const, keyB64: KEY_B64 })) };
        await wipeDb();
    });

    for (const [name, bytes, type] of [['GIF', GIF, 'image/gif'], ['animated WebP', WEBP, 'image/webp'], ['PNG', PNG, 'image/png'], ['JPEG', JPEG, 'image/jpeg']] as const) {
        it(`${name}: put with its type, read back with the same type`, async () => {
            const cache = await import('./attachmentCache');
            await cache.putAvatarBlob(`av-${name}`, new Blob([bytes], { type }));
            const back = await cache.getAvatarBlob(`av-${name}`);
            expect(back).not.toBeNull();
            expect(back!.type).toBe(type);
            expect(new Uint8Array(await back!.arrayBuffer())).toEqual(bytes);
        });
    }

    it('unrecognised bytes stay untyped (never guessed into an image type)', async () => {
        const cache = await import('./attachmentCache');
        await cache.putAvatarBlob('av-x', new Blob([new Uint8Array(16).fill(7)], { type: 'application/octet-stream' }));
        expect((await cache.getAvatarBlob('av-x'))!.type).not.toMatch(/^image\//);
    });
});
