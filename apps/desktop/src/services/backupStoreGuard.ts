/**
 * No backup is written from a store that did not load.
 *
 * WHY: when this device's encrypted store could not be read (StorageReadFailedScreen
 * → "Continue anyway", or an account whose records failed to load), the app runs
 * on stand-in empty state. A backup taken then exports that stand-in — a vault
 * with almost nothing in it — and writes it over the destination's existing
 * backup file, which is the user's one good copy. Locked and not-yet-loaded
 * stores read as empty in exactly the same way.
 *
 * The check runs inside runBackup (so the manual button, the scheduler and any
 * future caller are all covered by construction, for the local folder and
 * Google Drive alike) and again after the export, because message history loads
 * in a second phase that can itself fail during the export.
 */
import secureLocalStore from '../utils/secureLocalStore';
import { recordBackupDiag } from '../utils/backupDiagnostics';

export type BackupStoreBlock = 'locked' | 'unread' | 'not-ready';

export const BACKUP_STORE_UNREADABLE_MESSAGE =
    'Your data on this device couldn’t be read, so backing up now could overwrite a good backup with an empty one. Restart Cipherline and try again.';

/** What to tell the user about a block (one message for every kind: restart and try again). */
export function backupStoreBlockMessage(_block?: BackupStoreBlock): string {
    return BACKUP_STORE_UNREADABLE_MESSAGE;
}

export class BackupStoreUnreadableError extends Error {
    readonly reason: BackupStoreBlock;
    constructor(reason: BackupStoreBlock) {
        super(backupStoreBlockMessage(reason));
        this.name = 'BackupStoreUnreadableError';
        this.reason = reason;
    }
}

/** Why a backup of `userId` must not run right now, or null when it may. */
export function backupStoreBlock(userId: string): BackupStoreBlock | null {
    try {
        if (secureLocalStore.isLocked()) return 'locked';
        if (secureLocalStore.hasLoadFailure()) return 'unread';
        if (!secureLocalStore.isAccountReady(userId)) return 'not-ready';
        // NOT 'partial': a store that loaded minus some unreadable records IS backed
        // up — backupHold.ts keeps the previous backup's copy of what it cannot
        // read. Refusing here (as this did until 2026-11-26) could never clear: a
        // restart reads the same damaged records, so the user's backups stopped for
        // good while the rest of their data went unprotected.
        return null;
    } catch {
        // Not hydrated (or anything else unexpected): the safe answer is no.
        return 'not-ready';
    }
}

/** Throw BackupStoreUnreadableError when a backup of `userId` must not run. */
export function assertBackupStoreReadable(userId: string): void {
    const block = backupStoreBlock(userId);
    if (block) {
        const err = new BackupStoreUnreadableError(block);
        // A refusal is a failed backup like any other: the report must say so.
        recordBackupDiag('backup', { ok: false, step: 'guard', err });
        throw err;
    }
}
