import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * G8 — electron/storage.ts must RECORD, not act on, a weak safeStorage backend.
 *
 * Real filesystem against a temp userData dir; only the `electron` module is
 * mocked (same approach as secureStore.smoke.test.ts). The fake safeStorage
 * mimics Chromium's Linux OSCrypt output prefixes: `v10` for the hard-coded
 * `basic_text` scheme, `v11` for a keyring-derived key.
 */

let tmpDir = '';
let backend: string | (() => string) = 'basic_text';
const readBackend = () => (typeof backend === 'function' ? backend() : backend);

vi.mock('electron', () => ({
    app: { getPath: () => tmpDir },
    safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => readBackend(),
        encryptString: (s: string) => Buffer.from(`${readBackend() === 'basic_text' ? 'v10' : 'v11'}${s}`, 'utf8'),
        decryptString: (buf: Buffer) => {
            const s = buf.toString('utf8');
            if (!s.startsWith('v10') && !s.startsWith('v11')) throw new Error('not wrapped');
            return s.slice(3);
        },
    },
    dialog: { showMessageBoxSync: vi.fn(), showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));

const { SecureStore } = await import('../../electron/storage');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-keyprot-test-'));
    Object.defineProperty(process, 'platform', { value: 'linux' });
    backend = 'basic_text';
});
afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    delete process.env.CIPHERLINE_SMOKE_TEST;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SecureStore key-protection detection (G8)', () => {
    it('basic_text: classified OBFUSCATED — and the store still works (never bricked)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const store = new SecureStore();
        await store.initialize();
        warn.mockRestore();
        expect(store.status()).toBe('ok');
        expect(store.keyProtection()).toMatchObject({ level: 'obfuscated', reason: 'backend', backend: 'basic_text' });
        store.set('k', 'v');
        expect(store.get('k')).toBe('v');
    });

    it('a real keyring on a fresh install: OS keystore', async () => {
        backend = 'gnome_libsecret';
        const store = new SecureStore();
        await store.initialize();
        expect(store.keyProtection()).toMatchObject({ level: 'os_keystore', backend: 'gnome_libsecret' });
    });

    it('a key wrapped under basic_text stays flagged after a keyring appears (and still unlocks)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const first = new SecureStore();
        await first.initialize(); // basic_text → v10 key file
        first.set('k', 'v');
        await first.whenDurable(); // vault writes are asynchronous; this is the durability point
        expect(fs.readFileSync(path.join(tmpDir, 'store.key')).subarray(0, 3).toString()).toBe('v10');

        backend = 'gnome_libsecret';
        const second = new SecureStore();
        await second.initialize();
        warn.mockRestore();
        expect(second.status()).toBe('ok');
        expect(second.get('k')).toBe('v');
        expect(second.keyProtection()).toMatchObject({ level: 'obfuscated', reason: 'legacy_wrap' });
    });

    it('getSelectedStorageBackend throwing is "unconfirmed" (weak), not a crash', async () => {
        backend = () => { throw new Error('no such API'); };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const store = new SecureStore();
        // encryptString reads the backend too — give init a key file first.
        fs.writeFileSync(path.join(tmpDir, 'store.key'), `v11${'ab'.repeat(32)}`);
        await store.initialize();
        warn.mockRestore();
        expect(store.status()).toBe('ok');
        expect(store.keyProtection().level).toBe('obfuscated');
    });

    it('under CIPHERLINE_SMOKE_TEST: level stays unknown (no notice) and init writes nothing', async () => {
        process.env.CIPHERLINE_SMOKE_TEST = '1';
        const store = new SecureStore();
        await store.initialize();
        expect(store.keyProtection().level).toBe('unknown');
        expect(fs.readdirSync(tmpDir)).toEqual([]);
    });
});
