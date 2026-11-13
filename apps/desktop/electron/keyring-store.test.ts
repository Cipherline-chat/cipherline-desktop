import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * SecureStore + keyring preflight, end to end with fakes: a fake `electron`
 * (safeStorage that logs when it is called, an app pointing at a temp dir), a
 * fake bus, a fake notice window.
 *
 * The contract being pinned:
 *   1. a prompt that is KNOWN to be coming is announced and the notice is
 *      PRESENTED before safeStorage is called (the Wayland bug: the call blocks
 *      the thread that presents the window);
 *   2. an unlocked wallet shows nothing and costs no delay;
 *   3. a cancelled wallet-creation wizard writes NO key, plaintext or otherwise;
 *   4. Windows / macOS never reach the hook, the bus or the notice.
 */

const { events, safeStorageMock, ud } = vi.hoisted(() => {
    const events: string[] = [];
    const safeStorageMock = {
        available: true,
        isEncryptionAvailable: undefined as unknown as ReturnType<typeof vi.fn>,
        encryptString: undefined as unknown as ReturnType<typeof vi.fn>,
        decryptString: undefined as unknown as ReturnType<typeof vi.fn>,
        getSelectedStorageBackend: undefined as unknown as ReturnType<typeof vi.fn>,
    };
    safeStorageMock.isEncryptionAvailable = vi.fn(() => { events.push('safeStorage.isEncryptionAvailable'); return safeStorageMock.available; });
    safeStorageMock.encryptString = vi.fn((s: string) => Buffer.from('v11' + s));
    safeStorageMock.decryptString = vi.fn((b: Buffer) => b.toString('utf8').slice(3));
    safeStorageMock.getSelectedStorageBackend = vi.fn(() => 'kwallet6');
    return { events, safeStorageMock, ud: { dir: '' } };
});

vi.mock('electron', () => ({
    app: { isPackaged: false, getPath: () => ud.dir, getName: () => 'Cipherline' },
    safeStorage: safeStorageMock,
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })), showMessageBoxSync: vi.fn(() => 0) },
}));

import { SecureStore } from './storage';
import { keyringPreflight, type PreflightDeps } from './keyring-preflight';
import type { BusExec } from './keyring-probe';

const realPlatform = process.platform;
function setPlatform(p: string) { Object.defineProperty(process, 'platform', { value: p, configurable: true }); }

function bus(a: { enabled?: string | null; wallets?: string | null; network?: string | null; isOpen?: string | null; open?: string | null; alias?: string | null; locked?: string | null }): BusExec {
    return async (args) => {
        events.push('bus:' + (args.find(x => ['isEnabled', 'wallets', 'networkWallet', 'isOpen', 'open', 'ReadAlias', 'get-property'].includes(x)) ?? '?'));
        const m = args.find(x => ['isEnabled', 'wallets', 'networkWallet', 'isOpen', 'open', 'ReadAlias', 'get-property'].includes(x));
        const table: Record<string, string | null | undefined> = {
            isEnabled: a.enabled, wallets: a.wallets, networkWallet: a.network, isOpen: a.isOpen, open: a.open, ReadAlias: a.alias, 'get-property': a.locked,
        };
        const out = table[m ?? ''];
        return out == null ? { ok: false, stdout: '' } : { ok: true, stdout: out };
    };
}

/** A notice that takes `presentMs` to be on screen, like the real window. */
function fakeNotice(presentMs: number, legacy = true): PreflightDeps['showNotice'] {
    return (_b, o) => new Promise(resolve => {
        events.push(`notice:create:${o.mode}:${o.delayed ? 'delayed' : 'immediate'}`);
        setTimeout(() => {
            events.push('notice:presented');
            resolve(() => { events.push('notice:disposed'); });
        }, presentMs);
        void legacy;
    });
}

function deps(over: Partial<PreflightDeps>): PreflightDeps {
    return { exec: bus({}), showNotice: fakeNotice(210), legacyShouldAnnounce: () => true, appId: 'Cipherline', ...over };
}

let store: SecureStore;
const keyFile = () => path.join(ud.dir, 'store.key');

beforeEach(() => {
    events.length = 0;
    safeStorageMock.available = true;
    safeStorageMock.isEncryptionAvailable.mockClear();
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('kwallet6');
    ud.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-keyring-'));
    setPlatform('linux');
    delete process.env.CIPHERLINE_SMOKE_TEST;
    store = new SecureStore();
});
afterEach(() => {
    setPlatform(realPlatform);
    vi.useRealTimers();
    fs.rmSync(ud.dir, { recursive: true, force: true });
});

