import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KvCrypto } from '../../electron/kv-crypto';

/**
 * ONE record IndexedDB will not hand back must cost that record, not the store
 * (secureLocalStore: UNREADABLE RECORDS) — and must never be written over.
 *
 * Real store + real main-side KvCrypto + (fake) IndexedDB + real messageStore /
 * dmInbound. The one seam is the read of chosen keys, which fails the way real
 * Chromium fails it when that record's blob file is missing or unreadable —
 * measured 2026-11-23 in Chromium 159 and in our Electron 43:
 *   - the request errors with NotReadableError ("Data lost due to missing
 *     file…") or UnknownError ("Failed to read large IndexedDB value"),
 *   - the transaction then aborts, even with the error's default prevented,
 *   - a cursor over the store fails at that record; getAllKeys still works.
 * The value (not the key) is what cannot be read, so getAllKeys passes through.
 *
 * Every "the record on disk is untouched" is checked against a COLD reboot with
 * the fault cleared, because that is where an overwrite would show: the launch
 * after the file comes back.
 */

const ctl = vi.hoisted(() => ({
    /** key → DOMException name its value read fails with; empty = healthy. */
    bad: new Map<string, string>(),
}));

/** A request whose success is turned into Chromium's failure for that record. */
function failingRead(real: IDBRequest, tx: IDBTransaction, isBad: () => string | null): IDBRequest {
    const h: { onsuccess: ((ev: unknown) => void) | null; onerror: ((ev: unknown) => void) | null } = { onsuccess: null, onerror: null };
    let error: DOMException | null = null;
    const wrapper: IDBRequest = new Proxy(real, {
        get(t, p) {
            if (p === 'onsuccess' || p === 'onerror') return h[p];
            if (p === 'error') return error ?? t.error;
            const v = Reflect.get(t, p, t);
            return typeof v === 'function' ? v.bind(t) : v;
        },
        set(t, p, v) {
            if (p === 'onsuccess' || p === 'onerror') { h[p] = v; return true; }
            return Reflect.set(t, p, v, t);
        },
    });
    real.onsuccess = (ev) => {
        const name = isBad();
        if (name === null) { h.onsuccess?.call(wrapper, ev); return; }
        error = new DOMException(name === 'NotReadableError' ? 'Data lost due to missing file. Affected record should be considered irrecoverable' : 'Failed to read large IndexedDB value', name);
        h.onerror?.call(wrapper, { type: 'error', target: wrapper, preventDefault() {}, stopPropagation() {} });
        try { tx.abort(); } catch { /* already finishing */ }
    };
    return wrapper;
}

vi.mock('./attachmentCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./attachmentCache')>();
    const badName = (key: unknown) => ctl.bad.get(String(key)) ?? null;
    const wrapStore = (store: IDBObjectStore, tx: IDBTransaction): IDBObjectStore => new Proxy(store, {
        get(t, p) {
            if (p === 'get') return (key: IDBValidKey) => failingRead(t.get(key), tx, () => badName(key));
            if (p === 'openCursor') {
                return (...args: unknown[]) => {
                    const real = (t.openCursor as (...a: unknown[]) => IDBRequest<IDBCursorWithValue | null>)(...args);
                    return failingRead(real, tx, () => (real.result ? badName(real.result.key) : null));
                };
            }
            if (p === 'getAll') return () => { throw new Error('test seam: getAll is not modelled'); };
            const v = Reflect.get(t, p, t);
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
    const wrapTx = (tx: IDBTransaction): IDBTransaction => new Proxy(tx, {
        get(t, p) {
            if (p === 'objectStore') return (name: string) => wrapStore(t.objectStore(name), t);
            const v = Reflect.get(t, p, t);
            return typeof v === 'function' ? v.bind(t) : v;
        },
        set(t, p, v) { return Reflect.set(t, p, v, t); },
    });
    return {
        ...actual,
        openDb: async () => {
            const db = await actual.openDb();
            return new Proxy(db, {
                get(t, p) {
                    if (p === 'transaction') return (...a: unknown[]) => wrapTx((t.transaction as (...x: unknown[]) => IDBTransaction)(...a));
                    const v = Reflect.get(t, p, t);
                    return typeof v === 'function' ? v.bind(t) : v;
                },
            });
        },
    };
});

const { secureLocalStore } = await import('./secureLocalStore');
const { openDb, KV_STORE } = await import('./attachmentCache');
const messageStore = await import('./messageStore');
const { commitPulledBatch, persistIncomingDms, PartialPersistError } = await import('./dmInbound');
const { backupStoreBlock } = await import('../services/backupStoreGuard');
const { storeFailureCode, storeHealthSettings, storeLoadFailedEvent } = await import('./storeHealthReport');
const { STORE_LOAD_RETRY_DELAYS_MS } = await import('./storeLoadRetry');

const KEY = Buffer.from(new Uint8Array(32).fill(5));
const USER = '55555555-5555-4555-8555-555555555555';
const PINS = `cipherline_home_pins_${USER}`;
const THREAD = `cipherline_msgs_${USER}_conv-1`;
const OTHER_THREAD = `cipherline_msgs_${USER}_conv-2`;
const GAME_ART = 'cipherline_game_art_v1';
const REAL_PINS = '[{"type":"dm","id":"real-pin"}]';
/** A large record: the kind Chromium keeps as its own blob file. */
const REAL_THREAD = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: `real-${i}`, content: { type: 'text', text: 'x'.repeat(200) } })));
const REAL_OTHER_THREAD = '[{"id":"real-other-message"}]';

