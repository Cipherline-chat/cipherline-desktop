import { describe, it, expect } from 'vitest';
import {
    classifyKeyProtection,
    isWeakKeyProtection,
    keyProtectionNoticeToken,
    shouldShowKeyProtectionNotice,
} from './key-protection';
import { keyProtectionNoticeCopy } from '../src/utils/keyProtectionNotice';

/** G8 — safeStorage's Linux `basic_text` fallback is obfuscation, not a keystore. */
describe('classifyKeyProtection', () => {
    const linux = (backend: string | null, wrappedPrefix: string | null = null, encryptionAvailable = true) =>
        classifyKeyProtection({ platform: 'linux', encryptionAvailable, backend, wrappedPrefix });

    it('Linux basic_text is OBFUSCATED even though isEncryptionAvailable() says true', () => {
        expect(linux('basic_text')).toMatchObject({ level: 'obfuscated', reason: 'backend', backend: 'basic_text' });
    });

    it('an unknown / unrecognised / unreadable backend is unconfirmed, never strong (allow-list)', () => {
        expect(linux('unknown').level).toBe('obfuscated');
        expect(linux('some_future_backend').level).toBe('obfuscated');
        expect(linux(null).level).toBe('obfuscated');
    });

    it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])('Linux %s is a real keystore', b => {
        expect(linux(b)).toMatchObject({ level: 'os_keystore', reason: null });
    });

    it('a v10-wrapped key file is obfuscated even once a keyring is selected (wrapped before it existed)', () => {
        expect(linux('gnome_libsecret', 'v10')).toMatchObject({ level: 'obfuscated', reason: 'legacy_wrap' });
        expect(linux('gnome_libsecret', 'v11').level).toBe('os_keystore');
    });

    it('no safeStorage at all is PLAINTEXT on every platform', () => {
        expect(linux('basic_text', null, false)).toMatchObject({ level: 'plaintext', reason: 'no_keystore' });
        expect(classifyKeyProtection({ platform: 'win32', encryptionAvailable: false, backend: null }).level).toBe('plaintext');
    });

    it('Windows (DPAPI) and macOS (Keychain) are keystores; the Linux-only backend field is ignored there', () => {
        expect(classifyKeyProtection({ platform: 'win32', encryptionAvailable: true, backend: 'basic_text' }))
            .toEqual({ level: 'os_keystore', reason: null, backend: null, platform: 'win32' });
        expect(classifyKeyProtection({ platform: 'darwin', encryptionAvailable: true, backend: null }).level).toBe('os_keystore');
    });
});

describe('one-time notice gating', () => {
    const weak = classifyKeyProtection({ platform: 'linux', encryptionAvailable: true, backend: 'basic_text' });
    const strong = classifyKeyProtection({ platform: 'linux', encryptionAvailable: true, backend: 'gnome_libsecret' });
    const plain = classifyKeyProtection({ platform: 'linux', encryptionAvailable: false, backend: 'basic_text' });

    it('shows for a weak state until that exact state is acknowledged', () => {
        expect(shouldShowKeyProtectionNotice(weak, null)).toBe(true);
        expect(shouldShowKeyProtectionNotice(weak, keyProtectionNoticeToken(weak))).toBe(false);
    });

    it('a DIFFERENT weak state re-arms it', () => {
        expect(shouldShowKeyProtectionNotice(plain, keyProtectionNoticeToken(weak))).toBe(true);
    });

    it('never shows on a real keystore, or when the level is unknown (smoke test / pre-init)', () => {
        expect(isWeakKeyProtection(strong)).toBe(false);
        expect(shouldShowKeyProtectionNotice(strong, null)).toBe(false);
        expect(shouldShowKeyProtectionNotice({ level: 'unknown', reason: null, backend: null, platform: 'linux' }, null)).toBe(false);
    });

    it('has copy for every weak state, and none for a strong one; the copy is reassuring, not alarming', () => {
        for (const p of [weak, plain, { ...strong, level: 'obfuscated' as const, reason: 'legacy_wrap' as const }]) {
            const c = keyProtectionNoticeCopy(p.level, p.reason);
            expect(c).not.toBeNull();
            expect(c!.body).toMatch(/still end-to-end encrypted/);
        }
        expect(keyProtectionNoticeCopy('os_keystore', null)).toBeNull();
        expect(keyProtectionNoticeCopy('unknown', null)).toBeNull();
        expect(keyProtectionNoticeCopy('obfuscated', 'backend')!.body).toMatch(/gnome-libsecret|KWallet/);
    });
});