/** Only setTimeout is faked: the store's real file I/O and worker still run. */
function useTimers() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); }

/** Advance the fake clock in steps, yielding to the real event loop between them, until `p` settles. */
async function drive(p: Promise<unknown>) {
    let done = false;
    const settled = p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 2000 && !done; i++) {
        await vi.advanceTimersByTimeAsync(50);
        await new Promise<void>(r => setImmediate(r));
    }
    await settled;
    await p;
}

async function init(d: PreflightDeps) {
    store.setKeyringProbeHook(b => keyringPreflight(b, d));
    await drive(store.initialize());
}

const KW_LOCKED = { enabled: 'b true', wallets: 'as 1 "kdewallet"', network: 's "kdewallet"', isOpen: 'b false' };
const KW_UNLOCKED = { ...KW_LOCKED, isOpen: 'b true' };
const KW_NONE = { enabled: 'b true', wallets: 'as 0', network: null };

describe('ordering: the notice is PRESENTED before safeStorage is called', () => {
    it('locked KWallet: probe, notice created (no delay), notice presented, THEN safeStorage, then the notice is taken down', async () => {
        useTimers();
        await init(deps({ exec: bus(KW_LOCKED) }));
        const i = (e: string) => events.indexOf(e);
        expect(i('notice:create:unlock:immediate')).toBeGreaterThan(-1);
        expect(i('notice:presented')).toBeGreaterThan(i('notice:create:unlock:immediate'));
        expect(i('safeStorage.isEncryptionAvailable')).toBeGreaterThan(i('notice:presented'));
        expect(i('notice:disposed')).toBeGreaterThan(i('safeStorage.isEncryptionAvailable'));
        expect(events.filter(e => e.startsWith('bus:'))).not.toContain('bus:open');
        expect(store.keyringStatus().state).toBe('unlocked');
    });

    it('safeStorage is NOT called while the notice is still being presented (fake clock held)', async () => {
        useTimers();
        store.setKeyringProbeHook(b => keyringPreflight(b, deps({ exec: bus(KW_LOCKED), showNotice: fakeNotice(500) })));
        const p = store.initialize();
        // Real I/O runs first; step the fake clock a little at a time.
        for (let i = 0; i < 20 && !events.includes('notice:create:unlock:immediate'); i++) {
            await vi.advanceTimersByTimeAsync(10);
            await new Promise<void>(r => setImmediate(r));
        }
        await vi.advanceTimersByTimeAsync(300);
        expect(events).toContain('notice:create:unlock:immediate');
        expect(events).not.toContain('notice:presented');
        expect(events).not.toContain('safeStorage.isEncryptionAvailable');
        await drive(p);
        expect(events.indexOf('safeStorage.isEncryptionAvailable')).toBeGreaterThan(events.indexOf('notice:presented'));
    });

    it('GNOME Keyring locked: same ordering', async () => {
        useTimers();
        safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
        await init(deps({ exec: bus({ alias: 'o "/org/freedesktop/secrets/collection/login"', locked: 'b true' }) }));
        expect(events.indexOf('safeStorage.isEncryptionAvailable')).toBeGreaterThan(events.indexOf('notice:presented'));
        expect(events).toContain('notice:create:unlock:immediate');
    });

    it('unlocked wallet: no notice, no delay, safeStorage called straight away', async () => {
        useTimers();
        await init(deps({ exec: bus(KW_UNLOCKED) }));
        expect(events.some(e => e.startsWith('notice:'))).toBe(false);
        expect(events).toContain('safeStorage.isEncryptionAvailable');
        expect(store.status()).toBe('ok');
    });

    it('probe TIMES OUT (daemon still starting): notice at once, still gated by the per-boot marker', async () => {
        useTimers();
        const never: PreflightDeps['exec'] = () => new Promise(() => { /* the bus never answers */ });
        await init(deps({ exec: never }));
        expect(events).toContain('notice:create:unlock:immediate');
        expect(events.indexOf('safeStorage.isEncryptionAvailable')).toBeGreaterThan(events.indexOf('notice:presented'));
        events.length = 0; store = new SecureStore(); ud.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-keyring-'));
        await init(deps({ exec: never, legacyShouldAnnounce: () => false }));
        expect(events.some(e => e.startsWith('notice:'))).toBe(false);
    });

    it('probe fails (service missing): the legacy path, delayed notice, gated by the per-boot marker', async () => {
        useTimers();
        await init(deps({ exec: bus({}) }));
        expect(events).toContain('notice:create:unlock:delayed');
        events.length = 0; store = new SecureStore(); ud.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-keyring-'));
        await init(deps({ exec: bus({}), legacyShouldAnnounce: () => false }));
        expect(events.some(e => e.startsWith('notice:'))).toBe(false);
    });
});

