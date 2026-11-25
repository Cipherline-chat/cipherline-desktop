import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Split attachment records (`att:<id>:<n>:<m>`, written by the phone core's TRANSFER container for an attachment bigger than one
 * 16 MiB part) are reassembled on import, strictly: every part present, in order, of a sane size, and each part hash-checked by the
 * reader; otherwise the attachment is skipped, counted in `attachmentsIncomplete`, and nothing of it is stored.
 *
 * The first case imports the PHONE's own vector container (`near-v1.json` -> `transfer_container`, native 30ea21d5): its records are
 * `meta`, `att:0f0e0d0c0b0a:1:2`, `att:0f0e0d0c0b0a:2:2`.
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
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));
// The vault import is orthogonal to attachments (and the phone vector's `meta` is a placeholder, not a vault): stubbed here, covered by
// backupHomeState / backupSyncAudit with real vaults.
vi.mock('../utils/crypto', async (orig) => ({ ...(await orig<object>()), importLocalHistory: vi.fn(async () => undefined) }));
const stored = new Map<string, Uint8Array>();
vi.mock('../utils/attachmentCache', async (orig) => ({
    ...(await orig<object>()),
    putEncryptedAttachment: async (id: string, blob: Blob) => { stored.set(id, new Uint8Array(await blob.arrayBuffer())); },
    getEncryptedAttachment: async (id: string) => stored.get(id) ?? null,
}));

const { applyBackupContainer } = await import('./backupRecords');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');

beforeAll(() => { Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob, electronAPI: undefined }); });
beforeEach(() => { mem.clear(); stored.clear(); });

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map(b => parseInt(b, 16)));
const VECTORS = JSON.parse(readFileSync(new URL('../../../desktop-host/vendor/cl-near/test-vectors/near-v1.json', import.meta.url), 'utf8'));
const TC = VECTORS.transfer_container;
const K = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const USER = 'split-user';
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

async function build(recs: [string, Uint8Array][]): Promise<Awaited<ReturnType<typeof openContainer>>> {
    const sink = new MemoryContainer();
    const w = await ContainerWriter.createRaw(K, sink);
    await w.addJson('meta', { version: 1, userId: USER });
    for (const [id, b] of recs) await w.addBytes(id, b);
    await w.finish({ userId: USER, fingerprint: 'near-transfer' });
    return openContainer(memorySource(sink.bytes()), { rawKey: K });
}