type OpenRec = { k: string; o: string | null; b: Uint8Array };
type SealRec = { k: string; o: string | null; v: string };

function installBridge(): void {
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => KEY });
    (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = {
        getLocalMasterKeyStatus: async () => ({ status: 'ok' }),
        secureKvOpen: async (recs: OpenRec[]) => kv.open(recs),
        secureKvSeal: async (recs: SealRec[]) => kv.seal(recs),
    };
}

async function wipeDb(): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve(); req.onerror = () => resolve(); req.onblocked = () => resolve();
    });
}

/** A fresh launch with the values of `bad` failing to read. */
async function boot(bad: Record<string, string> = {}): Promise<void> {
    secureLocalStore._resetForTest();
    messageStore._resetForTest();
    ctl.bad = new Map(Object.entries(bad));
    installBridge();
    await secureLocalStore.hydrate();
    await secureLocalStore.hydrateMessages();
}

/** What the next launch reads, with the fault gone (the file restored). */
async function readFromCleanBoot(key: string): Promise<string | null> {
    await secureLocalStore.flushNow().catch(() => undefined);
    await boot();
    return secureLocalStore.getItem(key);
}

const msg = (id: string, conversation_id: string) =>
    ({ id, content: { type: 'text', text: id }, sender_device_id: 'dev-B', sender_user_id: 'bob', conversation_id });

