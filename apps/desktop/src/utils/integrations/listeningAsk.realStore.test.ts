/**
 * The "asked" record against the REAL secureLocalStore (encrypted IndexedDB, real
 * main-process crypto): it survives a restart, belongs to one account, and the
 * cold namespace right after a sign-in answers nothing and writes nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureLocalStore } from '../secureLocalStore';
import { KvCrypto } from '../../../electron/kv-crypto';
import { listeningAskGate, markListeningAsked } from './listeningAsk';
import { getListeningPrefs, resetListeningPrefsCache, setListeningPrefs } from './listeningPrefs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const KEY = Buffer.from(new Uint8Array(32).fill(7));

const wipeDb = () => new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('cipherline');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
});
const restart = async () => {
    await secureLocalStore.flushNow();
    secureLocalStore._resetForTest();
    resetListeningPrefsCache();
    await secureLocalStore.hydrate();
};
const signIn = async (uid: string) => {
    secureLocalStore.setItem('cipherline_user_id', uid);
    await secureLocalStore.whenAccountReady();
};

beforeEach(async () => {
    secureLocalStore._resetForTest();
    await wipeDb();
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => KEY });
    (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: 'ok' })),
        secureKvOpen: vi.fn(async (recs: Array<{ k: string; o: string | null; b: Uint8Array }>) => kv.open(recs)),
        secureKvSeal: vi.fn(async (recs: Array<{ k: string; o: string | null; v: string }>) => kv.seal(recs)),
    };
    resetListeningPrefsCache();
    await secureLocalStore.hydrate();
});
afterEach(() => { secureLocalStore._resetForTest(); });

describe('the record, in the real store', () => {
    it('marking waits for disk: a restart straight after still reads asked, and only for that account', async () => {
        await signIn(A);
        expect(listeningAskGate(A)).toBe('eligible');
        expect(await markListeningAsked(A)).toBe(true);
        expect(listeningAskGate(A)).toBe('asked');

        // A crash right after: what is in memory goes. flushNow has already run inside markListeningAsked.
        secureLocalStore._resetForTest();
        resetListeningPrefsCache();
        await secureLocalStore.hydrate();
        expect(listeningAskGate(A)).toBe('asked');

        await signIn(B);
        expect(listeningAskGate(B)).toBe('eligible');
        await signIn(A);
        expect(listeningAskGate(A)).toBe('asked');
    });

    it('the switch can tell never set from turned off, across a restart', async () => {
        await signIn(A);
        expect(secureLocalStore.getItem(`cipherline_listening_share_${A}`)).toBeNull();
        setListeningPrefs(A, { share: true });
        setListeningPrefs(A, { share: false });
        await restart();
        expect(secureLocalStore.getItem(`cipherline_listening_share_${A}`)).toBe('0');
        expect(getListeningPrefs(A).share).toBe(false);
        expect(listeningAskGate(A)).toBe('setting_off');
    });

    it('right after a sign-in the namespace is cold: no answer, no write, and the real values come back after', async () => {
        await signIn(A);
        await markListeningAsked(A);
        secureLocalStore.removeItem('cipherline_user_id');
        await restart();

        secureLocalStore.setItem('cipherline_user_id', A); // the sign-in click, not awaited
        expect(secureLocalStore.isAccountReady(A)).toBe(false);
        expect(secureLocalStore.getItem(`cipherline_listening_asked_${A}`)).toBeNull(); // reads as "never asked"...
        expect(listeningAskGate(A)).toBe('store_cold');                                  // ...and the gate does not believe it
        expect(await markListeningAsked(A)).toBe(false);
        await secureLocalStore.whenAccountReady();
        expect(listeningAskGate(A)).toBe('asked');
    });

    it('positive control: a record that was never written does read as eligible after the same restart', async () => {
        await signIn(A);
        secureLocalStore.removeItem('cipherline_user_id');
        await restart();
        await signIn(A);
        expect(listeningAskGate(A)).toBe('eligible');
    });
});
