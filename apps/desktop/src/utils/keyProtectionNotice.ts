/**
 * G8 — copy for the one-time "your keyring isn't protecting this device's key"
 * notice. Kept out of the component so it is testable under vitest (node env,
 * `.ts` only) and so the wording is reviewed in one place.
 *
 * Tone: informational, not alarming. Everything still works and messages are
 * still end-to-end encrypted; what is weaker is protection of the LOCAL vault
 * against someone who can copy files from this machine's disk.
 */

export type KeyProtectionLevel = 'os_keystore' | 'obfuscated' | 'plaintext' | 'unknown';
export type KeyProtectionReason = 'backend' | 'legacy_wrap' | 'no_keystore' | null;

export interface KeyProtectionNoticeCopy {
    title: string;
    body: string;
}

const KEYRING_HOWTO =
    'Install and unlock a system keyring (GNOME Keyring / libsecret, or KWallet), then restart Cipherline. ' +
    'On a desktop Chromium does not recognise, launching with --password-store=gnome-libsecret (or kwallet6) selects one.';

export function keyProtectionNoticeCopy(level: KeyProtectionLevel, reason: KeyProtectionReason): KeyProtectionNoticeCopy | null {
    if (level === 'plaintext') {
        return {
            title: 'No system keyring found',
            body: 'Your messages are still end-to-end encrypted, but the key that protects Cipherline\'s data on this computer is stored unprotected on disk. ' + KEYRING_HOWTO,
        };
    }
    if (level === 'obfuscated' && reason === 'legacy_wrap') {
        return {
            title: 'Your local key predates your keyring',
            body: 'Your messages are still end-to-end encrypted. The key that protects Cipherline\'s data on this computer was saved before a system keyring was available, so it is only obscured, not keyring-protected. Moving it into the keyring is not automatic yet.',
        };
    }
    if (level === 'obfuscated') {
        return {
            title: 'Your system keyring isn\'t being used',
            body: 'Your messages are still end-to-end encrypted, but the key that protects Cipherline\'s data on this computer is only obscured, not keyring-protected. ' + KEYRING_HOWTO,
        };
    }
    return null;
}
