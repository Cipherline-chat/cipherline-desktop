import { describe, it, expect } from 'vitest';
import {
    KEYRING_PROMPT_AFTER_MS, buildKeyringStatus, classifyKeyringOutcome, decideKeyInit, decideKeyPersist,
    isKeyringBackend, walletNameForBackend,
    type KeyFileState, type KeyInitAction, type KeyringState,
} from './keyring-prompt';

const BACKENDS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'];
const KEY_FILES: KeyFileState[] = ['absent', 'plaintext', 'wrapped'];
const STATES: KeyringState[] = ['not-applicable', 'unlocked', 'denied', 'no-service'];

describe('classifyKeyringOutcome: prompting / unlocked / cancelled / no service', () => {
    const base = { platform: 'linux', backend: 'kwallet5', encryptionAvailable: false, firstCallMs: 5_000 };

    it('unlocked: the keyring answered', () => {
        expect(classifyKeyringOutcome({ ...base, encryptionAvailable: true, firstCallMs: 3_000 })).toBe('unlocked');
        expect(classifyKeyringOutcome({ ...base, encryptionAvailable: true, firstCallMs: 2 })).toBe('unlocked');
    });

    it('denied: failed AFTER a human-scale wait (cancelled, closed, or the 25 s KWallet timeout)', () => {
        expect(classifyKeyringOutcome(base)).toBe('denied');
        expect(classifyKeyringOutcome({ ...base, firstCallMs: 25_082 })).toBe('denied');
        expect(classifyKeyringOutcome({ ...base, backend: 'gnome_libsecret', firstCallMs: 7_400 })).toBe('denied');
    });

    it('no-service: failed immediately (no daemon / wallet disabled)', () => {
        expect(classifyKeyringOutcome({ ...base, firstCallMs: 3 })).toBe('no-service');
        expect(classifyKeyringOutcome({ ...base, firstCallMs: 59 })).toBe('no-service');
    });

    it('the boundary is exactly KEYRING_PROMPT_AFTER_MS', () => {
        expect(classifyKeyringOutcome({ ...base, firstCallMs: KEYRING_PROMPT_AFTER_MS - 1 })).toBe('no-service');
        expect(classifyKeyringOutcome({ ...base, firstCallMs: KEYRING_PROMPT_AFTER_MS })).toBe('denied');
    });

    it('every real keyring backend is recognised', () => {
        for (const backend of BACKENDS) expect(classifyKeyringOutcome({ ...base, backend })).toBe('denied');
    });

    it('not-applicable: basic_text, unknown or missing backend (behaves as it always did)', () => {
        for (const backend of ['basic_text', 'something_new', '', null]) {
            expect(classifyKeyringOutcome({ ...base, backend })).toBe('not-applicable');
        }
    });

    it('NEGATIVE CONTROL: Windows and macOS are never classified, whatever the call reports', () => {
        for (const platform of ['win32', 'darwin', 'freebsd']) {
            for (const encryptionAvailable of [true, false]) {
                for (const firstCallMs of [0, 30, 400, 30_000]) {
                    for (const backend of [...BACKENDS, null]) {
                        expect(classifyKeyringOutcome({ platform, backend, encryptionAvailable, firstCallMs })).toBe('not-applicable');
                    }
                }
            }
        }
    });
});

/** The pre-change logic of SecureStore._doInitialize, written out as a decision. */
function legacyDecision(keyFile: KeyFileState, canWrap: boolean): KeyInitAction {
    if (keyFile === 'absent') return canWrap ? 'wrap-new-key' : 'plaintext-new-key';
    if (keyFile === 'plaintext') return canWrap ? 'adopt-plaintext-and-wrap' : 'adopt-plaintext';
    return canWrap ? 'decrypt' : 'locked';
}

const GENERATES_OR_WRITES: ReadonlySet<KeyInitAction> = new Set<KeyInitAction>([
    'wrap-new-key', 'plaintext-new-key', 'adopt-plaintext-and-wrap',
]);

