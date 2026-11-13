import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Linux wallet prompt: what SecureStore does when the system wallet (KWallet /
 * GNOME Keyring) is unlocked, refused, missing, or irrelevant (Windows / macOS).
 *
 * Real filesystem against a temp userData dir; only the `electron` module is
 * faked. The fake `safeStorage` reproduces what was MEASURED with the real
 * Electron binary against real kwalletd5 / gnome-keyring (see keyring-prompt.ts):
 * a refused prompt is a `false` that arrives after a human-scale wait, and from
 * then on every encrypt/decrypt in that process fails; a missing service is a
 * `false` within milliseconds. The clock is injected, so "5 seconds" costs nothing.
 *
 * The pass criterion everywhere is the one the owner cares about: the SAME
 * master key (and so the same Signal identity) once the wallet is unlocked.
 */

type Mode = 'unlocked' | 'denied' | 'no-service';
let tmpDir = '';
let mode: Mode = 'unlocked';
let backend = 'kwallet5';
let clock = 0;
const showMessageBox = vi.hoisted(() => vi.fn(async (_opts?: unknown) => ({ response: 0 })));

vi.mock('electron', () => ({
    app: { getPath: () => tmpDir },
    safeStorage: {
        isEncryptionAvailable: () => {
            if (mode === 'denied') { clock += 5_000; return false; }
            if (mode === 'no-service') { clock += 3; return false; }
            clock += 2; return true;
        },
        getSelectedStorageBackend: () => backend,
        encryptString: (s: string) => {
            if (mode !== 'unlocked') throw new Error('Encryption is not available');
            return Buffer.from(`v11${s}`, 'utf8');
        },
        decryptString: (buf: Buffer) => {
            if (mode !== 'unlocked') throw new Error('Decryption is not available');
            const s = buf.toString('utf8');
            if (!s.startsWith('v11')) throw new Error('not wrapped');
            return s.slice(3);
        },
    },
    dialog: { showMessageBoxSync: vi.fn(), showMessageBox },
}));

const { SecureStore } = await import('../../electron/storage');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });
const keyFile = () => path.join(tmpDir, 'store.key');
const vaultFile = () => path.join(tmpDir, 'secure-store.json');
const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
const fp = (s: InstanceType<typeof SecureStore>) => crypto.createHash('sha256').update(s.getMasterKeyB64() ?? 'NONE').digest('hex').slice(0, 16);
const newStore = () => new SecureStore({ now: () => clock });

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-keyring-test-'));
    setPlatform('linux');
    mode = 'unlocked'; backend = 'kwallet5'; clock = 0;
    showMessageBox.mockClear();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    errSpy.mockRestore(); warnSpy.mockRestore();
    Object.defineProperty(process, 'platform', realPlatform);
    delete process.env.CIPHERLINE_SMOKE_TEST;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A device that has been used with an unlocked wallet: wrapped key + a stored identity. */
async function seedExistingDevice(): Promise<{ fp: string; keyBytes: Buffer; vaultBytes: Buffer }> {
    const first = newStore();
    await first.initialize();
    first.set('signal_identity', 'identity-private-key-material');
    await first.whenDurable();
    expect(first.status()).toBe('ok');
    return { fp: fp(first), keyBytes: read(keyFile())!, vaultBytes: read(vaultFile())! };
}

