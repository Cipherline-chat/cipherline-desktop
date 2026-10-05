import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * KLIPY favorites — KLIPY's rule (owner's email, 2026-09): "store the KLIPY
 * asset ID/slug or media reference and re-fetch from KLIPY when needed — do
 * NOT permanently store KLIPY media files (including in device backups)."
 *
 * So saving a KLIPY GIF must write metadata only: no file under
 * cipherline-gifs/, no per-GIF key, and no `gif:` record in a backup — ever,
 * not even if a stray `<id>.enc` happened to exist on disk.
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
const { isKlipyRefEntry, KLIPY_REF_FILENAME } = await import('./gifLibrarySync');
const { buildBackupPlan } = await import('../services/backupRecords');

const UID = 'klipy-fav-user';
const REF = {
    slug: 'happy-KLx9',
    media: { url: 'https://static.klipy.com/ii/a/b.webp', width: 200, height: 150, mime: 'image/webp' as const },
    title: 'Happy',
};

const writeFile = vi.fn(async () => {});
const deleteFile = vi.fn(async () => {});
const readFile = vi.fn(async () => new ArrayBuffer(0));
let diskIds: string[] = [];
const readGifFile = vi.fn(async (id: string) => new TextEncoder().encode(`ENC-${id}`));

beforeAll(() => {
    if (!(window as { location?: unknown }).location) {
        Object.assign(window, { location: { href: 'http://localhost/', origin: 'http://localhost' } });
    }
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

beforeEach(() => {
    mem.clear();
    diskIds = [];
    writeFile.mockClear(); deleteFile.mockClear(); readFile.mockClear(); readGifFile.mockClear();
    mem.set('cipherline_user_id', UID);
    Object.assign(window, {
        dispatchEvent: () => true,
        electronAPI: {
            getUserDataPath: async () => '/userdata',
            writeFile, deleteFile, readFile,
            listGifFiles: async () => diskIds,
            readGifFile,
        },
    });
});

describe('addKlipyFavorite — a reference, never media', () => {
    it('writes metadata only: no file, no key', () => {
        const fav = storage.addKlipyFavorite(REF);
        expect(writeFile).not.toHaveBeenCalled();
        expect(fav).toMatchObject({ source: 'klipy', fileName: KLIPY_REF_FILENAME, mimeType: 'image/webp', klipy: REF, label: 'Happy' });
        expect(isKlipyRefEntry(fav)).toBe(true);
        expect([...mem.keys()].filter(k => k.startsWith(`cipherline_gif_key_${UID}_`))).toEqual([]);
        const stored = JSON.parse(mem.get(storage.favoritesKey(UID))!);
        expect(stored).toHaveLength(1);
        // Nothing byte-shaped hides in the stored record either.
        expect(JSON.stringify(stored)).not.toMatch(/base64|data:/);
    });

    it('saving the same slug twice keeps one entry', () => {
        const a = storage.addKlipyFavorite(REF);
        const b = storage.addKlipyFavorite({ ...REF, title: 'again' });
        expect(b.id).toBe(a.id);
        expect(storage.loadFavorites()).toHaveLength(1);
        expect(storage.findKlipyFavorite(storage.loadFavorites(), REF.slug)?.id).toBe(a.id);
    });

    it('refuses a reference whose URL is not an allowed KLIPY media URL', () => {
        expect(() => storage.addKlipyFavorite({ ...REF, media: { ...REF.media, url: 'https://evil.net/x.gif' } }))
            .toThrow();
        expect(storage.loadFavorites()).toEqual([]);
    });

    it('has no local file to load, and removing it deletes no file', async () => {
        const fav = storage.addKlipyFavorite(REF);
        await expect(storage.loadGifFile(fav)).rejects.toThrow(/reference/);
        expect(readFile).not.toHaveBeenCalled();
        await storage.removeFavorite(fav.id);
        expect(deleteFile).not.toHaveBeenCalled();
        expect(storage.loadFavorites()).toEqual([]);
        // The removal leaves a tombstone so sync can't resurrect it.
        expect(JSON.parse(mem.get(storage.ledgerKey(UID))!)).toHaveProperty(fav.id);
    });
});

describe('backups never carry KLIPY media', () => {
    it('a KLIPY reference produces no gif: record — even with a stray <id>.enc on disk', async () => {
        const ref = storage.addKlipyFavorite(REF);
        // A normal local GIF next to it, to prove gif: records still work.
        const local = { id: 'local-1', source: 'local', fileName: 'local-1.enc', mimeType: 'image/gif', addedAt: 1 };
        const favs = JSON.parse(mem.get(storage.favoritesKey(UID))!);
        mem.set(storage.favoritesKey(UID), JSON.stringify([...favs, local]));
        mem.set(`cipherline_gif_key_${UID}_local-1`, 'KEY');
        diskIds = ['local-1', ref.id];   // the stray file must be ignored

        const plan = await buildBackupPlan(UID, { includeAttachments: false });
        const gifRecords = plan.records.map(r => r.id).filter(id => id.startsWith('gif:'));

        expect(gifRecords).toEqual(['gif:local-1']);
        expect(readGifFile).not.toHaveBeenCalledWith(ref.id);

        // The reference itself IS backed up — it is metadata, which KLIPY allows.
        const metaSpec = plan.records.find(r => r.id === 'meta')!;
        const meta = JSON.parse(new TextDecoder().decode((await metaSpec.load())!));
        expect(meta.gifFavorites.map((g: { id: string }) => g.id)).toContain(ref.id);
        expect(meta.gifFavorites.find((g: { id: string }) => g.id === ref.id).klipy).toEqual(REF);
    });

    it('a full vault export (gifFiles inlined) leaves KLIPY references out of gifFiles', async () => {
        const ref = storage.addKlipyFavorite(REF);
        diskIds = [ref.id];
        const { exportLocalHistory } = await import('./crypto');
        const vault = JSON.parse(await (await exportLocalHistory(UID, {})).text());
        expect(Object.keys(vault.gifFiles ?? {})).not.toContain(ref.id);
        expect(readGifFile).not.toHaveBeenCalledWith(ref.id);
    });
});
