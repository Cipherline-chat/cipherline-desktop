import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * A GIF seen in chat must be recognised as one already in the library, by its
 * bytes, and saving it again must not store a second copy.
 */

const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: () => true,
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const storage = await import('./gifStorage');

const UID = 'gif-identity-user';
const disk = new Map<string, Uint8Array>();
const gif = (tag: string) => new Blob([new TextEncoder().encode(`GIF89a-${tag}`)], { type: 'image/gif' });

beforeAll(() => {
    if (!(window as { location?: unknown }).location) {
        Object.assign(window, { location: { href: 'http://localhost/', origin: 'http://localhost' } });
    }
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

beforeEach(() => {
    mem.clear();
    disk.clear();
    mem.set('cipherline_user_id', UID);
    Object.assign(window, {
        dispatchEvent: () => true,
        electronAPI: {
            getUserDataPath: async () => '/userdata',
            writeFile: async (p: string, b: Uint8Array) => { disk.set(p, b); },
            readFile: async (p: string) => {
                const b = disk.get(p)!;
                return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
            },
            deleteFile: async (p: string) => { disk.delete(p); },
        },
    });
});

describe('GIF content identity', () => {
    it('saving the same bytes twice keeps ONE library entry and ONE file', async () => {
        const a = await storage.addFavorite(gif('x'), 'local', { label: 'a.gif' });
        const b = await storage.addFavorite(gif('x'), 'local', { label: 'renamed-copy.gif' });
        expect(b.id).toBe(a.id);
        expect(storage.loadFavorites()).toHaveLength(1);
        expect(disk.size).toBe(1);
    });

    it('different bytes are different favorites', async () => {
        await storage.addFavorite(gif('x'), 'local');
        await storage.addFavorite(gif('y'), 'local');
        expect(storage.loadFavorites()).toHaveLength(2);
    });

    it('finds a favorite by the hash of the same bytes', async () => {
        const a = await storage.addFavorite(gif('x'), 'local');
        const hit = await storage.findFavoriteByHash(await storage.hashBlob(gif('x')));
        expect(hit?.id).toBe(a.id);
        expect(await storage.findFavoriteByHash(await storage.hashBlob(gif('nope')))).toBeUndefined();
    });

    it('recognises a LEGACY favorite saved before hashes existed, and dedupes against it', async () => {
        const a = await storage.addFavorite(gif('old'), 'local');
        // Simulate an entry written by an older build / another device: no hash.
        const legacy = storage.loadFavorites().map(({ contentHash: _h, ...rest }) => rest);
        mem.set(storage.favoritesKey(UID), JSON.stringify(legacy));
        expect(storage.loadFavorites()[0].contentHash).toBeUndefined();

        const hit = await storage.findFavoriteByHash(await storage.hashBlob(gif('old')));
        expect(hit?.id).toBe(a.id);
        expect(storage.loadFavorites()[0].contentHash).toBeTruthy(); // backfilled

        const again = await storage.addFavorite(gif('old'), 'local');
        expect(again.id).toBe(a.id);
        expect(storage.loadFavorites()).toHaveLength(1);
    });

    it('backfill adds no ledger entry (derived data must not churn sync)', async () => {
        await storage.addFavorite(gif('x'), 'local');
        const legacy = storage.loadFavorites().map(({ contentHash: _h, ...rest }) => rest);
        mem.set(storage.favoritesKey(UID), JSON.stringify(legacy));
        const before = JSON.stringify(storage.loadLedger());
        await storage.backfillContentHashes();
        expect(JSON.stringify(storage.loadLedger())).toBe(before);
    });

    it('after removal the same bytes can be saved again', async () => {
        const a = await storage.addFavorite(gif('x'), 'local');
        await storage.removeFavorite(a.id);
        const b = await storage.addFavorite(gif('x'), 'local');
        expect(b.id).not.toBe(a.id);
        expect(storage.loadFavorites()).toHaveLength(1);
    });
});