describe('Linux, wallet unlocked: unchanged', () => {
    it('first run wraps a new key with the wallet; keyring state is unlocked', async () => {
        const s = newStore();
        await s.initialize();
        expect(s.status()).toBe('ok');
        expect(s.keyringStatus()).toEqual({ state: 'unlocked', walletName: 'KDE Wallet', firstRun: false, degraded: false });
        expect(read(keyFile())!.subarray(0, 3).toString()).toBe('v11');
        expect(showMessageBox).not.toHaveBeenCalled();
    });

    it('the probe hook runs before the first safeStorage call and is disposed right after it', async () => {
        const order: string[] = [];
        const s = newStore();
        s.setKeyringProbeHook((b) => { order.push(`hook:${b}`); return () => { order.push('dispose'); }; });
        await s.initialize();
        expect(order).toEqual(['hook:kwallet5', 'dispose']);
    });

    it('an async hook (a window that has to paint first) is awaited before the call', async () => {
        let ready = false;
        const s = newStore();
        s.setKeyringProbeHook(async () => { await new Promise(r => setTimeout(r, 15)); ready = true; return () => {}; });
        const origNow = clock;
        await s.initialize();
        expect(ready).toBe(true);
        expect(origNow).toBe(0);
    });

    it('a hook that throws (or rejects) never stops the store opening', async () => {
        const a = newStore();
        a.setKeyringProbeHook(() => { throw new Error('window failed'); });
        await a.initialize();
        expect(a.status()).toBe('ok');
        fs.rmSync(tmpDir, { recursive: true, force: true }); fs.mkdirSync(tmpDir);
        const b = newStore();
        b.setKeyringProbeHook(async () => { throw new Error('window failed'); });
        await b.initialize();
        expect(b.status()).toBe('ok');
    });
});

describe('Linux, wallet REFUSED on the first run (no key yet)', () => {
    it('writes nothing: no key file, no vault, no plaintext, no misleading dialog; locked', async () => {
        mode = 'denied';
        const s = newStore();
        await s.initialize();
        expect(s.status()).toBe('locked');
        expect(s.getMasterKeyB64()).toBeNull();
        expect(s.keyringStatus()).toEqual({ state: 'denied', walletName: 'KDE Wallet', firstRun: true, degraded: false });
        expect(read(keyFile())).toBeNull();
        expect(read(vaultFile())).toBeNull();
        expect(fs.readdirSync(tmpDir).filter(f => f.includes('key') || f.includes('store'))).toEqual([]);
        expect(showMessageBox).not.toHaveBeenCalled(); // "no keychain is running" would be wrong
    });

    it('NEGATIVE CONTROL: a MISSING wallet service on a first run keeps the old, visible behaviour (plaintext + dialog)', async () => {
        mode = 'no-service';
        const s = newStore();
        await s.initialize();
        expect(s.status()).toBe('ok');
        expect(s.keyringStatus().state).toBe('no-service');
        expect(read(keyFile())!.toString()).toMatch(/^[0-9a-f]{64}$/);
        expect(showMessageBox).toHaveBeenCalledTimes(1);
    });

    it('GNOME Keyring is named as such', async () => {
        mode = 'denied'; backend = 'gnome_libsecret';
        const s = newStore();
        await s.initialize();
        expect(s.keyringStatus().walletName).toBe('GNOME Keyring');
    });

    it('a retry (relaunch) with the wallet unlocked then generates exactly one key and wraps it', async () => {
        mode = 'denied';
        const first = newStore();
        await first.initialize();
        expect(first.status()).toBe('locked');
        mode = 'unlocked';
        const second = newStore();
        await second.initialize();
        expect(second.status()).toBe('ok');
        expect(read(keyFile())!.subarray(0, 3).toString()).toBe('v11');
        expect(second.keyringStatus().state).toBe('unlocked');
    });

    it('recovery key on a blank device while the wallet is refused: refused (nothing to validate it against, nowhere safe to keep it)', async () => {
        mode = 'denied';
        const s = newStore();
        await s.initialize();
        expect(s.recoverWithKey(crypto.randomBytes(32).toString('base64'))).toBe(false);
        expect(s.status()).toBe('locked');
        expect(read(keyFile())).toBeNull();
        expect(read(vaultFile())).toBeNull();
    });
});

