/**
 * Trusted websites persist per account in the REAL encrypted secureLocalStore
 * (main-side KvCrypto behind the same bridge shape secureLocalStore.test.ts
 * uses), survive a restart, never leak across accounts, and are never written
 * into a cold (still loading) account namespace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureLocalStore, REBIND_DELAY_MS } from '../secureLocalStore';
import { KvCrypto } from '../../../electron/kv-crypto';
import {
    TRUSTED_DOMAINS_KEY_PREFIX, canPersistTrust, entryCoversHost, isTrustedHost, isUserTrustedHost,
    listTrustedDomains, subscribeTrustedDomains, trustDomain, untrustDomain,
} from './trustedDomains';

const KEY = Buffer.alloc(32, 9);
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

function installBridge() {
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => KEY }, { writeBound: false });
    (globalThis as any).window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: 'ok' })),
        secureKvOpen: vi.fn(async (recs: Array<{ k: string; o: string | null; b: Uint8Array }>) => kv.open(recs)),
        secureKvSeal: vi.fn(async (recs: Array<{ k: string; o: string | null; v: string }>) => kv.seal(recs)),
    };
}
async function wipeDb(): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve(); req.onerror = () => resolve(); req.onblocked = () => resolve();
    });
}
function readRaw(key: string): Promise<{ b: Uint8Array } | undefined> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open('cipherline');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('kv_enc', 'readonly');
            const req = tx.objectStore('kv_enc').get(key);
            tx.oncomplete = () => { db.close(); resolve(req.result as { b: Uint8Array } | undefined); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        };
    });
}
async function restart() {
    secureLocalStore._resetForTest();
    installBridge();
    await secureLocalStore.hydrate();
}
async function signIn(uid: string) {
    secureLocalStore.setItem('cipherline_user_id', uid);
    await secureLocalStore.whenAccountReady();
}

beforeEach(async () => { await wipeDb(); secureLocalStore._resetForTest(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('entryCoversHost — label-boundary matching', () => {
    it.each([
        ['example.com', 'example.com', true],
        ['example.com', 'www.example.com', true],
        ['example.com', 'a.b.example.com', true],
        ['example.com', 'badexample.com', false],
        ['example.com', 'example.com.evil.io', false],
        ['example.co.uk', 'shop.example.co.uk', true],
        ['192.168.1.10', '192.168.1.10', true],
        ['localhost', 'evil.localhost', false],
    ])('%s covers %s → %s', (entry, host, want) => {
        expect(entryCoversHost(entry, host)).toBe(want);
    });
});

describe('trusted websites — per-account persistence', () => {
    it('signed out: nothing is user-trusted and nothing can be written', async () => {
        await restart();
        expect(listTrustedDomains()).toEqual([]);
        expect(canPersistTrust()).toBe(false);
        expect(trustDomain('example.com')).toBe(false);
        expect(isTrustedHost('cipherline.chat')).toBe(true); // built in regardless
    });

    it('persists encrypted per account, survives a restart, and never crosses accounts', async () => {
        await restart();
        await signIn(ALICE);
        expect(trustDomain('Example.COM')).toBe(true);
        expect(trustDomain('github.com')).toBe(true);
        expect(listTrustedDomains()).toEqual(['example.com', 'github.com']);
        expect(isUserTrustedHost('docs.github.com')).toBe(true);
        await secureLocalStore.flushNow();

        // On disk it is ciphertext, not the domain list.
        const raw = await readRaw(`${TRUSTED_DOMAINS_KEY_PREFIX}${ALICE}`);
        expect(raw).toBeDefined();
        expect(Buffer.from(raw!.b).toString('latin1')).not.toContain('example.com');

        // Bob sees none of Alice's sites and keeps his own.
        await signIn(BOB);
        expect(listTrustedDomains()).toEqual([]);
        expect(isUserTrustedHost('example.com')).toBe(false);
        expect(trustDomain('other.org')).toBe(true);
        await secureLocalStore.flushNow();

        await signIn(ALICE);
        expect(listTrustedDomains()).toEqual(['example.com', 'github.com']);

        // Restart: still there.
        await restart();
        expect(secureLocalStore.getItem('cipherline_user_id')).toBe(ALICE);
        await new Promise(r => setTimeout(r, REBIND_DELAY_MS + 100));
        expect(listTrustedDomains()).toEqual(['example.com', 'github.com']);

        expect(untrustDomain('github.com')).toBe(true);
        expect(listTrustedDomains()).toEqual(['example.com']);
        expect(isUserTrustedHost('github.com')).toBe(false);
    });

    it('refuses to write while the account is still loading (no defaults over real data)', async () => {
        await restart();
        await signIn(ALICE);
        expect(trustDomain('example.com')).toBe(true);
        await secureLocalStore.flushNow();
        await signIn(BOB);

        secureLocalStore.setItem('cipherline_user_id', ALICE); // rebind starts, not awaited
        expect(secureLocalStore.isAccountReady(ALICE)).toBe(false);
        expect(trustDomain('evil.example')).toBe(false);
        await secureLocalStore.whenAccountReady();
        expect(listTrustedDomains()).toEqual(['example.com']);
    });

    it('drops malformed stored entries on read and refuses invalid / built-in ones on write', async () => {
        await restart();
        await signIn(ALICE);
        secureLocalStore.setItem(`${TRUSTED_DOMAINS_KEY_PREFIX}${ALICE}`, JSON.stringify({ v: 1, domains: ['ok.example', 'BAD HOST', '.dot.com', 42, 'ok.example'] }));
        expect(listTrustedDomains()).toEqual(['ok.example']);
        expect(trustDomain('not a domain')).toBe(false);
        expect(trustDomain('cipherline.chat')).toBe(false);
        expect(trustDomain('www.cipherline.chat')).toBe(false);
    });

    it('notifies subscribers on change', async () => {
        await restart();
        await signIn(ALICE);
        const fn = vi.fn();
        const off = subscribeTrustedDomains(fn);
        trustDomain('example.com');
        untrustDomain('example.com');
        off();
        trustDomain('example.org');
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
