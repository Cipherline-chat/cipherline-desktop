/**
 * backupIssues — "a destination is broken and only the user can fix it".
 *
 * WHY THIS EXISTS (beta diagnostics, 2026-10-19 → 11-03). `backup_failed` kept
 * arriving from the same devices with the same two causes, run after run:
 *
 *   - `{dest: drive, stage: setup, reason: auth}` — Google no longer accepts the
 *     stored sign-in. Nothing self-heals: only a fresh consent fixes it.
 *   - `{dest: local, reason: path_not_allowed}` — the saved backup folder is not
 *     one this install was ever allowed into (see below).
 *
 * and the user was told neither. A failed scheduled run only set a flag
 * (`cipherline_backup_blocked_*` = 'last-run-failed') that no screen read; a
 * failed manual run showed one toast. Meanwhile the scheduler kept retrying a
 * destination that could not work, and once the main process dropped a revoked
 * Drive link it stopped trying Drive at all, with no word to anyone.
 *
 * This records the last failure per destination that the USER has to act on, so
 * Settings → Storage can say so beside that destination with the one action that
 * fixes it (Reconnect / Choose folder again), and Home can nudge. It is cleared
 * the moment that destination next succeeds, is reconnected, or is re-picked.
 *
 * Only a coarse kind is stored (never a message, path or account), device-local
 * and excluded from backups (backupRegistry.ts).
 *
 * WHY A SAVED FOLDER CAN BE "NOT ALLOWED": the main process lets the renderer
 * write only into folders a person picked in the OS dialog ON THIS INSTALL
 * (electron/fs-confinement.ts; the grant list lives in the device keystore). The
 * backup config, including `localDir`, travels INSIDE the backup
 * (`cipherline_backup_cfg_{uid}` is include:true in backupRegistry.ts), so a
 * restore onto a new device / reinstall / wiped profile brings back a folder path
 * this install never picked. Allowing it would defeat the confinement, so the
 * right answer is to say so and let the user pick the folder again.
 */

import secureLocalStore from '../utils/secureLocalStore';
import { backupFailureReason, type BackupFailureReason } from '../utils/backupFailureReason';

export type BackupDestKey = 'local' | 'drive';

/** `reconnect`: Google rejected the sign-in. `folder-denied`: this install may not
 *  write there. `folder-missing`: the folder no longer exists. */
export type BackupIssueKind = 'reconnect' | 'folder-denied' | 'folder-missing';

export interface BackupIssues {
    drive?: Extract<BackupIssueKind, 'reconnect'>;
    local?: Extract<BackupIssueKind, 'folder-denied' | 'folder-missing'>;
}

export const BACKUP_ISSUES_KEY = (uid: string) => `cipherline_backup_issues_${uid}`;

/** The issue a failure message means for a destination, or null if it is not one
 *  the user can fix by acting in Settings (network blips, a busy file, …). */
export function issueFromFailure(dest: BackupDestKey, message: string | undefined): BackupIssueKind | null {
    const reason: BackupFailureReason = backupFailureReason(message);
    if (dest === 'drive') return reason === 'auth' ? 'reconnect' : null;
    if (reason === 'path_not_allowed') return 'folder-denied';
    if (reason === 'dir_missing') return 'folder-missing';
    return null;
}

export function readBackupIssues(userId: string): BackupIssues {
    try {
        const raw = secureLocalStore.getItem(BACKUP_ISSUES_KEY(userId));
        if (!raw) return {};
        const p = JSON.parse(raw);
        const out: BackupIssues = {};
        if (p?.drive === 'reconnect') out.drive = 'reconnect';
        if (p?.local === 'folder-denied' || p?.local === 'folder-missing') out.local = p.local;
        return out;
    } catch { return {}; }
}

/** Set (or, with null, clear) one destination's issue. Returns whether anything changed. */
export function setBackupIssue(userId: string, dest: BackupDestKey, kind: BackupIssueKind | null): boolean {
    try {
        const cur = readBackupIssues(userId);
        if ((cur[dest] ?? null) === kind) return false;
        const next: BackupIssues = { ...cur };
        if (kind === null) delete next[dest];
        else if (dest === 'drive') next.drive = kind as 'reconnect';
        else next.local = kind as 'folder-denied' | 'folder-missing';
        if (Object.keys(next).length === 0) secureLocalStore.removeItem(BACKUP_ISSUES_KEY(userId));
        else secureLocalStore.setItem(BACKUP_ISSUES_KEY(userId), JSON.stringify(next));
        return true;
    } catch { return false; }
}

/**
 * Fold one finished run into the stored issues.
 *  - a destination that failed with a user-fixable cause gets its issue set;
 *  - a destination that SUCCEEDED has its issue cleared;
 *  - anything else (not attempted this run, or failed for a transient reason) is
 *    left exactly as it was, so a flaky network never hides a real "reconnect".
 */
export function recordRunIssues(
    userId: string,
    outcome: { errors?: Partial<Record<BackupDestKey, string>>; succeeded?: Partial<Record<BackupDestKey, boolean>> },
): boolean {
    let changed = false;
    for (const dest of ['local', 'drive'] as const) {
        const msg = outcome.errors?.[dest];
        if (msg !== undefined) {
            const kind = issueFromFailure(dest, msg);
            if (kind) changed = setBackupIssue(userId, dest, kind) || changed;
        } else if (outcome.succeeded?.[dest]) {
            changed = setBackupIssue(userId, dest, null) || changed;
        }
    }
    return changed;
}

export type FolderGrant = 'granted' | 'denied' | 'unknown';

/**
 * Ask the main process whether this install may write to the saved backup
 * folder (`fs:register-dir` answers `{ok:false}` for a folder no picker on this
 * install granted), and keep the stored issue in step with the answer. 'unknown'
 * = no bridge / the call failed: nothing is concluded and nothing is changed.
 * `changed` tells the caller to fire notifyBackupStateChanged() (not done here:
 * driveBackup.ts imports this module).
 */
export async function checkLocalFolderGrant(userId: string, dir: string): Promise<{ grant: FolderGrant; changed: boolean }> {
    const reg = await window.electronAPI?.registerDir?.(dir).catch(() => null);
    if (!reg) return { grant: 'unknown', changed: false };
    if (reg.ok === false) return { grant: 'denied', changed: setBackupIssue(userId, 'local', 'folder-denied') };
    const stale = readBackupIssues(userId).local === 'folder-denied';
    return { grant: 'granted', changed: stale ? setBackupIssue(userId, 'local', null) : false };
}

/** User-facing copy, shared by Settings and Home so the two never disagree. */
export const BACKUP_ISSUE_COPY: Record<BackupIssueKind, { title: string; body: string; action: string }> = {
    reconnect: {
        title: 'Google Drive needs to be reconnected',
        body: 'Google stopped accepting this device’s sign-in, so Drive backups are paused. Reconnect to resume — your existing backup in Drive is untouched.',
        action: 'Reconnect Google Drive',
    },
    'folder-denied': {
        title: 'Cipherline can’t use this backup folder yet',
        body: 'For your safety, Cipherline only writes to folders you pick on this computer. This one was saved from another install or backup — choose it again to allow it.',
        action: 'Choose folder',
    },
    'folder-missing': {
        title: 'This backup folder no longer exists',
        body: 'The folder was moved, renamed, or is on a drive that isn’t connected. Reconnect the drive, or choose a folder again.',
        action: 'Choose folder',
    },
};