describe('Linux, wallet REFUSED on a later run (keys already stored under it)', () => {
    it('locks, and leaves the key file and the vault byte-for-byte as they were: no regeneration, no plaintext', async () => {
        const seed = await seedExistingDevice();
        mode = 'denied';
        const s = newStore();
        await s.initialize();
        expect(s.status()).toBe('locked');
        expect(s.getMasterKeyB64()).toBeNull();
        expect(s.keyringStatus()).toEqual({ state: 'denied', walletName: 'KDE Wallet', firstRun: false, degraded: false });
        expect(read(keyFile())!.equals(seed.keyBytes)).toBe(true);
        expect(read(vaultFile())!.equals(seed.vaultBytes)).toBe(true);
        expect(showMessageBox).not.toHaveBeenCalled();
    });

    it('PASS CRITERION: relaunch + unlock gives the SAME master key and the same stored identity', async () => {
        const seed = await seedExistingDevice();
        mode = 'denied';
        const cancelled = newStore();
        await cancelled.initialize();
        expect(cancelled.status()).toBe('locked');

        mode = 'unlocked';
        const again = newStore();
        await again.initialize();
        expect(again.status()).toBe('ok');
        expect(fp(again)).toBe(seed.fp);
        expect(again.get('signal_identity')).toBe('identity-private-key-material');
    });

    it('while locked nothing can write: set() is refused and the vault does not change', async () => {
        const seed = await seedExistingDevice();
        mode = 'denied';
        const s = newStore();
        await s.initialize();
        expect(() => s.set('signal_identity', 'new-identity')).toThrow();
        await new Promise(r => setTimeout(r, 20));
        expect(read(vaultFile())!.equals(seed.vaultBytes)).toBe(true);
    });

    it('start-fresh is refused at the store (a reset would have to write a plaintext key)', async () => {
        const seed = await seedExistingDevice();
        mode = 'denied';
        const s = newStore();
        await s.initialize();
        expect(() => s.factoryReset()).toThrow(/wallet/);
        expect(read(keyFile())!.equals(seed.keyBytes)).toBe(true);
        expect(read(vaultFile())!.equals(seed.vaultBytes)).toBe(true);
        expect(s.status()).toBe('locked');
    });

    it('GNOME Keyring behaves the same', async () => {
        backend = 'gnome_libsecret';
        const seed = await seedExistingDevice();
        mode = 'denied';
        const s = newStore();
        await s.initialize();
        expect(s.status()).toBe('locked');
        expect(s.keyringStatus().walletName).toBe('GNOME Keyring');
        expect(read(keyFile())!.equals(seed.keyBytes)).toBe(true);
    });

    it('recovery key while the wallet is refused: the session opens with the SAME key, in memory only, key file untouched, banner flag on', async () => {
        const seed = await seedExistingDevice();
        // The user's saved recovery key is the master key as base64.
        mode = 'unlocked';
        const probe = newStore();
        await probe.initialize();
        const saved = probe.getMasterKeyB64()!;

        mode = 'denied';
        const s = newStore();
        await s.initialize();
        expect(s.status()).toBe('locked');
        expect(s.recoverWithKey(saved)).toBe(true);
        expect(s.status()).toBe('ok');
        expect(fp(s)).toBe(seed.fp);
        expect(s.get('signal_identity')).toBe('identity-private-key-material');
        expect(s.keyringStatus()).toEqual({ state: 'denied', walletName: 'KDE Wallet', firstRun: false, degraded: true });
        // Nothing was rewritten: not wrapped differently, and above all not in plaintext.
        expect(read(keyFile())!.equals(seed.keyBytes)).toBe(true);
        expect(showMessageBox).not.toHaveBeenCalled();
    });

    it('a WRONG recovery key is rejected while the wallet is refused, and the store stays locked', async () => {
        await seedExistingDevice();
        mode = 'denied';
        const s = newStore();
        await s.initialize();
        expect(s.recoverWithKey(crypto.randomBytes(32).toString('base64'))).toBe(false);
        expect(s.status()).toBe('locked');
    });

    it('after a memory-only recovery session, the next launch with the wallet unlocked opens normally (same key)', async () => {
        const seed = await seedExistingDevice();
        mode = 'unlocked';
        const probe = newStore(); await probe.initialize();
        const saved = probe.getMasterKeyB64()!;
        mode = 'denied';
        const s = newStore(); await s.initialize();
        s.recoverWithKey(saved);
        s.set('after_recovery', 'written under the original key');
        await s.whenDurable();
        mode = 'unlocked';
        const next = newStore(); await next.initialize();
        expect(next.status()).toBe('ok');
        expect(fp(next)).toBe(seed.fp);
        expect(next.get('after_recovery')).toBe('written under the original key');
        expect(next.get('signal_identity')).toBe('identity-private-key-material');
    });
});

