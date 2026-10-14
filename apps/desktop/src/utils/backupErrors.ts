/**
 * Typed failure for "the passphrase does not unlock this backup".
 *
 * Raised at the decrypt boundary — an AES-GCM authentication failure on the
 * header commit slots or on the index frame (v3/v4 containers), or on the
 * whole-file blob (legacy v1/v2) — because with a correct passphrase and an
 * intact file those can only fail on a wrong key. Callers (the restore
 * prompt) use `instanceof` to tell this apart from "no backup found",
 * network, corruption and account-mismatch errors, which keep their own
 * messages. Kept in its own module so both `backupContainer` and `crypto`
 * can import it without a cycle.
 */
export class BackupWrongPasswordError extends Error {
    constructor(message = 'Could not decrypt this backup with the given passphrase.') {
        super(message);
        this.name = 'BackupWrongPasswordError';
    }
}
