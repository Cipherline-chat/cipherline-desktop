/**
 * secureLocalStore x record binding (electron/record-binding.ts).
 *
 * Drives the REAL main-side KvCrypto through the same bridge shape as
 * secureLocalStore.test.ts, toggling bound writes per "build" to model the
 * phased rollout: records written by today's build, read by a build with bound
 * writes on (migration on read), and read back again by today's build.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureLocalStore, REBIND_DELAY_MS } from './secureLocalStore';
import { KvCrypto, TAG_WRAPPED, TAG_WRAPPED_BOUND } from '../../electron/kv-crypto';

const KEY = Buffer.alloc(32, 7);
const USER = '11111111-1111-4111-8111-111111111111';

function installBuild(writeBound: boolean) {
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => KEY }, { writeBound });
    (globalThis as any).window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: 'ok' })),
        secureKvOpen: vi.fn(async (recs: Array<{ k: string; o: string | null; b: Uint8Array }>) => kv.open(recs)),
        secureKvSeal: vi.fn(async (recs: Array<{ k: string; o: string | null; v: string }>) => kv.seal(recs)),
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

type RawRecord = { o: string | null; b: Uint8Array };

function withKvStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open('cipherline');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('kv_enc', mode);
            const req = fn(tx.objectStore('kv_enc'));
            tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        };
    });
}
const readRaw = (key: string) => withKvStore<RawRecord>('readonly', s => s.get(key) as IDBRequest<RawRecord>);
const writeRaw = (key: string, rec: RawRecord) => withKvStore('readwrite', s => { s.put(rec, key); });

async function rehydrate(writeBound: boolean) {
    secureLocalStore._resetForTest();
    installBuild(writeBound);
    await secureLocalStore.hydrate();
}

const waitForRebind = async () => {
    await new Promise(r => setTimeout(r, REBIND_DELAY_MS + 250));
    await secureLocalStore.flushNow();
};

beforeEach(async () => {
    await wipeDb();
    secureLocalStore._resetForTest();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('secureLocalStore — record binding rollout', () => {
    it('today (bound writes off): records are written in the legacy format and nothing is migrated', async () => {
        await rehydrate(false);
        secureLocalStore.setItem('cipherline_voice_settings', '{"vol":1}');
        await secureLocalStore.flushNow();
        expect((await readRaw('cipherline_voice_settings'))!.b[0]).toBe(TAG_WRAPPED);

        await rehydrate(false);
        await waitForRebind();
        expect((await readRaw('cipherline_voice_settings'))!.b[0]).toBe(TAG_WRAPPED);
    });

    it('phase 2: legacy records are re-written bound on read, values intact, and still readable by a phase-1 build', async () => {
        await rehydrate(false);
        secureLocalStore.setItem('cipherline_user_id', USER);
        secureLocalStore.setItem('cipherline_keybinds', 'ctrl+k');
        await secureLocalStore.flushNow();
        expect((await readRaw('cipherline_keybinds'))!.b[0]).toBe(TAG_WRAPPED);

        await rehydrate(true);
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBe('ctrl+k');
        await waitForRebind();
        const after = (await readRaw('cipherline_keybinds'))!;
        expect(after.b[0]).toBe(TAG_WRAPPED_BOUND);

        // Round-trip through both builds.
        await rehydrate(true);
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBe('ctrl+k');
        expect(secureLocalStore.getItem('cipherline_user_id')).toBe(USER);
        await rehydrate(false);
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBe('ctrl+k');
        expect(secureLocalStore.getItem('cipherline_user_id')).toBe(USER);
    });

    it('migration never rolls back a value written after hydrate', async () => {
        await rehydrate(false);
        secureLocalStore.setItem('cipherline_keybinds', 'old');
        await secureLocalStore.flushNow();

        await rehydrate(true);
        secureLocalStore.setItem('cipherline_keybinds', 'new');
        await waitForRebind();
        await rehydrate(false);
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBe('new');
    });

    it('migration does not resurrect a key removed after hydrate', async () => {
        await rehydrate(false);
        secureLocalStore.setItem('cipherline_keybinds', 'x');
        await secureLocalStore.flushNow();

        await rehydrate(true);
        secureLocalStore.removeItem('cipherline_keybinds');
        await waitForRebind();
        expect(await readRaw('cipherline_keybinds')).toBeUndefined();
    });

    it('a bound record swapped onto another key name does not open there', async () => {
        await rehydrate(true);
        secureLocalStore.setItem('cipherline_keybinds', 'value-A');
        secureLocalStore.setItem('cipherline_voice_settings', 'value-B');
        await secureLocalStore.flushNow();
        const a = (await readRaw('cipherline_keybinds'))!;
        const b = (await readRaw('cipherline_voice_settings'))!;
        await writeRaw('cipherline_keybinds', b);
        await writeRaw('cipherline_voice_settings', a);

        await rehydrate(true);
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBeNull();
        expect(secureLocalStore.getItem('cipherline_voice_settings')).toBeNull();
    });

    it('negative control: legacy records swapped between names DO open under the wrong name', async () => {
        await rehydrate(false);
        secureLocalStore.setItem('cipherline_keybinds', 'value-A');
        secureLocalStore.setItem('cipherline_voice_settings', 'value-B');
        await secureLocalStore.flushNow();
        const a = (await readRaw('cipherline_keybinds'))!;
        const b = (await readRaw('cipherline_voice_settings'))!;
        await writeRaw('cipherline_keybinds', b);
        await writeRaw('cipherline_voice_settings', a);

        await rehydrate(false);
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBe('value-B');
        expect(secureLocalStore.getItem('cipherline_voice_settings')).toBe('value-A');
    });
});