beforeEach(async () => {
    await wipeDb();
    ctl.bad = new Map();
    secureLocalStore._resetForTest();
    installBridge();
    await secureLocalStore.hydrate();
    secureLocalStore.setItem('cipherline_user_id', USER);
    secureLocalStore.setItem('cipherline_device_id', 'real-device');
    secureLocalStore.setItem('cipherline_token', 'real-token');
    await secureLocalStore.whenAccountReady();
    secureLocalStore.setItem(`cl_hx_${USER}`, '1');
    secureLocalStore.setItem(PINS, REAL_PINS);
    secureLocalStore.setItem(THREAD, REAL_THREAD);
    secureLocalStore.setItem(OTHER_THREAD, REAL_OTHER_THREAD);
    secureLocalStore.setItem(GAME_ART, '{"games":[]}');
    await secureLocalStore.flushNow();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('one unreadable record (a missing blob file) — the load', () => {
    it('control: the seam makes a cursor over the store fail at that record, as Chromium does', async () => {
        ctl.bad = new Map([[THREAD, 'NotReadableError']]);
        const db = await openDb();
        const err = await new Promise<unknown>((resolve) => {
            const tx = db.transaction(KV_STORE, 'readonly');
            const req = tx.objectStore(KV_STORE).openCursor();
            req.onsuccess = () => { const c = req.result; if (!c) resolve(null); else c.continue(); };
            req.onerror = () => resolve(req.error);
        });
        expect((err as DOMException).name).toBe('NotReadableError');
    });

    it('loads everything else: the session, the account, the other history — not StorageReadFailedScreen', async () => {
        await boot({ [THREAD]: 'NotReadableError' });
        expect(secureLocalStore.isStoreUnread()).toBe(false);
        expect(secureLocalStore.hasLoadFailure()).toBe(false);
        expect(secureLocalStore.isAccountReady(USER)).toBe(true);
        expect(secureLocalStore.getItem('cipherline_user_id')).toBe(USER);
        expect(secureLocalStore.getItem('cipherline_token')).toBe('real-token');
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
        expect(secureLocalStore.getItem(OTHER_THREAD)).toBe(REAL_OTHER_THREAD);
        // The unreadable one is not there, and is not passed off as anything.
        expect(secureLocalStore.getItem(THREAD)).toBeNull();
        expect(secureLocalStore.isUnreadable(THREAD)).toBe(true);
        expect(secureLocalStore.unreadableRecordCount()).toBe(1);
    });

    it('reports itself as partial, with labels only (no key)', async () => {
        await boot({ [THREAD]: 'NotReadableError' });
        const health = secureLocalStore.loadHealth();
        expect(health).toEqual({
            status: 'partial',
            lastFailure: { stage: 'read', name: 'NotReadableError', attempts: 1, recovered: true },
            unreadableRecords: 1,
        });
        expect(storeHealthSettings(health, false)).toEqual({
            storage_status: 'partial', storage_load_failure: 'read_NotReadableError',
            storage_load_attempts: 1, storage_load_recovered: true, storage_unreadable_records: 1,
        });
        expect(storeLoadFailedEvent(health)).toEqual({ stage: 'read', name: 'NotReadableError', attempts: 1, recovered: true, unreadable: 1 });
        expect(JSON.stringify(health)).not.toContain('conv-1');
    });

    it('reads past the chunk: one bad record among many still costs only that record', async () => {
        for (let i = 0; i < 150; i++) secureLocalStore.setItem(`cipherline_setting_${String(i).padStart(3, '0')}`, `v${i}`);
        await secureLocalStore.flushNow();
        await boot({ cipherline_setting_070: 'NotReadableError' });
        expect(secureLocalStore.unreadableRecordCount()).toBe(1);
        for (let i = 0; i < 150; i++) {
            if (i !== 70) expect(secureLocalStore.getItem(`cipherline_setting_${String(i).padStart(3, '0')}`)).toBe(`v${i}`);
        }
        expect(secureLocalStore.getItem(THREAD)).toBe(REAL_THREAD);
    });

    it('a device-global record (the game-art cache, the largest master-tier record) is skipped, not fatal', async () => {
        await boot({ [GAME_ART]: 'NotReadableError' });
        expect(secureLocalStore.isStoreUnread()).toBe(false);
        expect(secureLocalStore.getItem(GAME_ART)).toBeNull();
        secureLocalStore.setItem(GAME_ART, '{"games":["stand-in"]}');
        expect(await readFromCleanBoot(GAME_ART)).toBe('{"games":[]}');
    });

    it('a value that reads but is not a record (Chromium: null for an overwritten blob file) is unreadable too', async () => {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(KV_STORE, 'readwrite');
            tx.objectStore(KV_STORE).put(null, PINS);
            tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
        await boot();
        expect(secureLocalStore.isStoreUnread()).toBe(false);
        expect(secureLocalStore.isUnreadable(PINS)).toBe(true);
        expect(secureLocalStore.loadHealth().lastFailure?.name).toBe('MalformedRecord');
    });
});

describe('one unreadable record — never written over', () => {
    it('a write to it stays in memory; the record on disk is untouched', async () => {
        await boot({ [THREAD]: 'NotReadableError' });
        secureLocalStore.setItem(THREAD, '[{"id":"stand-in"}]');
        // Read-after-write in the session still works.
        expect(secureLocalStore.getItem(THREAD)).toBe('[{"id":"stand-in"}]');
        expect(await readFromCleanBoot(THREAD)).toBe(REAL_THREAD);
    });

    it('a delete of it is held too', async () => {
        await boot({ [THREAD]: 'NotReadableError' });
        secureLocalStore.removeItem(THREAD);
        expect(await readFromCleanBoot(THREAD)).toBe(REAL_THREAD);
    });

    it('flushDurable refuses it (so its DM is not ACKed) and names it; other keys are durable', async () => {
        await boot({ [THREAD]: 'NotReadableError' });
        secureLocalStore.setItem(THREAD, '[{"id":"new"}]');
        secureLocalStore.setItem(OTHER_THREAD, '[{"id":"new-other"}]');
        const err = await secureLocalStore.flushDurable([THREAD, OTHER_THREAD]).catch(e => e);
        expect(err?.name).toBe('NotDurableError');
        expect(err.message).toMatch(/not durable/);
        expect(err.keys).toEqual([THREAD]);
        await expect(secureLocalStore.flushDurable([OTHER_THREAD])).resolves.toBeUndefined();
        expect(await readFromCleanBoot(OTHER_THREAD)).toBe('[{"id":"new-other"}]');
    });

    it('scoped to that key: every other write of the account still reaches disk', async () => {
        await boot({ [THREAD]: 'NotReadableError' });
        secureLocalStore.setItem(PINS, '[{"type":"dm","id":"new-pin"}]');
        expect(await readFromCleanBoot(PINS)).toBe('[{"type":"dm","id":"new-pin"}]');
    });

    it('a new DM to that conversation: not ACKed, its month of history not replaced; the rest of the batch IS acked', async () => {
        await boot({ [THREAD]: 'NotReadableError' });
        const toStore = [
            { envelopeId: 'env-1', conversationId: 'conv-1', message: msg('new-1', 'conv-1') },
            { envelopeId: 'env-2', conversationId: 'conv-2', message: msg('new-2', 'conv-2') },
        ];
        const acked: string[][] = [];
        const commit = await commitPulledBatch({
            toStore, ackOnly: [],
            persist: by => persistIncomingDms(USER, by),
            ack: async ids => { acked.push(ids); return { ok: true }; },
        });
        expect(commit.persistError).toBeInstanceOf(PartialPersistError);
        expect([...(commit.persistError as InstanceType<typeof PartialPersistError>).conversationIds]).toEqual(['conv-1']);
        expect(commit.carry.map(c => c.envelopeId)).toEqual(['env-1']);
        expect(commit.stored.map(c => c.envelopeId)).toEqual(['env-2']);
        expect(acked).toEqual([['env-2']]);

        // The persist effect writing the thread state it has (the new message
        // only — it never saw the history) is held the same way.
        messageStore.saveAll('dm', USER, { 'conv-1': [msg('new-1', 'conv-1')], 'conv-2': JSON.parse(secureLocalStore.getItem(OTHER_THREAD)!) });

        // conv-2 got its message on disk; conv-1's real history is exactly as it was.
        const other = JSON.parse((await readFromCleanBoot(OTHER_THREAD))!);
        expect(other.map((m: { id: string }) => m.id)).toContain('new-2');
        expect(secureLocalStore.getItem(THREAD)).toBe(REAL_THREAD);
    });

    it('the message store does not read an unreadable thread as "no history"', async () => {
        await boot({ [THREAD]: 'NotReadableError', [OTHER_THREAD]: 'NotReadableError' });
        // Every thread unreadable: nothing to list, but there IS history here.
        expect(secureLocalStore.keysWithPrefix(`cipherline_msgs_${USER}_`)).toEqual([]);
        expect(await messageStore.hasAny('dm', USER)).toBe(true);
    });

    it('backups are refused while records are unreadable (the backup would drop them)', async () => {
        await boot({ [THREAD]: 'NotReadableError' });
        expect(backupStoreBlock(USER)).toBe('partial');
        await boot();
        expect(backupStoreBlock(USER)).toBeNull();
    });

    it('sign-out drops what was held for it; signing back in once it reads again lets writes flow', async () => {
        await boot({ [THREAD]: 'NotReadableError' });
        secureLocalStore.setItem(THREAD, '[{"id":"stand-in"}]');
        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.isUnreadable(THREAD)).toBe(true);
        // The file is back; the user signs in again in the same run.
        ctl.bad = new Map();
        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.getItem(THREAD)).toBe(REAL_THREAD);
        expect(secureLocalStore.isUnreadable(THREAD)).toBe(false);
        secureLocalStore.setItem(THREAD, '[{"id":"after-recovery"}]');
        expect(await readFromCleanBoot(THREAD)).toBe('[{"id":"after-recovery"}]');
    });

    it('an in-session sign-in that meets an unreadable thread skips and holds it too', async () => {
        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.flushNow();
        await boot({ [THREAD]: 'NotReadableError' });
        // Signed out: the account's records are not loaded, but the key is
        // already known unreadable, and held whoever writes it.
        expect(secureLocalStore.isUnreadable(THREAD)).toBe(true);
        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.isAccountReady(USER)).toBe(true);
        expect(secureLocalStore.getItem(OTHER_THREAD)).toBe(REAL_OTHER_THREAD);
        expect(secureLocalStore.isUnreadable(THREAD)).toBe(true);
        secureLocalStore.setItem(THREAD, '[{"id":"stand-in"}]');
        expect(await readFromCleanBoot(THREAD)).toBe(REAL_THREAD);
    });
});

