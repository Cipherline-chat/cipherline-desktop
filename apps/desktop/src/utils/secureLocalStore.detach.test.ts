import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureLocalStore } from './secureLocalStore';
import * as messageStore from './messageStore';
import { applyIncomingDmMessages } from './dmInbound';
import { KvCrypto } from '../../electron/kv-crypto';

/**
 * Detached values: message-history JSON leaves the renderer's memory once it is
 * on disk, because messageStore holds the same threads parsed and can serialise
 * them again. This is a memory optimisation over the ONLY local copy of a
 * user's messages, so every test here is about not losing or leaking a byte:
 * real store + real main-side KvCrypto + (fake) IndexedDB + real messageStore,
 * and every "after" is checked against a COLD reload from disk, which is what
 * the next launch will see.
 */

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

type SealRecs = Array<{ k: string; o: string | null; v: string }>;
type Bridge = {
    getLocalMasterKeyStatus: () => Promise<{ status: string }>;
    secureKvOpen: (r: Array<{ k: string; o: string | null; b: Uint8Array }>) => Promise<unknown>;
    secureKvSeal: (r: SealRecs) => Promise<Array<{ k: string; b: Uint8Array | null }>>;
};
const bridge = (): Bridge => (globalThis as unknown as { window: { electronAPI: Bridge } }).window.electronAPI;

function installBridge(): void {
    const key = Buffer.from(KEY_B64, 'base64');
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => key });
    (globalThis as unknown as { window: { electronAPI: Bridge } }).window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: 'ok' })),
        secureKvOpen: vi.fn(async (recs) => kv.open(recs)),
        secureKvSeal: vi.fn(async (recs: SealRecs) => kv.seal(recs)),
    };
}

async function wipeDb(): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
    });
}

/** A fresh launch: nothing in memory, everything read back from disk. */
async function coldBoot(): Promise<void> {
    secureLocalStore._resetForTest();
    messageStore._resetForTest();
    installBridge();
    await secureLocalStore.hydrate();
    await secureLocalStore.hydrateMessages();
}

const dmKey = (cid: string) => `cipherline_msgs_${USER}_${cid}`;
const chKey = (cid: string) => `cipherline_channel_msgs_${USER}_${cid}`;
const msg = (id: string, text = `text ${id} 🎉`) => ({ id, content: { type: 'text', text }, sender_user_id: OTHER, timestamp: '2026-10-01T00:00:00.000Z' });
/** Is the record's plaintext still sitting in the store's map? */
const inMap = (key: string): boolean => (secureLocalStore as unknown as { map: Map<string, string> }).map.has(key);

/** An account with two DM threads and one channel, persisted and cold-booted. */
async function seedAccount(): Promise<void> {
    await secureLocalStore.hydrate();
    secureLocalStore.setItem('cipherline_user_id', USER);
    await secureLocalStore.whenAccountReady();
    messageStore.saveAll('dm', USER, { a: [msg('a1'), msg('a2')], b: [msg('b1')] });
    messageStore.saveAll('channel', USER, { c: [msg('c1')] });
    await secureLocalStore.flushNow();
    await coldBoot();
}

