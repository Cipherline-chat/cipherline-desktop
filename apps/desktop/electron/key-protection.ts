/**
 * G8 — how strongly is the device master key protected at rest?
 *
 * `SecureStore` wraps its master key with Electron `safeStorage`. On Windows
 * that is DPAPI and on macOS the Keychain. On Linux it depends on which
 * backend Chromium selects:
 *
 *   gnome_libsecret / kwallet / kwallet5 / kwallet6
 *       — a real keyring; the wrapping key lives in the user's keyring.
 *   basic_text
 *       — selected when the desktop environment is not recognised (i3, sway,
 *         many minimal / headless sessions) or with --password-store=basic.
 *         `isEncryptionAvailable()` can still say TRUE here, but the "wrap"
 *         uses a HARD-CODED key compiled into Chromium: obfuscation, not
 *         encryption. Anyone who copies `store.key` can unwrap it.
 *   unknown
 *       — only before `ready`; we treat it as unconfirmed (weak).
 *
 * The old code checked only `isEncryptionAvailable()`, so a basic_text device
 * was treated as fully protected and the user was never told. Deliberately
 * free of any `electron` import so the decision is unit-testable; storage.ts
 * feeds it the real values.
 *
 * The backend is only half the story: the key FILE may have been wrapped
 * before a keyring existed. Chromium's Linux OSCrypt prefixes its output with
 * `v10` for the hard-coded-key scheme and `v11` for a keyring-derived key, so a
 * `v10` key file is obfuscated whatever backend is selected today.
 *
 * Detection only. We do NOT re-wrap automatically when a keyring later appears:
 * a key re-wrapped under the keyring stops opening in any session where that
 * keyring is unavailable (e.g. the same user alternating between GNOME and a
 * bare window manager), which would land the user on the locked-store screen.
 * An opt-in re-wrap is a follow-up; this change makes the state visible.
 */

export type KeyProtectionLevel =
    /** A real OS keystore (DPAPI, Keychain, libsecret, KWallet). */
    | 'os_keystore'
    /** Linux `basic_text` (or an unconfirmed backend): hard-coded-key obfuscation. */
    | 'obfuscated'
    /** No safeStorage at all: the master key is on disk in plaintext. */
    | 'plaintext'
    /** Not determined (smoke test, or init has not run). Never shown to users. */
    | 'unknown';

export interface KeyProtection {
    level: KeyProtectionLevel;
    /** Why a weak level was chosen: the selected backend, or a key file wrapped
     *  under the obfuscation scheme before a keyring was available. */
    reason: 'backend' | 'legacy_wrap' | 'no_keystore' | null;
    /** Linux only: the backend Chromium selected, as reported. */
    backend: string | null;
    platform: string;
}

const STRONG_LINUX_BACKENDS: ReadonlySet<string> = new Set([
    'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6',
]);

export function classifyKeyProtection(input: {
    platform: string;
    encryptionAvailable: boolean;
    /** `safeStorage.getSelectedStorageBackend()` on Linux; null elsewhere or if the call failed. */
    backend: string | null;
    /** First bytes of the existing wrapped key file (Linux only), or null. */
    wrappedPrefix?: string | null;
}): KeyProtection {
    const { platform, encryptionAvailable } = input;
    const backend = platform === 'linux' ? input.backend : null;
    if (!encryptionAvailable) return { level: 'plaintext', reason: 'no_keystore', backend, platform };
    if (platform !== 'linux') return { level: 'os_keystore', reason: null, backend, platform };
    // Allow-list, not deny-list: a backend name this build does not know is
    // unconfirmed, and an unconfirmed keystore must not be reported as strong.
    if (!backend || !STRONG_LINUX_BACKENDS.has(backend)) return { level: 'obfuscated', reason: 'backend', backend, platform };
    if (input.wrappedPrefix === 'v10') return { level: 'obfuscated', reason: 'legacy_wrap', backend, platform };
    return { level: 'os_keystore', reason: null, backend, platform };
}

export function isWeakKeyProtection(p: KeyProtection): boolean {
    return p.level === 'obfuscated' || p.level === 'plaintext';
}

/**
 * The acknowledgement token. The notice is ONE-TIME per distinct weak state:
 * dismissing it for `obfuscated/basic_text` does not also silence a later
 * `plaintext` or `legacy_wrap` state — a DIFFERENT weak state re-arms it.
 */
export function keyProtectionNoticeToken(p: KeyProtection): string {
    return `${p.level}:${p.reason ?? '-'}:${p.backend ?? '-'}`;
}

export function shouldShowKeyProtectionNotice(p: KeyProtection, ackedToken: string | null): boolean {
    return isWeakKeyProtection(p) && ackedToken !== keyProtectionNoticeToken(p);
}
