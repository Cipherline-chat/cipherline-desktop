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
const putKinds = new Map<string, string | undefined>();
vi.mock('../utils/attachmentCache', () => ({
    getAvatarBlob: async (id: string) => blobStore.get(id) ?? null,
    putAvatarBlob: async (id: string, b: Blob, opts?: { kind?: string }) => { blobStore.set(id, b); putKinds.set(id, opts?.kind); },
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

    it('a key fetch failure (403 for a non-friend) yields null and never downloads the media', async () => {
        // The presigned-URL request now leaves IN PARALLEL with the key fetch
        // (it is the same server-side gate, so it 403s too) — the price of
        // taking a round trip off every cold load is that one extra, equally
        // gated request on this failure path. What must never happen is the
        // media GET or a decrypt.
        axiosGet.mockImplementation(async (u: string) => { if (u.includes('/key') || u.includes('/download')) throw new Error('403'); throw new Error('unexpected ' + u); });
        expect(await loadAvatarToCache(ID, TOKEN)).toBeNull();
        expect(url('/download')).toBeLessThanOrEqual(1);
        expect(url('https://media')).toBe(0);
        expect(decryptBlob).not.toHaveBeenCalled();
    });

    it('a cold load asks for the key and the download URL in PARALLEL, not back to back', async () => {
        // Hold every API response until both requests have been made. Serial
        // code would deadlock here (the URL request waits on the key), so the
        // assertion is that both are outstanding at once.
        const gates: Array<() => void> = [];
        axiosGet.mockImplementation((u: string) => new Promise((resolve, reject) => {
            const answer = () => {
                if (u.includes('/key')) resolve({ data: { file_key_b64: 'SERVER-KEY', file_nonce_b64: 'n' } });
                else if (u.includes('/download')) resolve({ data: { download_url: 'https://media/x', mime_type: 'image/jpeg' } });
                else if (u.startsWith('https://media')) resolve({ data: new Blob(['cipher']) });
                else reject(new Error('unexpected ' + u));
            };
            if (u.startsWith('https://media')) answer(); else gates.push(answer);
        }));
        decryptBlob.mockResolvedValue(new Blob(['plain']));
        const p = loadAvatarToCache(ID, TOKEN);
        for (let i = 0; i < 10 && gates.length < 2; i++) await Promise.resolve();
        expect(url('/key')).toBe(1);
        expect(url('/download')).toBe(1);
        gates.forEach(g => g());
        expect(await p).toMatch(/^blob:/);
        expect(url('https://media')).toBe(1);
    });

    it('persists with the caller\'s prune class (banners get their own budget)', async () => {
        const kinds: Array<string | undefined> = [];
        decryptBlob.mockResolvedValue(new Blob(['plain']));
        blobStore.clear();
        await loadAvatarToCache('banner-1', TOKEN, undefined, { kind: 'banner' });
        await loadAvatarToCache('avatar-1', TOKEN);
        kinds.push(putKinds.get('banner-1'), putKinds.get('avatar-1'));
        expect(kinds).toEqual(['banner', undefined]);
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
