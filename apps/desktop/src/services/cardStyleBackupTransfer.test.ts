import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

/**
 * "My styles" (`cipherline_card_styles_{uid}`) through BOTH existing carriers:
 *   backup:   buildBackupPlan -> writeBackupRecords -> openContainer -> applyBackupContainer
 *   transfer: exportLocalHistory -> importLocalHistory
 * and the read-side re-validation that makes a tampered library harmless.
 */
const mem = new Map<string, string>();
const USER = 'style-user';
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    get length() { return mem.size; },
    key: (i: number) => [...mem.keys()][i] ?? null,
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: (u: string) => u === USER,
    flushNow: async () => {},
};
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));
vi.mock('../utils/attachmentDownload', () => ({ downloadEncryptedAttachment: async () => null }));

const { exportLocalHistory, importLocalHistory } = await import('../utils/crypto');
const { buildBackupPlan, writeBackupRecords, applyBackupContainer } = await import('./backupRecords');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const { readCardStyleLibrary, CARD_LIBRARY_MAX } = await import('../hooks/useCardStylePrefs');

const KEY = `cipherline_card_styles_${USER}`;
const PW = 'pw-for-test';
const lib = (n: number) => ({
    v: 1,
    items: Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, name: `Style ${i}`, style: { v: 1, text: '#ffefd2' } })),
});

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});
beforeEach(() => {
    mem.clear();
    mem.set('cipherline_user_id', USER);
});

async function backupRoundTrip(): Promise<void> {
    const plan = await buildBackupPlan(USER, { includeAttachments: false });
    const container = new MemoryContainer();
    const writer = await ContainerWriter.create(PW, container);
    await writeBackupRecords(plan, { fresh: writer });
    await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
    const opened = await openContainer(memorySource(container.bytes()), PW);
    mem.clear();
    mem.set('cipherline_user_id', USER);
    await applyBackupContainer(USER, opened);
}

describe('card style library: backup and device transfer', () => {
    it('backup restores the library on a fresh device', async () => {
        mem.set(KEY, JSON.stringify(lib(3)));
        await backupRoundTrip();
        expect(readCardStyleLibrary(USER).map(e => e.id)).toEqual(['id-0', 'id-1', 'id-2']);
    });

    it('device transfer (all-in-one vault) carries the library', async () => {
        mem.set(KEY, JSON.stringify(lib(2)));
        const vault = JSON.parse(await (await exportLocalHistory(USER, { rangeDays: null })).text());
        mem.clear();
        mem.set('cipherline_user_id', USER);
        await importLocalHistory(USER, new Blob([JSON.stringify(vault)], { type: 'application/json' }));
        expect(readCardStyleLibrary(USER).map(e => e.name)).toEqual(['Style 0', 'Style 1']);
    });

    it('POSITIVE CONTROL: an empty device restores an empty library', async () => {
        await backupRoundTrip();
        expect(mem.has(KEY)).toBe(false);
        expect(readCardStyleLibrary(USER)).toEqual([]);
    });

    it('a tampered / oversize library restores but is re-validated on read', async () => {
        const hostile = {
            v: 1,
            items: [
                { id: 'ok', name: 'Fine', style: { v: 1, text: '#fff' } },
                { id: 'bad', name: 'Evil', style: 'not-a-style' },
                { id: 7, name: 'numeric id', style: { v: 1, text: '#fff' } },
                { id: 'long', name: 'x'.repeat(500), style: { v: 1, text: '#fff' } },
                ...lib(CARD_LIBRARY_MAX + 20).items.map(i => ({ ...i, id: `x-${i.id}` })),
            ],
        };
        mem.set(KEY, JSON.stringify(hostile));
        await backupRoundTrip();
        const out = readCardStyleLibrary(USER);
        expect(out.length).toBeLessThanOrEqual(CARD_LIBRARY_MAX);
        expect(out.find(e => e.id === 'bad')).toBeUndefined();
        expect(out.find(e => e.id === 'long')?.name.length).toBe(40);
        expect(out.every(e => typeof e.id === 'string')).toBe(true);
    });
});