describe('fresh KWallet account with no wallet', () => {
    it('creation completes: the notice (create copy) goes up, KDE opens its wizard, THEN safeStorage; the key is WRAPPED', async () => {
        useTimers();
        await init(deps({ exec: bus({ ...KW_NONE, open: 'i 77' }) }));
        const i = (e: string) => events.indexOf(e);
        expect(i('notice:create:create:immediate')).toBeGreaterThan(-1);
        expect(i('bus:open')).toBeGreaterThan(i('notice:presented'));
        expect(i('safeStorage.isEncryptionAvailable')).toBeGreaterThan(i('bus:open'));
        expect(store.status()).toBe('ok');
        const onDisk = fs.readFileSync(keyFile());
        expect(onDisk.subarray(0, 3).toString('latin1')).toBe('v11');
        expect(/^[0-9a-f]{64}$/.test(onDisk.toString('utf8').trim())).toBe(false);
    });

    it('CANCEL: nothing plaintext (nothing at all) is written, safeStorage is never called, the store is locked as first-run-denied', async () => {
        useTimers();
        await init(deps({ exec: bus({ ...KW_NONE, open: 'i -1' }) }));
        expect(events).toContain('bus:open');
        expect(events).not.toContain('safeStorage.isEncryptionAvailable');
        expect(events).toContain('notice:disposed');
        expect(fs.existsSync(keyFile())).toBe(false);
        expect(store.status()).toBe('locked');
        expect(store.keyringStatus()).toMatchObject({ state: 'denied', firstRun: true, walletName: 'KDE Wallet' });
        expect(store.getMasterKeyB64()).toBeNull();
    });

    it('CANCEL with an existing wrapped key on disk: the file is left byte-for-byte as it was', async () => {
        useTimers();
        const wrapped = Buffer.concat([Buffer.from('v11'), Buffer.alloc(40, 7)]);
        fs.writeFileSync(keyFile(), wrapped);
        await init(deps({ exec: bus({ ...KW_NONE, open: 'i -1' }) }));
        expect(fs.readFileSync(keyFile()).equals(wrapped)).toBe(true);
        expect(store.status()).toBe('locked');
    });

    it('NEGATIVE CONTROL: the same wallet with a service ERROR on open (not a cancel) keeps the old path, i.e. safeStorage IS called', async () => {
        useTimers();
        await init(deps({ exec: bus({ ...KW_NONE, open: null }) }));
        expect(events).toContain('safeStorage.isEncryptionAvailable');
    });

    it('GNOME with no default keyring: notice (create copy) first, libsecret creates it inside the call', async () => {
        useTimers();
        safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
        await init(deps({ exec: bus({ alias: 'o "/"' }) }));
        expect(events).toContain('notice:create:create:immediate');
        expect(events).not.toContain('bus:open');
        expect(events.indexOf('safeStorage.isEncryptionAvailable')).toBeGreaterThan(events.indexOf('notice:presented'));
    });
});

describe('Windows / macOS / basic_text are untouched', () => {
    for (const platform of ['win32', 'darwin']) {
        it(`${platform}: the hook, the bus and the notice are never reached; safeStorage is called once, as before`, async () => {
            useTimers();
            setPlatform(platform);
            safeStorageMock.getSelectedStorageBackend.mockReturnValue('kwallet6'); // would be probed on Linux
            const hook = vi.fn();
            const exec = vi.fn(bus(KW_LOCKED));
            store.setKeyringProbeHook(b => { hook(b); return keyringPreflight(b, deps({ exec })); });
            await drive(store.initialize());
            expect(hook).not.toHaveBeenCalled();
            expect(exec).not.toHaveBeenCalled();
            expect(events).toEqual(['safeStorage.isEncryptionAvailable']);
            expect(store.keyringStatus().state).toBe('not-applicable');
            expect(store.status()).toBe('ok');
        });
    }

    it('Linux with basic_text (no real keyring): the hook is not called either', async () => {
        useTimers();
        safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');
        const hook = vi.fn();
        store.setKeyringProbeHook(b => { hook(b); return undefined; });
        await drive(store.initialize());
        expect(hook).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL for the above: on linux + kwallet the same hook IS called', async () => {
        useTimers();
        const hook = vi.fn();
        store.setKeyringProbeHook(b => { hook(b); return undefined; });
        await drive(store.initialize());
        expect(hook).toHaveBeenCalledWith('kwallet6');
    });
});