describe('Linux, wallet refused but an earlier no-wallet run left a plaintext key', () => {
    it('uses that key as it is (never rewritten), shows no "no keychain" dialog, degraded banner on', async () => {
        mode = 'no-service';
        const earlier = newStore();
        await earlier.initialize();
        earlier.set('signal_identity', 'identity');
        await earlier.whenDurable();
        const plain = read(keyFile())!;
        const earlierFp = fp(earlier);
        showMessageBox.mockClear();

        mode = 'denied';
        const s = newStore();
        await s.initialize();
        expect(s.status()).toBe('ok');
        expect(fp(s)).toBe(earlierFp);
        expect(read(keyFile())!.equals(plain)).toBe(true);
        expect(s.keyringStatus().degraded).toBe(true);
        expect(showMessageBox).not.toHaveBeenCalled();
    });
});

describe('Windows and macOS: unchanged, and none of this runs', () => {
    for (const platform of ['win32', 'darwin']) {
        it(`${platform}: no probe hook, state not-applicable, and the pre-change first-run behaviour (no keystore -> plaintext + the existing dialog)`, async () => {
            setPlatform(platform);
            mode = 'denied'; // would be "refused" on Linux; here it is simply "no keystore", as before
            const hook = vi.fn();
            const s = newStore();
            s.setKeyringProbeHook(hook);
            await s.initialize();
            expect(hook).not.toHaveBeenCalled();
            expect(s.keyringStatus()).toEqual({ state: 'not-applicable', walletName: null, firstRun: false, degraded: false });
            expect(s.status()).toBe('ok');
            expect(read(keyFile())!.toString()).toMatch(/^[0-9a-f]{64}$/);
            expect(showMessageBox).toHaveBeenCalledTimes(1);
        });

        it(`${platform}: with the keystore working it wraps the key exactly as before`, async () => {
            setPlatform(platform);
            const s = newStore();
            await s.initialize();
            expect(s.status()).toBe('ok');
            expect(read(keyFile())!.subarray(0, 3).toString()).toBe('v11');
            expect(s.keyringStatus().state).toBe('not-applicable');
        });

        it(`${platform}: a wrapped key that cannot be unwrapped is still plain 'locked' with a reset allowed (no wallet refusal logic)`, async () => {
            setPlatform(platform);
            const seed = await seedExistingDevice();
            mode = 'denied';
            const s = newStore();
            await s.initialize();
            expect(s.status()).toBe('locked');
            expect(s.keyringStatus().state).toBe('not-applicable');
            expect(read(keyFile())!.equals(seed.keyBytes)).toBe(true);
            expect(() => s.factoryReset()).not.toThrow();
        });
    }

    it('Linux with basic_text (no real keyring) is not-applicable too: hook not called', async () => {
        backend = 'basic_text';
        const hook = vi.fn();
        const s = newStore();
        s.setKeyringProbeHook(hook);
        await s.initialize();
        expect(hook).not.toHaveBeenCalled();
        expect(s.keyringStatus().state).toBe('not-applicable');
    });
});

describe('smoke test trap', () => {
    it('under CIPHERLINE_SMOKE_TEST nothing runs: no hook, no safeStorage call, no write', async () => {
        process.env.CIPHERLINE_SMOKE_TEST = '1';
        const hook = vi.fn();
        const s = newStore();
        s.setKeyringProbeHook(hook);
        await s.initialize();
        expect(hook).not.toHaveBeenCalled();
        expect(clock).toBe(0);
        expect(fs.readdirSync(tmpDir)).toEqual([]);
        expect(s.keyringStatus().state).toBe('not-applicable');
    });
});