describe('importing split attachment records', () => {
    it('the phone\'s own transfer vector: both parts are joined under the attachment id', async () => {
        const c = await openContainer(memorySource(hex(TC.container_hex)), { rawKey: hex(VECTORS.keys.K_xfer_hex) });
        const res = await applyBackupContainer(TC.inputs.user_id, c);
        expect(res).toEqual({ attachmentsApplied: 1, attachmentsIncomplete: 0, unknownSkipped: 0 });
        const want = [...hex(TC.records[1].plain_hex), ...hex(TC.records[2].plain_hex)];
        expect([...stored.get('0f0e0d0c0b0a')!]).toEqual(want);
        expect([...stored.keys()]).toEqual(['0f0e0d0c0b0a']); // never an entry named after a part
    });

    it('whole attachments still import as before, mixed with a split one; the progress ticks once per record', async () => {
        const a = bytes(10, 1), b1 = bytes(8, 2), b2 = bytes(8, 3), b3 = bytes(3, 4);
        const c = await build([['att:whole1', a], ['att:big:1:3', b1], ['att:big:2:3', b2], ['att:big:3:3', b3]]);
        const ticks: number[] = [];
        const res = await applyBackupContainer(USER, c, (d) => ticks.push(d));
        expect(res).toEqual({ attachmentsApplied: 2, attachmentsIncomplete: 0, unknownSkipped: 0 });
        expect([...stored.get('whole1')!]).toEqual([...a]);
        expect([...stored.get('big')!]).toEqual([...b1, ...b2, ...b3]);
        expect(ticks.length).toBe(c.index.records.length);
    });

    it('never overwrites an attachment this device already caches (whole or split); a new one next to it still imports', async () => {
        const mine = bytes(5, 99);
        stored.set('whole1', mine); stored.set('big', mine);
        const c = await build([['att:whole1', bytes(10, 1)], ['att:big:1:2', bytes(8, 2)], ['att:big:2:2', bytes(8, 3)], ['att:fresh', bytes(4, 5)]]);
        const res = await applyBackupContainer(USER, c, undefined, { merge: true });
        expect(res.attachmentsIncomplete).toBe(0);
        expect([...stored.get('whole1')!]).toEqual([...mine]);
        expect([...stored.get('big')!]).toEqual([...mine]);
        expect([...stored.get('fresh')!]).toEqual([...bytes(4, 5)]);
    });

    const cases: [string, [string, Uint8Array][], string][] = [
        ['a missing part', [['att:x:1:3', bytes(8, 1)], ['att:x:3:3', bytes(2, 3)]], 'x'],
        ['only the first part arrived (keep what arrived)', [['att:x:1:2', bytes(8, 1)]], 'x'],
        ['parts out of order in the index', [['att:x:2:2', bytes(2, 2)], ['att:x:1:2', bytes(8, 1)]], 'x'],
        ['a middle part of another size', [['att:x:1:3', bytes(8, 1)], ['att:x:2:3', bytes(5, 2)], ['att:x:3:3', bytes(2, 3)]], 'x'],
        ['a last part larger than the first', [['att:x:1:2', bytes(4, 1)], ['att:x:2:2', bytes(9, 2)]], 'x'],
        ['an empty part', [['att:x:1:2', bytes(4, 1)], ['att:x:2:2', bytes(0, 2)]], 'x'],
        ['parts that disagree on m', [['att:x:1:2', bytes(4, 1)], ['att:x:2:3', bytes(4, 2)]], 'x'],
        ['a "1 of 1" form (never written: whole attachments are att:<id>)', [['att:x:1:1', bytes(4, 1)]], 'x'],
        ['n past m', [['att:x:1:2', bytes(4, 1)], ['att:x:3:2', bytes(4, 2)]], 'x'],
        ['n = 0', [['att:x:0:2', bytes(4, 1)], ['att:x:1:2', bytes(4, 2)]], 'x'],
        ['non-canonical numbers', [['att:x:01:02', bytes(4, 1)], ['att:x:02:02', bytes(4, 2)]], 'x'],
        ['a whole record of the same id next to parts', [['att:x', bytes(4, 0)], ['att:x:1:2', bytes(4, 1)], ['att:x:2:2', bytes(4, 2)]], ''],
        ['an id with extra colons', [['att:a:b:c:d', bytes(4, 1)]], 'a:b:c'],
    ];
    for (const [name, recs, key] of cases) {
        it(`never imports a truncated or malformed attachment as complete: ${name}`, async () => {
            const c = await build(recs);
            const res = await applyBackupContainer(USER, c);
            expect(res.attachmentsIncomplete).toBeGreaterThanOrEqual(1);
            // nothing of a split attachment is stored; in the conflict case only the whole record of the same id is
            if (key === '') expect([...stored.keys()]).toEqual(['x']);
            else expect(stored.size).toBe(0);
            if (key === '') expect([...stored.get('x')!]).toEqual([...bytes(4, 0)]);
        });
    }

    it('a part whose bytes were altered after sealing fails the read and leaves nothing behind', async () => {
        const sink = new MemoryContainer();
        const w = await ContainerWriter.createRaw(K, sink);
        await w.addJson('meta', { version: 1, userId: USER });
        await w.addBytes('att:x:1:2', bytes(8, 1));
        await w.addBytes('att:x:2:2', bytes(4, 2));
        await w.finish({ userId: USER, fingerprint: 'near-transfer' });
        const raw = sink.bytes();
        const c = await openContainer(memorySource(raw), { rawKey: K });
        const p2 = c.index.records.find(r => r.id === 'att:x:2:2')!;
        raw[p2.offset + 20] ^= 1; // inside the sealed part
        const res = await applyBackupContainer(USER, c);
        expect(res).toMatchObject({ attachmentsApplied: 0, attachmentsIncomplete: 1 });
        expect(stored.size).toBe(0);
    });

    it('a stopped transfer: records outside the held ranges are not offered, so a split attachment missing parts is counted, not stored', async () => {
        const c = await build([['att:x:1:2', bytes(8, 1)], ['att:x:2:2', bytes(4, 2)], ['att:y', bytes(5, 9)]]);
        const held = { ...c, index: { ...c.index, records: c.index.records.filter(r => r.id !== 'att:x:2:2') } };
        const res = await applyBackupContainer(USER, held);
        expect(res).toMatchObject({ attachmentsApplied: 1, attachmentsIncomplete: 1 });
        expect([...stored.keys()]).toEqual(['y']);
    });
});
