import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KvCrypto } from '../../electron/kv-crypto';

/**
 * The boot-time load retries a TRANSIENT refusal before declaring the store
 * unread (storeLoadRetry.ts), and only a transient one.
 *
 * Real store + real main-side KvCrypto + (fake) IndexedDB. The one seam is
 * `openDb`, wrapped so a test can make the next N opens fail with a chosen
 * DOMException — which is what Chromium hands the renderer when another
 * program is holding the LevelDB files ("Internal error opening backing store").
 */

const ctl = vi.hoisted(() => ({
    /** Errors the next opens throw, in order; empty = open normally. */
    openFailures: [] as unknown[],
    /** Errors the next reads (transaction) throw, in order. */
    readFailures: [] as unknown[],
    opens: 0,
}));

vi.mock('./attachmentCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./attachmentCache')>();
    return {
        ...actual,
        openDb: async () => {
            ctl.opens++;
            if (ctl.openFailures.length) throw ctl.openFailures.shift();
            const db = await actual.openDb();
            if (!ctl.readFailures.length) return db;
            const err = ctl.readFailures.shift();
            // A connection whose transaction() throws, like one that is closing.
            return new Proxy(db, {
                get(target, prop) {
                    if (prop === 'transaction') return () => { throw err; };
                    const v = Reflect.get(target, prop, target);
                    return typeof v === 'function' ? v.bind(target) : v;
                },
            });
        },
    };
});

const { secureLocalStore } = await import('./secureLocalStore');
const { STORE_LOAD_RETRY_DELAYS_MS } = await import('./storeLoadRetry');

const KEY = Buffer.from(new Uint8Array(32).fill(9));
const USER = '33333333-3333-4333-8333-333333333333';
const PINS = `cipherline_home_pins_${USER}`;
const REAL_PINS = '[{"type":"dm","id":"real-pin"}]';

type OpenRec = { k: string; o: string | null; b: Uint8Array };
type SealRec = { k: string; o: string | null; v: string };
let ipcFailures: unknown[] = [];

function installBridge(): void {
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => KEY });
    (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = {
        getLocalMasterKeyStatus: async () => ({ status: 'ok' }),
        secureKvOpen: async (recs: OpenRec[]) => {
            if (ipcFailures.length) throw ipcFailures.shift();
            return kv.open(recs);
        },
        secureKvSeal: async (recs: SealRec[]) => kv.seal(recs),
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

const backingStore = () => new DOMException('Internal error opening backing store for indexedDB.open.', 'UnknownError');

/** A fresh launch. */
async function boot(): Promise<number[]> {
    secureLocalStore._resetForTest();
    installBridge();
    const retries: number[] = [];
    secureLocalStore.onLoadRetry(a => retries.push(a));
    await secureLocalStore.hydrate();
    return retries;
}

beforeEach(async () => {
    ctl.openFailures = []; ctl.readFailures = []; ctl.opens = 0; ipcFailures = [];
    await wipeDb();
    // Seed a signed-in account with real data on disk.
    await boot();
    secureLocalStore.setItem('cipherline_user_id', USER);
    await secureLocalStore.whenAccountReady();
    secureLocalStore.setItem(PINS, REAL_PINS);
    await secureLocalStore.flushNow();
    ctl.opens = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); });

describe('secureLocalStore — retrying a transient load failure at boot', () => {
    it('control: a healthy launch loads on the first attempt and never says it is retrying', async () => {
        const retries = await boot();
        expect(retries).toEqual([]);
        expect(secureLocalStore.isStoreUnread()).toBe(false);
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
        expect(secureLocalStore.loadHealth()).toEqual({ status: 'ok', lastFailure: null, unreadableRecords: 0 });
    });

    it('a backing store held for a moment: loads on a later attempt, with the data', async () => {
        ctl.openFailures = [backingStore(), backingStore()];
        const retries = await boot();
        expect(retries).toEqual([1, 2]);
        expect(secureLocalStore.isStoreUnread()).toBe(false);
        expect(secureLocalStore.isAccountReady(USER)).toBe(true);
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
        expect(secureLocalStore.loadHealth()).toEqual({
            status: 'ok',
            lastFailure: { stage: 'open', name: 'UnknownError', attempts: 3, recovered: true },
            unreadableRecords: 0,
        });
    });

    it('a connection closing under the read (InvalidStateError) is retried too', async () => {
        ctl.readFailures = [new DOMException('The database connection is closing.', 'InvalidStateError')];
        const retries = await boot();
        expect(retries).toEqual([1]);
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
        expect(secureLocalStore.loadHealth().lastFailure).toEqual({ stage: 'read', name: 'InvalidStateError', attempts: 2, recovered: true });
    });

    it('main not answering the decrypt for a moment (IPC) is retried', async () => {
        ipcFailures = [new Error("Error invoking remote method 'securekv:open': reply was never sent")];
        const retries = await boot();
        expect(retries).toEqual([1]);
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
        expect(secureLocalStore.loadHealth().lastFailure?.stage).toBe('ipc');
    });

    it('a failure that outlasts every retry: unread after exactly 1 + delays attempts', async () => {
        const attempts = 1 + STORE_LOAD_RETRY_DELAYS_MS.length;
        ctl.openFailures = Array.from({ length: attempts + 2 }, backingStore);
        const retries = await boot();
        expect(retries).toEqual(Array.from({ length: attempts - 1 }, (_, i) => i + 1));
        expect(ctl.opens).toBe(attempts);
        expect(secureLocalStore.isStoreUnread()).toBe(true);
        expect(secureLocalStore.loadHealth()).toEqual({
            status: 'unread',
            lastFailure: { stage: 'open', name: 'UnknownError', attempts, recovered: false },
            unreadableRecords: 0,
        });
    });

    it('a non-transient failure (VersionError) is not retried', async () => {
        ctl.openFailures = [new DOMException('version mismatch', 'VersionError')];
        const retries = await boot();
        expect(retries).toEqual([]);
        expect(ctl.opens).toBe(1);
        expect(secureLocalStore.isStoreUnread()).toBe(true);
        expect(secureLocalStore.loadHealth().lastFailure).toEqual({ stage: 'open', name: 'VersionError', attempts: 1, recovered: false });
    });

    it('the unread session still writes nothing: the data is all there on the next launch', async () => {
        ctl.openFailures = Array.from({ length: 10 }, backingStore);
        await boot();
        expect(secureLocalStore.isStoreUnread()).toBe(true);
        secureLocalStore.setItem('cipherline_user_id', USER);
        secureLocalStore.setItem(PINS, '[]');
        await secureLocalStore.flushNow().catch(() => undefined);
        ctl.openFailures = [];
        await boot();
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
    });

    it('waits between attempts (backoff), so a briefly-held file has time to clear', async () => {
        secureLocalStore._resetForTest();
        installBridge();
        secureLocalStore._setLoadRetryDelaysForTest([40, 80]);
        ctl.openFailures = [backingStore(), backingStore()];
        const t0 = Date.now();
        await secureLocalStore.hydrate();
        expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
    });
});