describe('critical records — still a whole failure, exactly as before', () => {
    it.each(['cipherline_user_id', 'cipherline_token', 'cipherline_device_id'])('%s unreadable: the store is unread (StorageReadFailedScreen)', async (key) => {
        await boot({ [key]: 'NotReadableError' });
        expect(secureLocalStore.isStoreUnread()).toBe(true);
        // Not transient: no retries spent on it.
        expect(secureLocalStore.loadHealth().lastFailure).toEqual({ stage: 'read', name: 'NotReadableError', attempts: 1, recovered: false });
        expect(storeFailureCode(secureLocalStore.loadHealth())).toBe('read/NotReadableError');
        // ...and nothing of the store is written in that session.
        secureLocalStore.setItem(PINS, '[]');
        expect(await readFromCleanBoot(PINS)).toBe(REAL_PINS);
    });

    it('the account’s history marker unreadable: the account fails to load (all of its writes held)', async () => {
        await boot({ [`cl_hx_${USER}`]: 'NotReadableError' });
        expect(secureLocalStore.isStoreUnread()).toBe(false);
        expect(secureLocalStore.hasLoadFailure()).toBe(true);
        expect(secureLocalStore.loadHealth().status).toBe('account_unread');
        secureLocalStore.setItem(PINS, '[]');
        expect(await readFromCleanBoot(PINS)).toBe(REAL_PINS);
    });

    it('the storage policy unreadable: the account fails to load (its defaults would prune readable history)', async () => {
        secureLocalStore.setItem(`cipherline_storage_policy_${USER}`, '{"attachmentRetention":"never"}');
        await secureLocalStore.flushNow();
        await boot({ [`cipherline_storage_policy_${USER}`]: 'NotReadableError' });
        expect(secureLocalStore.loadHealth().status).toBe('account_unread');
    });
});

