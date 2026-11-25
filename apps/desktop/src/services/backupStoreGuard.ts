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

export type BackupStoreBlock = 'locked' | 'unread' | 'not-ready' | 'partial';

export const BACKUP_STORE_UNREADABLE_MESSAGE =
    'Your data on this device couldn’t be read, so backing up now could overwrite a good backup with an empty one. Restart Cipherline and try again.';

/**
 * 'partial': the store loaded, but some records could not be read this launch
 * (secureLocalStore: UNREADABLE RECORDS). A backup would export the history
 * without them, and the backup writer drops what the new export no longer
 * holds — so the backup, possibly the only other copy of those records, would
 * lose them too.
 */
export const BACKUP_STORE_PARTIAL_MESSAGE =
    'Some of your data on this device couldn’t be read, so a backup now would leave it out of your backup. Nothing was deleted. Restart Cipherline and try again.';

/** What to tell the user about a block. */
export function backupStoreBlockMessage(block: BackupStoreBlock): string {
    return block === 'partial' ? BACKUP_STORE_PARTIAL_MESSAGE : BACKUP_STORE_UNREADABLE_MESSAGE;
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
        if (secureLocalStore.unreadableRecordCount() > 0) return 'partial';
        return null;
    } catch {
        // Not hydrated (or anything else unexpected): the safe answer is no.
        return 'not-ready';
    }
}

/** Throw BackupStoreUnreadableError when a backup of `userId` must not run. */
export function assertBackupStoreReadable(userId: string): void {
    const block = backupStoreBlock(userId);
    if (block) throw new BackupStoreUnreadableError(block);
}
