import { describe, it, expect, vi, beforeEach } from 'vitest';

// The loader is pure I/O orchestration: key lookup -> download -> decrypt ->
// caches. Everything it touches is mocked so the test pins the ORDER and the
// recovery rule, not the network.
const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

const keyStore = new Map<string, { keyB64: string; nonceB64: string }>();
vi.mock('../utils/avatarKeyStore', () => ({
    loadAvatarKey: async (id: string) => keyStore.get(id) ?? null,
    saveAvatarKey: async (id: string, keyB64: string, nonceB64: string) => { keyStore.set(id, { keyB64, nonceB64 }); return true; },
    deleteAvatarKey: async (id: string) => { keyStore.delete(id); },
}));

const blobStore = new Map<string, Blob>();
vi.mock('../utils/attachmentCache', () => ({
    getAvatarBlob: async (id: string) => blobStore.get(id) ?? null,
    putAvatarBlob: async (id: string, b: Blob) => { blobStore.set(id, b); },
    deleteAvatarBlob: async (id: string) => { blobStore.delete(id); },
}));

const decryptBlob = vi.fn();
vi.mock('../utils/crypto', () => ({
    importKeyFromBase64: async (k: string) => ({ k }),
    decryptBlob: (...a: unknown[]) => decryptBlob(...a),
}));

vi.mock('../contexts/HydrationContext', () => ({ useHydrationGeneration: () => 0 }));

import { loadAvatarToCache, evictAvatar } from './useEncryptedAvatar';

const ID = 'att-1';
const TOKEN = 't';
const url = (path: string) => (axiosGet.mock.calls as unknown[][]).filter(c => String(c[0]).includes(path)).length;

beforeEach(() => {
    axiosGet.mockReset(); decryptBlob.mockReset(); keyStore.clear(); blobStore.clear();
    (globalThis as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
    (globalThis as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
    axiosGet.mockImplementation(async (u: string) => {
        if (u.includes('/key'))      return { data: { file_key_b64: 'SERVER-KEY', file_nonce_b64: 'n' } };
        if (u.includes('/download')) return { data: { download_url: 'https://media/x', mime_type: 'image/png' } };
        if (u.startsWith('https://media')) return { data: new Blob(['cipher']) };
        throw new Error('unexpected ' + u);
    });
});

describe('loadAvatarToCache', () => {
    it('a stale locally cached key is purged and the load retried with the server key', async () => {
        keyStore.set(ID, { keyB64: 'STALE', nonceB64: 'n' });
        decryptBlob.mockImplementation(async (_b: Blob, key: { k: string }) => {
            if (key.k === 'STALE') throw new Error('bad tag');
            return new Blob(['plain']);
        });
        const result = await loadAvatarToCache(ID, TOKEN);
        expect(result).toMatch(/^blob:/);
        expect(url('/key')).toBe(1);          // went to the server for a fresh key exactly once
        expect(keyStore.get(ID)?.keyB64).toBe('SERVER-KEY'); // and cached it in place of the stale one
        expect(decryptBlob).toHaveBeenCalledTimes(2);
    });

    it('a server key that ALSO fails does not loop', async () => {
        keyStore.set(ID, { keyB64: 'STALE', nonceB64: 'n' });
        decryptBlob.mockRejectedValue(new Error('bad tag'));
        expect(await loadAvatarToCache(ID, TOKEN)).toBeNull();
        expect(url('/key')).toBe(1);
        expect(decryptBlob).toHaveBeenCalledTimes(2);
    });

    it('a good local key never touches the key endpoint', async () => {
        keyStore.set(ID, { keyB64: 'GOOD', nonceB64: 'n' });
        decryptBlob.mockResolvedValue(new Blob(['plain']));
        expect(await loadAvatarToCache(ID, TOKEN)).toMatch(/^blob:/);
        expect(url('/key')).toBe(0);
    });

    it('a key fetch failure (403 for a non-friend) yields null with no download attempt', async () => {
        axiosGet.mockImplementation(async (u: string) => { if (u.includes('/key')) throw new Error('403'); throw new Error('unexpected'); });
        expect(await loadAvatarToCache(ID, TOKEN)).toBeNull();
        expect(url('/download')).toBe(0);
    });

    it('evictAvatar drops the session URL and the persisted blob', async () => {
        decryptBlob.mockResolvedValue(new Blob(['plain']));
        await loadAvatarToCache(ID, TOKEN);
        expect(blobStore.has(ID)).toBe(true);
        evictAvatar(ID);
        expect(blobStore.has(ID)).toBe(false);
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    });
});
