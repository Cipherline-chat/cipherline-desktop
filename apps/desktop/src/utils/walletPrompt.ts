/**
 * Linux wallet prompt: renderer-side copy and the "which screen" decision.
 * Kept out of the components so it is testable under vitest (node env) and so
 * the wording is reviewed in one place. The main-process half is
 * electron/keyring-prompt.ts; the two only share the shape below, over IPC
 * (`window.electronAPI.getKeyringStatus`), and nothing under src/ may import
 * from electron/ (it would nest the electron build output).
 */

export type KeyringState = 'not-applicable' | 'unlocked' | 'denied' | 'no-service';

export interface KeyringStatus {
    state: KeyringState;
    /** "KDE Wallet" / "GNOME Keyring" / "system wallet"; null when not applicable. */
    walletName: string | null;
    /** No key file existed when the wallet was refused: nothing has been lost yet. */
    firstRun: boolean;
    /** Wallet refused, but the store is usable (recovery key / earlier plaintext key). */
    degraded: boolean;
    /** Main process is watching the wallet and will reopen Cipherline by itself once it is unlocked. */
    watching?: boolean;
}

const KNOWN: ReadonlySet<string> = new Set(['KDE Wallet', 'GNOME Keyring', 'system wallet']);

/** Defensive: the name comes over IPC, so only ever show one of the known names. */
export function safeWalletName(name: string | null | undefined): string {
    return typeof name === 'string' && KNOWN.has(name) ? name : 'system wallet';
}

/** Validates whatever came over the bridge; anything unexpected is "no wallet problem". */
export function normalizeKeyringStatus(raw: unknown): KeyringStatus | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const state = r.state;
    if (state !== 'not-applicable' && state !== 'unlocked' && state !== 'denied' && state !== 'no-service') return null;
    return {
        state,
        walletName: typeof r.walletName === 'string' ? safeWalletName(r.walletName) : null,
        firstRun: r.firstRun === true,
        degraded: r.degraded === true,
        ...(r.watching === true ? { watching: true } : {}),
    };
}

/** The locked screen is the wallet screen only when the wallet itself was refused. */
export function isWalletRefused(s: KeyringStatus | null): s is KeyringStatus {
    return s !== null && s.state === 'denied';
}

export interface WalletScreenCopy {
    title: string;
    body: string;
    /** What losing the wallet means, in plain words: shown as its own paragraph. */
    consequence: string;
    tryAgain: string;
    useRecoveryKey: string;
    /** Only when the main process is watching the wallet: Cipherline reopens by itself once it is unlocked. */
    autoRetryNote: string | null;
}

export const WALLET_AUTO_RETRY_NOTE = 'If you unlock the wallet now, Cipherline reopens on its own. You can also press Try again.';

export function walletScreenCopy(s: KeyringStatus): WalletScreenCopy {
    const wallet = safeWalletName(s.walletName);
    if (s.firstRun) {
        return {
            title: 'Cipherline couldn’t open your wallet',
            body:
                `Cipherline keeps your encryption keys in your ${wallet}, so they stay locked when you’re signed out. ` +
                `The ${wallet} wasn’t unlocked.`,
            consequence:
                'Nothing has been saved on this device yet, so nothing is lost. But keys created now wouldn’t be protected by your wallet, ' +
                'so Cipherline is waiting for it.',
            tryAgain: 'Try again',
            useRecoveryKey: 'Use my recovery key',
            autoRetryNote: s.watching ? WALLET_AUTO_RETRY_NOTE : null,
        };
    }
    return {
        title: 'Cipherline couldn’t open your wallet',
        body:
            `Cipherline keeps your encryption keys in your ${wallet}, so they stay locked when you’re signed out. ` +
            `The ${wallet} wasn’t unlocked.`,
        consequence:
            'The messages and keys already on this device can’t be opened without it, and without the wallet they would be lost. ' +
            'Nothing has been changed or deleted. Try again and enter your password in the wallet window.',
        tryAgain: 'Try again',
        useRecoveryKey: 'Use my recovery key',
        autoRetryNote: s.watching ? WALLET_AUTO_RETRY_NOTE : null,
    };
}

export interface WalletBannerCopy {
    title: string;
    description: string;
    action: string;
    dismiss: string;
}

export function walletBannerCopy(s: KeyringStatus): WalletBannerCopy {
    const wallet = safeWalletName(s.walletName);
    return {
        title: `${wallet} is locked`,
        description:
            `Cipherline is running without it, so your encryption keys aren’t protected by your wallet this session. ` +
            'Unlock it to keep them safe across restarts.',
        action: 'Unlock wallet',
        dismiss: 'Dismiss until next launch',
    };
}
