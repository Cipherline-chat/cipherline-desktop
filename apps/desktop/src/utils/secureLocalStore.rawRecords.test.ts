/**
 * secureLocalStore x unauthenticated (TAG_RAW) records.
 *
 * Drives the REAL main-side KvCrypto through the bridge. A TAG_RAW record
 * carries no authentication, so with a master key present it is either a
 * legacy record (accepted on the one migration boot and re-sealed) or a record
 * minted by someone who can write the profile's IndexedDB (refused).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureLocalStore, REBIND_DELAY_MS } from './secureLocalStore';
import { KvCrypto, TAG_RAW, TAG_WRAPPED, TAG_WRAPPED_BOUND, type RawMigrationFlagStore } from '../../electron/kv-crypto';

const KEY = Buffer.alloc(32, 7);
const USER = '11111111-1111-4111-8111-111111111111';

let flagData = new Map<string, string>();
const flags: RawMigrationFlagStore = {
    get: (k) => flagData.get(k) ?? null,
    set: (k, v) => { flagData.set(k, v); },
};

function installBoot() {
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => KEY }, { rawMigrationFlags: flags });
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
const readRec = (key: string) => withKvStore<RawRecord>('readonly', s => s.get(key) as IDBRequest<RawRecord>);
const writeRec = (key: string, rec: RawRecord) => withKvStore('readwrite', s => { s.put(rec, key); });
const rawOf = (v: string) => new Uint8Array([TAG_RAW, ...Buffer.from(v, 'utf8')]);

async function boot() {
    secureLocalStore._resetForTest();
    installBoot();
    await secureLocalStore.hydrate();
}

beforeEach(async () => {
    await wipeDb();
    secureLocalStore._resetForTest();
    flagData = new Map();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('secureLocalStore — unauthenticated raw records', () => {
    it('a legacy raw record is read on the migration boot, re-sealed, and still readable afterwards', async () => {
        // Seed one real record so the store has been opened once.
        await boot();
        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.flushNow();
        // Back-date: pretend this device is on its first boot of the new build.
        flagData = new Map();
        await writeRec('cipherline_keybinds', { o: null, b: rawOf('ctrl+k') });

        await boot();
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBe('ctrl+k');
        await new Promise(r => setTimeout(r, REBIND_DELAY_MS + 250));
        await secureLocalStore.flushNow();
        const tag = (await readRec('cipherline_keybinds'))!.b[0];
        expect([TAG_WRAPPED, TAG_WRAPPED_BOUND]).toContain(tag);

        // Every later boot: still readable (it is sealed now)…
        await boot();
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBe('ctrl+k');
    });

    it('a raw record planted after the migration boot is ignored', async () => {
        await boot(); // migration boot happens (and closes) here
        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.flushNow();

        await writeRec('cipherline_keybinds', { o: null, b: rawOf('planted') });
        await writeRec(`kv_verify_v2_${USER}_victim`, {
            o: USER,
            b: rawOf(JSON.stringify({ v: 2, devices: { rogue: { pub: 'ATTACKER', verified: true } } })),
        });
        await boot();
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBeNull();
        expect(secureLocalStore.getItem(`kv_verify_v2_${USER}_victim`)).toBeNull();
        // Positive control: the authentic record is unaffected.
        expect(secureLocalStore.getItem('cipherline_user_id')).toBe(USER);
    });
});
