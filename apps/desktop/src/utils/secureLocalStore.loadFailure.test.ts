import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { secureLocalStore } from './secureLocalStore';
import { openDb, KV_STORE } from './attachmentCache';
import * as messageStore from './messageStore';
import { recordRun } from './flappyBest';
import { KvCrypto } from '../../electron/kv-crypto';

/**
 * A batch decrypt that FAILED is not an account with no data.
 *
 * Real store + real main-side KvCrypto + (fake) IndexedDB. The only thing
 * faked is the failure itself: `secureKvOpen` rejecting, which is what the
 * renderer sees when main's handler throws before it reaches its own try
 * (`await secureStore.initialize()`) or the IPC itself fails. Every "after" is
 * checked against a COLD reload from disk, because that is where the loss
 * would show: the next launch.
 */

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const USER = '11111111-1111-4111-8111-111111111111';
const PINS = `cipherline_home_pins_${USER}`;
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const THREAD = `cipherline_msgs_${USER}_conv-1`;
const OTHER_THREAD = `cipherline_msgs_${USER}_conv-2`;
const REAL_PINS = '[{"type":"dm","id":"real-pin"}]';
const REAL_THREAD = '[{"id":"real-message"}]';
const REAL_OTHER_THREAD = '[{"id":"real-other-message"}]';

type OpenRec = { k: string; o: string | null; b: Uint8Array };
type SealRec = { k: string; o: string | null; v: string };
type Bridge = {
    getLocalMasterKeyStatus: () => Promise<{ status: string }>;
    secureKvOpen: (r: OpenRec[]) => Promise<Array<{ k: string; v: string | null }>>;
    secureKvSeal: (r: SealRec[]) => Promise<Array<{ k: string; b: Uint8Array | null }>>;
};
const win = () => (globalThis as unknown as { window: { electronAPI: Bridge } }).window;

/** Which batches fail. Mutable, so a test can make main recover mid-session. */
let failOpen: (recs: OpenRec[]) => boolean = () => false;

function installBridge(): void {
    const key = Buffer.from(KEY_B64, 'base64');
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => key });
    win().electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: 'ok' })),
        secureKvOpen: vi.fn(async (recs: OpenRec[]) => {
            if (failOpen(recs)) throw new Error('Error invoking remote method securekv:open');
            return kv.open(recs);
        }),
        secureKvSeal: vi.fn(async (recs: SealRec[]) => kv.seal(recs)),
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

const hasOwned = (recs: OpenRec[]) => recs.some(r => r.o === USER && !r.k.startsWith('cipherline_msgs_'));
const hasThread = (recs: OpenRec[]) => recs.some(r => r.k.startsWith('cipherline_msgs_'));
const hasMaster = (recs: OpenRec[]) => recs.some(r => r.o === null);

/** A signed-in account with real pins and a real thread on disk. */
async function seed(): Promise<void> {
    await secureLocalStore.hydrate();
    secureLocalStore.setItem('cipherline_user_id', USER);
    secureLocalStore.setItem('cipherline_device_id', 'real-device');
    await secureLocalStore.whenAccountReady();
    secureLocalStore.setItem(PINS, REAL_PINS);
    secureLocalStore.setItem(THREAD, REAL_THREAD);
    secureLocalStore.setItem(OTHER_THREAD, REAL_OTHER_THREAD);
    await secureLocalStore.flushNow();
}

/** A fresh launch, with whichever batches `fail` selects failing. */
async function boot(fail: (recs: OpenRec[]) => boolean = () => false): Promise<void> {
    secureLocalStore._resetForTest();
    messageStore._resetForTest();
    failOpen = fail;
    installBridge();
    await secureLocalStore.hydrate();
}

/** What the next launch would read, with main healthy again. */
async function readFromCleanBoot(key: string): Promise<string | null> {
    await secureLocalStore.flushNow().catch(() => undefined);
    await boot();
    await secureLocalStore.hydrateMessages();
    return secureLocalStore.getItem(key);
}

