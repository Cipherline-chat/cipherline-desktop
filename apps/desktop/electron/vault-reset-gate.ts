/**
 * vault-reset-gate — the two keystore operations that REPLACE the device
 * master key: "start fresh" (factory reset) and "unlock with recovery key".
 *
 * Both used to run on a bare renderer request. With renderer code under an
 * attacker's control that was (a) a one-call wipe of the device identity, and
 * (b) worse, factory-reset followed by recover-with-key(attacker's key): the
 * vault is empty, so there is nothing to validate the key against, and every
 * secret the device mints afterwards is sealed under a key the attacker holds.
 *
 * The legitimate callers are only ever the two boot screens shown when the
 * keystore cannot be used — StorageLockedScreen (key file present but not
 * unwrappable) and StorageCorruptedScreen (vault envelope unreadable, moved
 * aside). So:
 *   - neither operation is available while the keystore is healthy: a
 *     working master key is never replaced or destroyed from the renderer;
 *   - factory reset additionally needs a main-process confirmation dialog;
 *   - a recovery key that can be checked against an existing entry proves
 *     itself (a wrong key is rejected by the store), so it needs no dialog;
 *     one that cannot be checked (empty vault) is adopted only after a
 *     main-process confirmation.
 * A declined dialog suppresses further prompts for a cooldown, like the
 * recovery-key reveal gate, so a script cannot spam the user into a click.
 *
 * No `electron` import; main.ts injects the store and the dialog.
 */

export const VAULT_GATE_DECLINE_COOLDOWN_MS = 30_000;

export type VaultConfirmKind = 'factory-reset' | 'adopt-unverified-key';

export interface VaultGateDeps {
    status: () => 'ok' | 'locked' | 'uninitialized';
    /** This session's vault envelope was corrupt and moved aside. */
    isCorrupt: () => boolean;
    /** No entry exists to validate a recovery key against. */
    isEmpty: () => boolean;
    confirm: (kind: VaultConfirmKind) => Promise<boolean>;
    factoryReset: () => void;
    /** Validates against an existing entry when there is one; persists on success. */
    recoverWithKey: (keyB64: string) => boolean;
    now?: () => number;
}

export type VaultGateRefusal = 'healthy' | 'declined' | 'busy' | 'invalid';

export interface VaultGate {
    factoryReset(): Promise<{ ok: true } | { ok: false; reason: VaultGateRefusal }>;
    recoverWithKey(keyB64: unknown): Promise<{ ok: true } | { ok: false; reason: VaultGateRefusal | 'wrong-key' }>;
}

export function createVaultGate(deps: VaultGateDeps): VaultGate {
    const now = deps.now ?? Date.now;
    let inFlight = false;
    let declinedUntil = 0;

    /** Recovery is for a keystore that cannot be used — never a healthy one. */
    const needsRecovery = () => deps.status() === 'locked' || deps.isCorrupt();

    async function ask(kind: VaultConfirmKind): Promise<{ ok: true } | { ok: false; reason: 'declined' | 'busy' }> {
        if (inFlight) return { ok: false, reason: 'busy' };
        if (now() < declinedUntil) return { ok: false, reason: 'declined' };
        inFlight = true;
        let approved = false;
        try {
            approved = await deps.confirm(kind);
        } catch {
            approved = false; // a dialog that failed to open is not consent
        } finally {
            inFlight = false;
        }
        if (!approved) {
            declinedUntil = now() + VAULT_GATE_DECLINE_COOLDOWN_MS;
            return { ok: false, reason: 'declined' };
        }
        return { ok: true };
    }

    return {
        async factoryReset() {
            if (!needsRecovery()) return { ok: false, reason: 'healthy' };
            const c = await ask('factory-reset');
            if (!c.ok) return c;
            // Re-check: the state may have changed while the dialog was open.
            if (!needsRecovery()) return { ok: false, reason: 'healthy' };
            deps.factoryReset();
            return { ok: true };
        },

        async recoverWithKey(keyB64: unknown) {
            if (typeof keyB64 !== 'string' || !keyB64.trim() || keyB64.length > 256) return { ok: false, reason: 'invalid' };
            if (!needsRecovery()) return { ok: false, reason: 'healthy' };
            if (deps.isEmpty()) {
                const c = await ask('adopt-unverified-key');
                if (!c.ok) return c;
                if (!needsRecovery()) return { ok: false, reason: 'healthy' };
            }
            return deps.recoverWithKey(keyB64.trim()) ? { ok: true } : { ok: false, reason: 'wrong-key' };
        },
    };
}