describe('decideKeyInit: a refused wallet never regenerates keys or writes plaintext', () => {
    it('INVARIANT over every input: denied never generates a key, never writes a key file', () => {
        for (const keyFile of KEY_FILES) {
            for (const canWrap of [true, false]) {
                const action = decideKeyInit({ keyFile, canWrap, keyring: 'denied' });
                expect(GENERATES_OR_WRITES.has(action), `denied/${keyFile}/canWrap=${canWrap} -> ${action}`).toBe(false);
            }
        }
    });

    it('first run, wallet refused: refuse (nothing generated, nothing written)', () => {
        expect(decideKeyInit({ keyFile: 'absent', canWrap: false, keyring: 'denied' })).toBe('refuse-first-run');
    });

    it('existing wrapped key, wallet refused: locked (file untouched)', () => {
        expect(decideKeyInit({ keyFile: 'wrapped', canWrap: false, keyring: 'denied' })).toBe('locked');
    });

    it('plaintext key from an earlier run, wallet refused: used as it is, never rewritten', () => {
        expect(decideKeyInit({ keyFile: 'plaintext', canWrap: false, keyring: 'denied' })).toBe('adopt-plaintext');
    });

    it('NEGATIVE CONTROL: the pre-change logic WOULD have written plaintext on a refused first run', () => {
        // This is the bug. If the invariant test above were vacuous, this would not be caught.
        expect(legacyDecision('absent', false)).toBe('plaintext-new-key');
        expect(GENERATES_OR_WRITES.has(legacyDecision('absent', false))).toBe(true);
    });

    it('NEGATIVE CONTROL: a denied wallet is not mistaken for a missing one (that is the bug)', () => {
        // Same inputs except the classification: no-service keeps the old, visible-dialog behaviour.
        expect(decideKeyInit({ keyFile: 'absent', canWrap: false, keyring: 'no-service' })).toBe('plaintext-new-key');
        expect(decideKeyInit({ keyFile: 'absent', canWrap: false, keyring: 'denied' })).not.toBe('plaintext-new-key');
    });

    it('everything except denied is EXACTLY the pre-change decision (Windows / macOS / no-service / unlocked)', () => {
        for (const keyring of STATES.filter(s => s !== 'denied')) {
            for (const keyFile of KEY_FILES) {
                for (const canWrap of [true, false]) {
                    expect(decideKeyInit({ keyFile, canWrap, keyring })).toBe(legacyDecision(keyFile, canWrap));
                }
            }
        }
    });
});

describe('decideKeyPersist', () => {
    it('denied: memory-only, never plaintext, never touches the key file', () => {
        expect(decideKeyPersist({ canWrap: false, keyring: 'denied' })).toBe('memory-only');
        expect(decideKeyPersist({ canWrap: true, keyring: 'denied' })).toBe('memory-only');
    });
    it('otherwise the pre-change behaviour: wrap when possible, plaintext when there is no keystore', () => {
        for (const keyring of STATES.filter(s => s !== 'denied')) {
            expect(decideKeyPersist({ canWrap: true, keyring })).toBe('wrap');
            expect(decideKeyPersist({ canWrap: false, keyring })).toBe('plaintext');
        }
    });
});

describe('names and status', () => {
    it('names the wallet the desktop is actually asking about', () => {
        expect(walletNameForBackend('kwallet5')).toBe('KDE Wallet');
        expect(walletNameForBackend('kwallet6')).toBe('KDE Wallet');
        expect(walletNameForBackend('kwallet')).toBe('KDE Wallet');
        expect(walletNameForBackend('gnome_libsecret')).toBe('GNOME Keyring');
        expect(walletNameForBackend('basic_text')).toBe('system wallet');
        expect(walletNameForBackend(null)).toBe('system wallet');
    });

    it('isKeyringBackend is an allow-list', () => {
        for (const b of BACKENDS) expect(isKeyringBackend(b)).toBe(true);
        for (const b of ['basic_text', 'kwallet7', 'GNOME_LIBSECRET', '', null, undefined]) expect(isKeyringBackend(b)).toBe(false);
    });

    it('first run only counts when the wallet was refused; degraded needs a usable store', () => {
        expect(buildKeyringStatus({ state: 'denied', backend: 'kwallet5', firstRun: true, storeOk: false }))
            .toEqual({ state: 'denied', walletName: 'KDE Wallet', firstRun: true, degraded: false });
        expect(buildKeyringStatus({ state: 'denied', backend: 'gnome_libsecret', firstRun: false, storeOk: true }))
            .toEqual({ state: 'denied', walletName: 'GNOME Keyring', firstRun: false, degraded: true });
        expect(buildKeyringStatus({ state: 'unlocked', backend: 'kwallet5', firstRun: true, storeOk: true }))
            .toEqual({ state: 'unlocked', walletName: 'KDE Wallet', firstRun: false, degraded: false });
        expect(buildKeyringStatus({ state: 'not-applicable', backend: null, firstRun: false, storeOk: true }))
            .toEqual({ state: 'not-applicable', walletName: null, firstRun: false, degraded: false });
    });

    it('the status carries enums and flags only (no key material can ride along)', () => {
        const s = buildKeyringStatus({ state: 'denied', backend: 'kwallet5', firstRun: false, storeOk: true });
        expect(Object.keys(s).sort()).toEqual(['degraded', 'firstRun', 'state', 'walletName']);
    });
});