beforeEach(async () => {
    await wipeDb();
    secureLocalStore._resetForTest();
    failOpen = () => false;
    installBridge();
    await seed();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('secureLocalStore — a failed batch decrypt at boot', () => {
    it('does not report the account as ready', async () => {
        await boot(hasOwned);
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.isAccountReady(USER)).toBe(false);
    });

    it('a persist effect guarded by isAccountReady cannot overwrite the real record', async () => {
        await boot(hasOwned);
        await secureLocalStore.whenAccountReady();

        // Dashboard's home-pins effect, verbatim in shape: load, then write back.
        let pins: unknown[] = [];
        try { pins = JSON.parse(secureLocalStore.getItem(PINS) || '[]'); } catch { /* empty */ }
        if (secureLocalStore.isAccountReady(USER)) secureLocalStore.setItem(PINS, JSON.stringify(pins));

        expect(await readFromCleanBoot(PINS)).toBe(REAL_PINS);
    });

    it('an UNGUARDED write cannot overwrite a record that failed to load either', async () => {
        await boot(hasOwned);
        await secureLocalStore.whenAccountReady();

        // Most of the ~520 setItem call sites have no readiness check at all.
        secureLocalStore.setItem(PINS, '[]');

        expect(await readFromCleanBoot(PINS)).toBe(REAL_PINS);
    });

    it('a removeItem cannot delete a record that failed to load', async () => {
        await boot(hasOwned);
        await secureLocalStore.whenAccountReady();

        secureLocalStore.removeItem(PINS);

        expect(await readFromCleanBoot(PINS)).toBe(REAL_PINS);
    });

    it('a thread that never got its turn to decrypt cannot be overwritten', async () => {
        // Phase 1 failed, so the Dashboard's restore bails and never calls
        // hydrateMessages(): the thread is neither loaded nor known to have
        // failed, but a sent DM's save reaches it all the same.
        await boot(hasOwned);
        await secureLocalStore.whenAccountReady();

        messageStore.saveAll('dm', USER, { 'conv-1': [{ id: 'just-sent' }] });

        expect(await readFromCleanBoot(THREAD)).toBe(REAL_THREAD);
    });

    it('session pointers and device settings keep saving, so a rotated refresh token is not lost', async () => {
        await boot(hasOwned);
        await secureLocalStore.whenAccountReady();

        secureLocalStore.setItem('cipherline_refresh_token', 'rotated');
        secureLocalStore.setItem('cipherline_voice_settings', '{"vol":1}');

        expect(await readFromCleanBoot('cipherline_refresh_token')).toBe('rotated');
        expect(secureLocalStore.getItem('cipherline_voice_settings')).toBe('{"vol":1}');
    });

    it('resolves whenAccountReady, keeps the session\'s own writes readable, and never blocks boot', async () => {
        await boot(hasOwned);
        await expect(secureLocalStore.whenAccountReady()).resolves.toBeUndefined();

        secureLocalStore.setItem(PINS, '[{"type":"dm","id":"this-session"}]');

        expect(secureLocalStore.getItem(PINS)).toBe('[{"type":"dm","id":"this-session"}]');
        expect(secureLocalStore.isLocked()).toBe(false);
    });

    it('recovers on the next launch with nothing lost', async () => {
        await boot(hasOwned);
        secureLocalStore.setItem(PINS, '[]');
        await secureLocalStore.flushNow();

        await boot();

        expect(secureLocalStore.isAccountReady(USER)).toBe(true);
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
    });
});

describe('secureLocalStore — what a caller sees in that state', () => {
    it('flushDurable refuses for a held record, so a DM stays on the server instead of being ACKed', async () => {
        await boot(hasOwned);
        secureLocalStore.setItem(THREAD, '[{"id":"delivered"}]');

        await expect(secureLocalStore.flushDurable([THREAD])).rejects.toThrow(/not durable/);
    });

    it('messageStore says "not readable", not "no history"', async () => {
        await boot(hasOwned);
        await expect(messageStore.loadAll('dm', USER)).rejects.toThrow(messageStore.HistoryNotReadableError);
    });

    it('a point scored in the Firewall game neither hangs nor writes over the best score', async () => {
        const bestKey = `cipherline_firewall_best_${USER}`;
        secureLocalStore.setItem(bestKey, '40');
        await secureLocalStore.flushNow();
        await boot(hasOwned);

        recordRun(USER, 5, 1000);
        await new Promise(resolve => setTimeout(resolve, 0)); // only reached if the microtasks settle

        expect(await readFromCleanBoot(bestKey)).toBe('40');
    });

    it('reports the failure to a listener once, whether it subscribed before or after', async () => {
        await boot(() => false);
        const before = vi.fn();
        secureLocalStore.onLoadFailure(before);
        expect(before).not.toHaveBeenCalled();

        failOpen = hasThread;
        await secureLocalStore.hydrateMessages();
        expect(before).toHaveBeenCalledTimes(1);

        const after = vi.fn();
        secureLocalStore.onLoadFailure(after);
        expect(after).toHaveBeenCalledTimes(1);
    });

    it('a healthy load reports nothing', async () => {
        await boot();
        await secureLocalStore.hydrateMessages();
        const listener = vi.fn();
        secureLocalStore.onLoadFailure(listener);
        expect(listener).not.toHaveBeenCalled();
        expect(secureLocalStore.isAccountReady(USER)).toBe(true);
    });
});

describe('secureLocalStore — one bad record is still only one bad record', () => {
    it('skips it, loads the rest, and the account is ready', async () => {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(KV_STORE, 'readwrite');
            tx.objectStore(KV_STORE).put({ o: USER, b: new Uint8Array([1, 2, 3]) }, `cipherline_bad_${USER}`);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        await boot();

        expect(secureLocalStore.isAccountReady(USER)).toBe(true);
        expect(secureLocalStore.getItem(`cipherline_bad_${USER}`)).toBeNull();
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
    });
});

describe('secureLocalStore — the whole store failing to load at boot', () => {
    it('a master-tier failure holds every write, so the real session pointers survive', async () => {
        await boot(hasMaster);
        await secureLocalStore.whenAccountReady();

        expect(secureLocalStore.isStoreUnread()).toBe(true);
        expect(secureLocalStore.getItem('cipherline_user_id')).toBeNull();
        // AuthContext.login() in shape: no pointer in memory, so it writes new ones.
        secureLocalStore.setItem('cipherline_device_id', 'freshly-registered-device');

        expect(await readFromCleanBoot('cipherline_device_id')).toBe('real-device');
        expect(secureLocalStore.getItem('cipherline_user_id')).toBe(USER);
        expect(secureLocalStore.isStoreUnread()).toBe(false);
    });

    it('an IndexedDB read failure is treated the same way', async () => {
        secureLocalStore._resetForTest();
        installBridge();
        vi.spyOn(secureLocalStore as unknown as { readAllRecords: () => Promise<unknown> }, 'readAllRecords')
            .mockRejectedValueOnce(new Error('IndexedDB refused the read'));
        await secureLocalStore.hydrate();

        expect(secureLocalStore.isStoreUnread()).toBe(true);
        secureLocalStore.setItem('cipherline_device_id', 'freshly-registered-device');
        expect(await readFromCleanBoot('cipherline_device_id')).toBe('real-device');
    });

    it('a sign-in after it works in memory but does not report ready, because the app built on unread state', async () => {
        await boot(hasMaster);
        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.whenAccountReady();

        expect(secureLocalStore.getItem('cipherline_user_id')).toBe(USER);
        expect(secureLocalStore.isAccountReady(USER)).toBe(false);
    });

    it('signing out sticks: the old session does not come back on the next launch', async () => {
        await boot(hasMaster);

        secureLocalStore.removeItem('cipherline_token');
        secureLocalStore.removeItem('cipherline_user_id');
        secureLocalStore.removeItem('cipherline_device_id');

        expect(await readFromCleanBoot('cipherline_user_id')).toBeNull();
        expect(secureLocalStore.getItem('cipherline_device_id')).toBeNull();
    });
});

describe('secureLocalStore — a failed batch decrypt on an in-session sign-in', () => {
    async function signIn(fail: (recs: OpenRec[]) => boolean): Promise<void> {
        await boot();
        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.whenAccountReady();
        failOpen = fail;
        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.whenAccountReady();
    }

    it('does not report the account as ready', async () => {
        await signIn(hasOwned);
        expect(secureLocalStore.isAccountReady(USER)).toBe(false);
    });

    it('cannot overwrite the real record', async () => {
        await signIn(hasOwned);
        secureLocalStore.setItem(PINS, '[]');
        expect(await readFromCleanBoot(PINS)).toBe(REAL_PINS);
    });

    it('signing out and back in recovers, and the held writes do not outlive the hold', async () => {
        await signIn(hasOwned);
        secureLocalStore.setItem(PINS, '[]');

        failOpen = () => false;
        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.whenAccountReady();
        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.whenAccountReady();

        expect(secureLocalStore.isAccountReady(USER)).toBe(true);
        expect(secureLocalStore.getItem(PINS)).toBe(REAL_PINS);
        expect(await readFromCleanBoot(PINS)).toBe(REAL_PINS);
    });

    it('a failure from a switch the user has left says nothing about the account they moved to', async () => {
        await boot();
        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.whenAccountReady();

        // A's load is stuck in main while the user moves on to B.
        let rejectA: (e: Error) => void = () => {};
        const open = win().electronAPI.secureKvOpen;
        win().electronAPI.secureKvOpen = vi.fn((recs: OpenRec[]) => (
            hasOwned(recs) ? new Promise<never>((_, reject) => { rejectA = reject; }) : open(recs)
        ));
        secureLocalStore.setItem('cipherline_user_id', USER);
        await new Promise(resolve => setTimeout(resolve, 20));
        secureLocalStore.setItem('cipherline_user_id', OTHER_USER);
        await secureLocalStore.whenAccountReady();

        rejectA(new Error('Error invoking remote method securekv:open'));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(secureLocalStore.isAccountReady(OTHER_USER)).toBe(true);
        secureLocalStore.setItem(`cipherline_home_pins_${OTHER_USER}`, '["b"]');
        expect(await secureLocalStore.flushDurable([`cipherline_home_pins_${OTHER_USER}`])).toBeUndefined();
    });
});

describe('secureLocalStore — a failed batch decrypt of message history (phase 2)', () => {
    it('does not report the account as ready', async () => {
        await boot(hasThread);
        await secureLocalStore.hydrateMessages();
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.isAccountReady(USER)).toBe(false);
    });

    it('a new message cannot replace the thread it failed to load', async () => {
        await boot(hasThread);
        await secureLocalStore.hydrateMessages();

        secureLocalStore.setItem(THREAD, '[{"id":"only-the-new-message"}]');

        expect(await readFromCleanBoot(THREAD)).toBe(REAL_THREAD);
    });

    it('a thread that DID decrypt is held too: the failure blanks React state for all of them', async () => {
        // Only the batch holding conv-1 fails. loadAll then throws for the whole
        // account, so state starts empty and a sent DM's save would replace
        // conv-2 with just that one message, even though conv-2 loaded fine.
        await boot(recs => recs.some(r => r.k === THREAD));
        await secureLocalStore.hydrateMessages();
        await expect(messageStore.loadAll('dm', USER)).rejects.toThrow(messageStore.HistoryNotReadableError);

        messageStore.saveAll('dm', USER, { 'conv-2': [{ id: 'just-sent' }] });

        expect(await readFromCleanBoot(OTHER_THREAD)).toBe(REAL_OTHER_THREAD);
    });

    it('a batch that rejects after the account has signed out does not mark the next one', async () => {
        let rejectBatch: (e: Error) => void = () => {};
        await boot();
        const open = win().electronAPI.secureKvOpen;
        win().electronAPI.secureKvOpen = vi.fn((recs: OpenRec[]) => (
            hasThread(recs) ? new Promise<never>((_, reject) => { rejectBatch = reject; }) : open(recs)
        ));
        const phase2 = secureLocalStore.hydrateMessages();

        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.whenAccountReady();
        secureLocalStore.setItem('cipherline_user_id', OTHER_USER);
        await secureLocalStore.whenAccountReady();

        rejectBatch(new Error('Error invoking remote method securekv:open'));
        await phase2;

        expect(secureLocalStore.isAccountReady(OTHER_USER)).toBe(true);
    });
});

describe('main process — securekv:open', () => {
    it('rejects when the whole batch throws, instead of answering null for every record', () => {
        // Null means "this one record is unreadable, skip it", so a batch of them
        // would be this same bug one process over, and a renderer test cannot see it.
        const main = fs.readFileSync(path.join(__dirname, '../../electron/main.ts'), 'utf8');
        const start = main.indexOf("ipcMain.handle('securekv:open'");
        expect(start).toBeGreaterThan(-1);
        const handler = main.slice(start, main.indexOf("ipcMain.handle('securekv:seal'", start));
        expect(handler).toMatch(/catch \(e\) \{[\s\S]*throw e;/);
        expect(handler).not.toMatch(/v: null/);
    });
});
