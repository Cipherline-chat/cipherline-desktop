import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

/**
 * H1 (LAN transfer security round): a device-to-device TRANSFER merges into local history and never clears it, while a backup
 * RESTORE keeps its authoritative replace. Drives the real chain: raw-key container -> applyBackupContainer -> importLocalHistory
 * -> messageStore, over an in-memory secureLocalStore.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: (u: string) => u === USER,
};
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { applyBackupContainer } = await import('./backupRecords');
const { createVaultHistoryPort } = await import('../utils/nearHistoryPort');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const messageStore = await import('../utils/messageStore');

const USER = 'merge-user';
const K = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const msg = (id: string, ts: string, text = id) => ({ id, content: { type: 'text', text }, sender_device_id: 'd1', sender_user_id: USER, timestamp: ts });
const T = (n: number) => `2026-11-0${n}T10:00:00.000Z`;
type Row = { id: string; content: { text: string } };

async function build(recs: [string, unknown][], topics: unknown[] = []) {
    const sink = new MemoryContainer();
    const w = await ContainerWriter.createRaw(K, sink);
    await w.addJson('meta', { version: 3, userId: USER, topics });
    for (const [id, v] of recs) await w.addJson(id, v);
    await w.finish({ userId: USER, fingerprint: 'near-transfer' });
    return { bytes: sink.bytes(), container: await openContainer(memorySource(sink.bytes()), { rawKey: K }) };
}

beforeAll(() => { Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob, electronAPI: undefined }); });
beforeEach(() => {
    mem.clear();
    messageStore.replaceAll('dm', USER, {
        convB: [msg('b1', T(1)), msg('b2', T(3), 'LOCAL EDIT')],
        convC: [msg('c1', T(2))],            // absent from the container
    });
    messageStore.replaceAll('channel', USER, { chZ: [msg('z1', T(1))] });
    fakeStore.setItem(`cipherline_convs_${USER}`, JSON.stringify([{ conversation_id: 'convC', type: 'dm' }]));
});

const dm = () => messageStore.loadAll('dm', USER);
const ids = (rows: Row[]) => rows.map(m => m.id);

describe('transfer import merges', () => {
    it('a thread absent from the container survives; overlapping ids dedupe with the local copy winning; new rows are added in order', async () => {
        const { container } = await build([
            ['dm:convA:2026-11', [msg('a1', T(1))]],
            ['dm:convB:2026-11', [msg('b1', T(1)), msg('b2', T(3), 'OLD'), msg('b3', T(2))]],
            ['ch:chY:2026-11', [msg('y1', T(1))]],
        ], [{ conversation_id: 'convA', type: 'dm' }]);
        await applyBackupContainer(USER, container, undefined, { merge: true });
        const all = await dm();
        expect(ids(all.convC)).toEqual(['c1']);
        expect(ids(all.convA)).toEqual(['a1']);
        expect(ids(all.convB)).toEqual(['b1', 'b3', 'b2']);
        expect(all.convB.find((m: Row) => m.id === 'b2').content.text).toBe('LOCAL EDIT');
        const ch = await messageStore.loadAll('channel', USER);
        expect(Object.keys(ch).sort()).toEqual(['chY', 'chZ']);
        const topics = JSON.parse(fakeStore.getItem(`cipherline_convs_${USER}`)!).map((t: { conversation_id: string }) => t.conversation_id);
        expect(topics.sort()).toEqual(['convA', 'convC']);
    });

    it('an empty container deletes nothing', async () => {
        const { container } = await build([]);
        await applyBackupContainer(USER, container, undefined, { merge: true });
        expect(Object.keys(await dm()).sort()).toEqual(['convB', 'convC']);
    });

    it('a backup RESTORE (no merge) is unchanged: threads absent from the vault are dropped', async () => {
        const { container } = await build([['dm:convA:2026-11', [msg('a1', T(1))]]]);
        await applyBackupContainer(USER, container);
        expect(Object.keys(await dm())).toEqual(['convA']);
    });

    it('keep-what-arrived merges only the arrived buckets', async () => {
        const { bytes, container } = await build([
            ['dm:convA:2026-11', [msg('a1', T(1))]],
            ['dm:convD:2026-11', [msg('d1', T(1))]],
        ]);
        const byId = new Map(container.index.records.map(r => [r.id, r]));
        const held = ['meta', 'dm:convA:2026-11'].map(id => byId.get(id)!);
        const ranges = held.map(r => [r.offset, r.len] as const);
        const port = createVaultHistoryPort({ userId: USER, transferKey: async () => K.slice() });
        await port.importPartial!(memorySource(bytes), bytes.length, ranges);
        const all = await dm();
        expect(Object.keys(all).sort()).toEqual(['convA', 'convB', 'convC']);   // D did not arrive; B and C untouched
    });
});