describe('a transient-looking unreadable record (UnknownError: a file held for a moment)', () => {
    it('is retried like a whole-store refusal, and loads in full once the file is free', async () => {
        secureLocalStore._resetForTest();
        messageStore._resetForTest();
        ctl.bad = new Map([[THREAD, 'UnknownError']]);
        installBridge();
        // The holder lets go after the first attempt.
        const off = secureLocalStore.onLoadRetry(() => { ctl.bad = new Map(); });
        await secureLocalStore.hydrate();
        await secureLocalStore.hydrateMessages();
        off();
        expect(secureLocalStore.unreadableRecordCount()).toBe(0);
        expect(secureLocalStore.getItem(THREAD)).toBe(REAL_THREAD);
        expect(secureLocalStore.loadHealth().lastFailure).toEqual({ stage: 'read', name: 'UnknownError', attempts: 2, recovered: true });
    });

    it('still unreadable after every retry: loads the rest, holds that record (not StorageReadFailedScreen)', async () => {
        await boot({ [THREAD]: 'UnknownError' });
        expect(secureLocalStore.isStoreUnread()).toBe(false);
        expect(secureLocalStore.isUnreadable(THREAD)).toBe(true);
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
        expect(secureLocalStore.loadHealth().lastFailure).toEqual({
            stage: 'read', name: 'UnknownError', attempts: STORE_LOAD_RETRY_DELAYS_MS.length + 1, recovered: true,
        });
        secureLocalStore.setItem(THREAD, '[]');
        expect(await readFromCleanBoot(THREAD)).toBe(REAL_THREAD);
    });
});
