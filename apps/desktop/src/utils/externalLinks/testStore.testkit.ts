/**
 * Test helper (imported only by *.test.ts): the REAL encrypted secureLocalStore
 * behind the same main-side KvCrypto bridge shape secureLocalStore.test.ts uses,
 * plus sign-in that waits for the account's records like AuthContext.login does.
 */
import { vi } from 'vitest';
import { secureLocalStore } from '../secureLocalStore';
import { KvCrypto } from '../../../electron/kv-crypto';

const KEY = Buffer.alloc(32, 9);

function installBridge(): void {
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => KEY }, { writeBound: false });
    const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
    w.electronAPI = {
        ...((w.electronAPI as object | undefined) ?? {}),
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: 'ok' })),
        secureKvOpen: vi.fn(async (recs: Array<{ k: string; o: string | null; b: Uint8Array }>) => kv.open(recs)),
        secureKvSeal: vi.fn(async (recs: Array<{ k: string; o: string | null; v: string }>) => kv.seal(recs)),
    };
}

export async function wipeStoreDb(): Promise<void> {
    secureLocalStore._resetForTest();
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve(); req.onerror = () => resolve(); req.onblocked = () => resolve();
    });
}

export async function restartStore(): Promise<void> {
    secureLocalStore._resetForTest();
    installBridge();
    await secureLocalStore.hydrate();
}

export async function signIn(uid: string): Promise<void> {
    secureLocalStore.setItem('cipherline_user_id', uid);
    await secureLocalStore.whenAccountReady();
}