beforeEach(async () => {
    await wipeDb();
    secureLocalStore._resetForTest();
    messageStore._resetForTest();
    installBridge();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('secureLocalStore detached values — memory', () => {
    it('drops thread JSON from memory once loadAll has parsed it, and still answers every read', async () => {
        await seedAccount();
        // Phase 2 put the text in memory...
        expect(inMap(dmKey('a'))).toBe(true);
        const dms = await messageStore.loadAll('dm', USER);
        const chans = await messageStore.loadAll('channel', USER);
        expect(dms).toEqual({ a: [msg('a1'), msg('a2')], b: [msg('b1')] });
        expect(chans).toEqual({ c: [msg('c1')] });
        // ...and loadAll let it go.
        for (const k of [dmKey('a'), dmKey('b'), chKey('c')]) {
            expect(inMap(k)).toBe(false);
            expect(secureLocalStore.isDetached(k)).toBe(true);
        }
        // Still present to every reader.
        expect(JSON.parse(secureLocalStore.getItem(dmKey('a'))!)).toEqual([msg('a1'), msg('a2')]);
        expect(secureLocalStore.keysWithPrefix(`cipherline_msgs_${USER}_`).sort()).toEqual([dmKey('a'), dmKey('b')]);
        expect(await messageStore.hasAny('dm', USER)).toBe(true);
        expect(secureLocalStore.length).toBeGreaterThanOrEqual(3);
    });

    it('keeps a new write in memory until it is on disk, then drops it', async () => {
        await seedAccount();
        await messageStore.loadAll('dm', USER);
        messageStore.saveAll('dm', USER, { a: [msg('a1'), msg('a2'), msg('a3')], b: [msg('b1')] });
        // Dirty: the only copy of the newest value that the flush will read.
        expect(inMap(dmKey('a'))).toBe(true);
        expect(secureLocalStore.isDetached(dmKey('a'))).toBe(false);
        await secureLocalStore.flushNow();
        expect(inMap(dmKey('a'))).toBe(false);
        expect(secureLocalStore.isDetached(dmKey('a'))).toBe(true);
        // And the disk has it.
        await coldBoot();
        expect((await messageStore.loadAll('dm', USER)).a).toEqual([msg('a1'), msg('a2'), msg('a3')]);
    });

    it('does not detach values written by anyone but the owner (legacy record, other prefixes)', async () => {
        await seedAccount();
        secureLocalStore.setItem(`cipherline_msgs_${USER}`, '{"legacy":[]}');
        secureLocalStore.setItem(`cipherline_convs_${USER}`, '[]');
        secureLocalStore.markDetachable(`cipherline_convs_${USER}`); // no source for this prefix
        await secureLocalStore.flushNow();
        expect(inMap(`cipherline_msgs_${USER}`)).toBe(true);
        expect(inMap(`cipherline_convs_${USER}`)).toBe(true);
    });
});

describe('secureLocalStore detached values — never lose or leak data', () => {
    it('a direct setItem over a detached key wins, and is what reaches disk', async () => {
        await seedAccount();
        await messageStore.loadAll('dm', USER);
        expect(secureLocalStore.isDetached(dmKey('a'))).toBe(true);
        secureLocalStore.setItem(dmKey('a'), JSON.stringify([msg('z9')]));
        expect(secureLocalStore.isDetached(dmKey('a'))).toBe(false);
        expect(JSON.parse(secureLocalStore.getItem(dmKey('a'))!)).toEqual([msg('z9')]);
        await secureLocalStore.flushNow();
        // Not vouched for by the owner, so it stays in memory.
        expect(inMap(dmKey('a'))).toBe(true);
        await coldBoot();
        expect(JSON.parse(secureLocalStore.getItem(dmKey('a'))!)).toEqual([msg('z9')]);
    });

    it('a failed flush is retried with the regenerated value even if the key was detached meanwhile', async () => {
        await seedAccount();
        await messageStore.loadAll('dm', USER);
        const api = bridge();
        const realSeal = api.secureKvSeal;
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        let failOnce = true;
        api.secureKvSeal = vi.fn(async (recs: SealRecs) => {
            await gate;
            if (failOnce) { failOnce = false; return recs.map(r => ({ k: r.k, b: null })); }
            return realSeal(recs);
        });

        messageStore.saveAll('dm', USER, { a: [msg('a1'), msg('a2'), msg('NEW')], b: [msg('b1')] });
        const first = secureLocalStore.flushNow();          // takes `a` off the dirty set, then blocks
        await Promise.resolve();
        // While that write is in flight, a reader vouches for the same value
        // (a backup export's loadAll) — the key is not dirty, so it detaches.
        await messageStore.loadAll('dm', USER);
        expect(secureLocalStore.isDetached(dmKey('a'))).toBe(true);
        release();
        await first;                                       // sealed nothing: `a` re-queued
        await secureLocalStore.flushNow();                 // retry must regenerate and write it
        await coldBoot();
        expect((await messageStore.loadAll('dm', USER)).a).toEqual([msg('a1'), msg('a2'), msg('NEW')]);
    });

    it('removeItem on a detached thread deletes it for good', async () => {
        await seedAccount();
        await messageStore.loadAll('dm', USER);
        await messageStore.removeThread('dm', USER, 'b');
        expect(secureLocalStore.getItem(dmKey('b'))).toBeNull();
        expect(secureLocalStore.keysWithPrefix(`cipherline_msgs_${USER}_`)).toEqual([dmKey('a')]);
        await secureLocalStore.flushNow();
        await coldBoot();
        expect(Object.keys(await messageStore.loadAll('dm', USER))).toEqual(['a']);
    });

    it('sign-out takes detached history out of reach, and signing back in restores it from disk', async () => {
        await seedAccount();
        await messageStore.loadAll('dm', USER);
        expect(secureLocalStore.isDetached(dmKey('a'))).toBe(true);
        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.isDetached(dmKey('a'))).toBe(false);
        expect(secureLocalStore.getItem(dmKey('a'))).toBeNull();
        expect(secureLocalStore.keysWithPrefix(`cipherline_msgs_${USER}_`)).toEqual([]);

        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.whenAccountReady();
        expect(await messageStore.loadAll('dm', USER)).toEqual({ a: [msg('a1'), msg('a2')], b: [msg('b1')] });
    });

    it('clear() tombstones detached keys too', async () => {
        await seedAccount();
        await messageStore.loadAll('dm', USER);
        secureLocalStore.clear();
        expect(secureLocalStore.getItem(dmKey('a'))).toBeNull();
        expect(secureLocalStore.length).toBe(0);
        await secureLocalStore.flushNow();
        await coldBoot();
        expect(secureLocalStore.getItem(dmKey('a'))).toBeNull();
    });

    it('mergeThreads onto a detached thread merges onto the stored history, not onto nothing', async () => {
        await seedAccount();
        await messageStore.loadAll('dm', USER);
        expect(secureLocalStore.isDetached(dmKey('a'))).toBe(true);
        const keys = await messageStore.mergeThreads('dm', USER, { a: [msg('a3')] }, applyIncomingDmMessages);
        await secureLocalStore.flushDurable(keys);
        expect(secureLocalStore.isDetached(dmKey('a'))).toBe(true);
        await coldBoot();
        expect((await messageStore.loadAll('dm', USER)).a.map((m: { id: string }) => m.id)).toEqual(['a1', 'a2', 'a3']);
    });

    it('a backup-style loadAll of detached threads returns the same data as a cold load', async () => {
        await seedAccount();
        const boot = await messageStore.loadAll('dm', USER);
        const again = await messageStore.loadAll('dm', USER);   // served from the parsed copy
        expect(again).toEqual(boot);
        await coldBoot();
        expect(await messageStore.loadAll('dm', USER)).toEqual(again);
    });
});
