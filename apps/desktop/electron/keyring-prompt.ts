/**
 * Linux keyring prompt: what happened to the system wallet, and what the key
 * store may do about it.
 *
 * On Linux, Electron's `safeStorage` is backed by the user's keyring (KDE
 * Wallet or GNOME Keyring / libsecret). The FIRST `safeStorage` call of a
 * launch can make the OS pop an "unlock / create wallet" dialog, with no word
 * of explanation from us, and the user can dismiss it. Measured with the real
 * Electron binary against real `kwalletd5` and `gnome-keyring` + `gcr-prompter`
 * (see the report that came with this change):
 *
 *   - The call BLOCKS the main thread for as long as the dialog is up.
 *     KWallet: Chromium's D-Bus call gives up after 25 s, so an ignored prompt
 *     is a cancelled prompt. GNOME: no timeout.
 *   - A cancelled / ignored / timed-out prompt makes `isEncryptionAvailable()`
 *     return false, and Chromium caches that for the life of the process: a
 *     second call five seconds later is still false and shows no new dialog.
 *     So the only retry is a clean relaunch.
 *   - With no keyring service at all (`kwalletd` not installed / wallet
 *     disabled) the same call fails within a few milliseconds.
 *
 * Before this module the key store treated every `false` as "no keyring on this
 * machine": on a FIRST run it wrote the master key to disk in plaintext behind
 * a dialog that wrongly said no keyring was running; on a LATER run it went
 * `locked` (safe, but with a screen that says nothing about the wallet and
 * offers "Start fresh" as a sibling of the recovery key).
 *
 * This file is the pure decision. It deliberately has no `electron` import
 * (unit-testable, and nothing under electron/ may import from src/).
 *
 * Linux only. Windows (DPAPI) and macOS (Keychain) are `not-applicable` and
 * every decision below collapses to exactly what the key store did before.
 */

/** Backends Chromium reports when it is talking to a real keyring. */
const KEYRING_BACKENDS: ReadonlySet<string> = new Set([
    'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6',
]);

export function isKeyringBackend(backend: string | null | undefined): boolean {
    return typeof backend === 'string' && KEYRING_BACKENDS.has(backend);
}

/**
 * How long the first `safeStorage` call may take before we call the keyring
 * "prompting" (the OS dialog is up). Also the boundary between "the service is
 * not there" (fails in a few ms) and "the user said no" (fails after a human
 * decision). Nobody dismisses a dialog in under 400 ms.
 */
export const KEYRING_PROMPT_AFTER_MS = 400;

/**
 * - `not-applicable`  not Linux, or Linux without a real keyring backend
 *                     (`basic_text`, unknown): behaves as it always did.
 * - `unlocked`        the keyring answered; safeStorage works.
 * - `denied`          a real keyring backend exists and the call failed AFTER the
 *                     prompt window: the user cancelled, closed or ignored it.
 * - `no-service`      a real keyring backend was selected but nothing answered
 *                     (failed immediately): no wallet daemon, or wallet disabled.
 */
export type KeyringState = 'not-applicable' | 'unlocked' | 'denied' | 'no-service';

export function classifyKeyringOutcome(input: {
    platform: string;
    backend: string | null;
    encryptionAvailable: boolean;
    /** Wall time the first safeStorage call took. */
    firstCallMs: number;
}): KeyringState {
    if (input.platform !== 'linux' || !isKeyringBackend(input.backend)) return 'not-applicable';
    if (input.encryptionAvailable) return 'unlocked';
    return input.firstCallMs >= KEYRING_PROMPT_AFTER_MS ? 'denied' : 'no-service';
}

/** "KDE Wallet" / "GNOME Keyring" / a generic name when the backend is unknown. */
export function walletNameForBackend(backend: string | null | undefined): string {
    if (backend === 'kwallet' || backend === 'kwallet5' || backend === 'kwallet6') return 'KDE Wallet';
    if (backend === 'gnome_libsecret') return 'GNOME Keyring';
    return 'system wallet';
}

/** What the key file on disk is. */
export type KeyFileState = 'absent' | 'plaintext' | 'wrapped';

/**
 * What `SecureStore._doInitialize` does with the master key.
 *
 *   wrap-new-key               first run, keyring works: generate, wrap, write.
 *   plaintext-new-key          first run, NO keystore (not denied): generate and
 *                              write plaintext, behind the existing warning.
 *   refuse-first-run           first run, wallet DENIED: write nothing, generate
 *                              nothing; the store is locked until the wallet opens.
 *   adopt-plaintext-and-wrap   legacy plaintext key, keystore works: use + upgrade.
 *   adopt-plaintext            plaintext key on disk and no usable keystore: use it
 *                              as-is (never rewrites the file).
 *   decrypt                    wrapped key, keystore works: unwrap it.
 *   locked                     wrapped key we cannot unwrap (wallet denied, or no
 *                              keystore): the file is left untouched.
 */
export type KeyInitAction =
    | 'wrap-new-key'
    | 'plaintext-new-key'
    | 'refuse-first-run'
    | 'adopt-plaintext-and-wrap'
    | 'adopt-plaintext'
    | 'decrypt'
    | 'locked';

export function decideKeyInit(input: {
    keyFile: KeyFileState;
    /** `safeStorage.isEncryptionAvailable()` */
    canWrap: boolean;
    keyring: KeyringState;
}): KeyInitAction {
    const { keyFile, canWrap, keyring } = input;
    // The invariant this module exists for: a denied wallet never reaches a
    // branch that generates a key or writes one to disk.
    if (keyring === 'denied') {
        if (keyFile === 'absent') return 'refuse-first-run';
        if (keyFile === 'plaintext') return 'adopt-plaintext';
        return 'locked';
    }
    if (keyFile === 'absent') return canWrap ? 'wrap-new-key' : 'plaintext-new-key';
    if (keyFile === 'plaintext') return canWrap ? 'adopt-plaintext-and-wrap' : 'adopt-plaintext';
    return canWrap ? 'decrypt' : 'locked';
}

/**
 * Where a key we are about to adopt (recovery key) or mint (start fresh) may be
 * persisted. `memory-only` = the wallet is denied: the key file is not touched
 * (a v11 file must stay readable by the wallet later) and nothing is written in
 * plaintext.
 */
export type KeyPersistTarget = 'wrap' | 'plaintext' | 'memory-only';

export function decideKeyPersist(input: { canWrap: boolean; keyring: KeyringState }): KeyPersistTarget {
    if (input.keyring === 'denied') return 'memory-only';
    return input.canWrap ? 'wrap' : 'plaintext';
}

/** The renderer-facing summary: enums and booleans only, never key material. */
export interface KeyringStatus {
    state: KeyringState;
    /** KDE Wallet / GNOME Keyring / system wallet (null when not applicable). */
    walletName: string | null;
    /** No key file existed when the wallet was refused: nothing has been lost yet. */
    firstRun: boolean;
    /** The wallet is denied AND the store is usable anyway (recovery key / plaintext key): show the unlock banner. */
    degraded: boolean;
}

export function buildKeyringStatus(input: {
    state: KeyringState;
    backend: string | null;
    firstRun: boolean;
    storeOk: boolean;
}): KeyringStatus {
    const applicable = input.state !== 'not-applicable';
    return {
        state: input.state,
        walletName: applicable ? walletNameForBackend(input.backend) : null,
        firstRun: input.state === 'denied' && input.firstRun,
        degraded: input.state === 'denied' && input.storeOk,
    };
}
