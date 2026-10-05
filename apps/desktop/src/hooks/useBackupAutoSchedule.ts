/**
 * useBackupAutoSchedule — periodic automatic backup to a local folder and/or
 * Google Drive, each on its own schedule.
 *
 * Runs in the renderer (fires while the window is open). On each tick it
 * works out which destinations are due (local: `intervalMs`, Drive:
 * `driveIntervalMs`, each measured from that destination's own last
 * confirmed-current time), checks a passphrase is cached, then exports +
 * encrypts the vault once and writes it only to the due destinations.
 * Drive gets its own clock because it can't update part of a file — every
 * backup there re-uploads the whole thing — so it's typically run less often.
 *
 * Config: `cipherline_backup_cfg_${userId}`
 *   { enabled, intervalMs, driveIntervalMs, localEnabled, localDir, driveEnabled, … }
 * Passphrase is cached in the OS-wrapped SecureStore (see driveBackup.ts).
 */

import secureLocalStore from '../utils/secureLocalStore';
import { trackActivity } from '../utils/freezeLog';
import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { runBackup, getCachedPassword, getLastBackupMs, getDestinationLastMs, DEFAULT_MAX_ATTACHMENT_BYTES } from '../services/driveBackup';

const CHECK_EVERY_MS = 5 * 60 * 1000; // 5 minutes

export interface BackupCfg {
    enabled: boolean;
    /** Local-folder interval. */
    intervalMs: number;
    /** Google Drive interval — separate because each Drive backup uploads
     *  the whole file again. Existing configs inherit `intervalMs`. */
    driveIntervalMs: number;
    localEnabled: boolean;
    localDir: string | null;
    driveEnabled: boolean;
    /** Display name of the chosen Drive folder (fallback target if no ID). */
    driveFolderName: string;
    /** Folder ID chosen via the Google Picker; takes priority over the name. */
    driveFolderId: string | null;
    /** Base name for the backup file, without extension. The destination
     *  holds exactly one file, `{backupFileBase}.enc`, rewritten in place.
     *  Defaults to `cipherline-backup-{hostname}` on first use. */
    backupFileBase: string;
    /** Bundle attachment ciphertext into the backup. */
    includeAttachments: boolean;
    /** Skip attachments larger than this (bytes); 0 = no limit. */
    maxAttachmentBytes: number;
}

const DEFAULT_CFG: BackupCfg = {
    enabled: false, intervalMs: 24 * 3600_000, driveIntervalMs: 7 * 86400_000,
    localEnabled: false, localDir: null, driveEnabled: false,
    driveFolderName: 'Cipherline Backups', driveFolderId: null,
    backupFileBase: 'cipherline-backup',
    includeAttachments: true, maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
};

export function readBackupCfg(userId: string): BackupCfg {
    try {
        const raw = secureLocalStore.getItem(`cipherline_backup_cfg_${userId}`);
        if (!raw) return { ...DEFAULT_CFG };
        const c = JSON.parse(raw);
        const intervalMs = typeof c?.intervalMs === 'number' ? c.intervalMs : DEFAULT_CFG.intervalMs;
        return {
            enabled: c?.enabled === true,
            intervalMs,
            // A config saved before Drive had its own clock keeps behaving
            // exactly as it did — same interval for both — until the user
            // changes it.
            driveIntervalMs: typeof c?.driveIntervalMs === 'number' ? c.driveIntervalMs : intervalMs,
            localEnabled: c?.localEnabled === true,
            localDir: typeof c?.localDir === 'string' ? c.localDir : null,
            driveEnabled: c?.driveEnabled === true,
            driveFolderName: typeof c?.driveFolderName === 'string' && c.driveFolderName.trim() ? c.driveFolderName : DEFAULT_CFG.driveFolderName,
            driveFolderId: typeof c?.driveFolderId === 'string' && c.driveFolderId ? c.driveFolderId : null,
            backupFileBase: typeof c?.backupFileBase === 'string' && c.backupFileBase.trim() ? c.backupFileBase.trim() : DEFAULT_CFG.backupFileBase,
            includeAttachments: c?.includeAttachments !== false,
            maxAttachmentBytes: typeof c?.maxAttachmentBytes === 'number' && c.maxAttachmentBytes >= 0 ? c.maxAttachmentBytes : DEFAULT_CFG.maxAttachmentBytes,
        };
    } catch {
        return { ...DEFAULT_CFG };
    }
}

export function writeBackupCfg(userId: string, cfg: BackupCfg): void {
    try { secureLocalStore.setItem(`cipherline_backup_cfg_${userId}`, JSON.stringify(cfg)); } catch { /* ignore */ }
}

/** Why automatic backups aren't currently running, or null when healthy.
 *  Written by the scheduler, read by the UI so a permanently-stalled
 *  schedule surfaces instead of failing invisibly. */
export type BackupBlockedReason = 'no-passphrase' | 'last-run-failed';

const BLOCKED_KEY = (uid: string) => `cipherline_backup_blocked_${uid}`;

function writeBackupBlocked(userId: string, reason: BackupBlockedReason | null): void {
    try {
        if (reason) secureLocalStore.setItem(BLOCKED_KEY(userId), reason);
        else secureLocalStore.removeItem(BLOCKED_KEY(userId));
    } catch { /* ignore */ }
}

/**
 * Whether this account has working backups — a real destination configured,
 * OR at least one backup already completed.
 *
 * The onboarding checklist used to key purely off `cfg.enabled`, so someone
 * who backs up manually to Drive on a regular basis had "Turn on automatic
 * backups" stuck permanently (and, because the checklist auto-dismisses on
 * completion, never got rid of the checklist either). Treating a completed
 * backup as satisfying the step matches what the user actually did.
 */
export function hasBackupSetUp(userId: string): boolean {
    try {
        if (getLastBackupMs(userId)) return true;
        const cfg = readBackupCfg(userId);
        const hasLocal = cfg.localEnabled && !!cfg.localDir;
        return cfg.enabled && (hasLocal || cfg.driveEnabled);
    } catch { return false; }
}

export function readBackupBlocked(userId: string): BackupBlockedReason | null {
    try {
        const v = secureLocalStore.getItem(BLOCKED_KEY(userId));
        return v === 'no-passphrase' || v === 'last-run-failed' ? v : null;
    } catch { return null; }
}

export function useBackupAutoSchedule() {
    const { user, token, deviceId, isAuthenticated } = useAuth();
    const inFlight = useRef(false);

    useEffect(() => {
        const userId = user?.user_id;
        if (!isAuthenticated || !userId || !token || !deviceId) return;
        if (!window.electronAPI) return;

        // Re-register the stored backup directory with the main process on every startup.
        // userPickedDirs in main.ts is in-memory and resets on Electron restart, so any
        // path stored in secureLocalStore would be rejected by fs:write-file without this.
        const cfg0 = readBackupCfg(userId);
        if (cfg0.localDir) {
            window.electronAPI?.registerDir?.(cfg0.localDir).catch(() => {});
        }

        const tick = async () => {
            if (inFlight.current) return;
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

            const cfg = readBackupCfg(userId);
            if (!cfg.enabled) return;

            // Build the destination set from config.
            const wantLocal = cfg.localEnabled && !!cfg.localDir;
            let wantDrive = cfg.driveEnabled;
            if (wantDrive) {
                const linked = await window.electronAPI?.gdriveAuthStatus?.().catch(() => null);
                wantDrive = !!linked?.linked;
            }
            if (!wantLocal && !wantDrive) return;

            // No cached passphrase means this hook can never run, silently,
            // on every tick forever. That used to be invisible: setCachedPassword
            // was only ever called from BackupSection's "Back up now", so a user
            // who configured everything and switched automatic backups on but
            // never pressed that button had a fully-configured UI and a
            // scheduler that did nothing — and a home screen insisting they had
            // no backup. Record it so the UI can say so (see readBackupBlocked).
            const password = await getCachedPassword();
            if (!password) {
                writeBackupBlocked(userId, 'no-passphrase');
                return;
            }

            // Each destination is due on its own clock.
            const now = Date.now();
            const due = (label: 'local' | 'drive', intervalMs: number) =>
                intervalMs > 0 && now - (getDestinationLastMs(userId, label) ?? 0) >= intervalMs;
            const dueLocal = wantLocal && due('local', cfg.intervalMs);
            const dueDrive = wantDrive && due('drive', cfg.driveIntervalMs);
            if (!dueLocal && !dueDrive) {
                writeBackupBlocked(userId, null);
                return;
            }

            inFlight.current = true;
            // Re-register right before writing in case Electron restarted since mount.
            if (dueLocal && cfg.localDir) {
                await window.electronAPI?.registerDir?.(cfg.localDir).catch(() => {});
            }
            try {
                const res = await runBackup({
                    userId, token, password,
                    includeAttachments: cfg.includeAttachments,
                    maxAttachmentBytes: cfg.maxAttachmentBytes,
                    // fileName was previously omitted here, so scheduled runs
                    // wrote under the DEFAULT base while manual runs used the
                    // configured one — two parallel backup sets in the same
                    // folder, each pruning and deduping against only its own.
                    destinations: {
                        localDir: dueLocal ? cfg.localDir : null, drive: dueDrive,
                        driveFolderName: cfg.driveFolderName, driveFolderId: cfg.driveFolderId,
                        fileName: cfg.backupFileBase,
                    },
                });
                // The stored Drive folder had gone stale (403/404) and this
                // run fell back to the default folder — stop pointing every
                // future scheduled run at the same dead folder.
                if (res.driveFolderRecovered) {
                    writeBackupCfg(userId, {
                        ...readBackupCfg(userId),
                        driveFolderId: res.driveFolderRecovered.folderId,
                        driveFolderName: res.driveFolderRecovered.folderName,
                    });
                }
                // runBackup stamps the last-backup timestamps itself.
                // A destination failing (e.g. Drive auth expired) is no
                // longer fatal to the OTHER due destination's attempt — only
                // flag the schedule as blocked when nothing due this tick
                // actually succeeded; a partial failure is logged but the
                // schedule is otherwise healthy.
                const succeededAny = !!(res.local || res.drive);
                const failedAny = !!(res.errors && Object.keys(res.errors).length);
                if (failedAny) console.warn('[backup] auto run partial failure', res.errors);
                writeBackupBlocked(userId, succeededAny ? null : (failedAny ? 'last-run-failed' : null));
            } catch (err) {
                console.warn('[backup] auto run failed', err);
                writeBackupBlocked(userId, 'last-run-failed');
            } finally {
                inFlight.current = false;
            }
        };

        const initial = setTimeout(() => { void trackActivity('backup:auto', tick); }, 45_000);
        const periodic = setInterval(() => { void trackActivity('backup:auto', tick); }, CHECK_EVERY_MS);
        return () => { clearTimeout(initial); clearInterval(periodic); };
    }, [isAuthenticated, user?.user_id, token, deviceId]);
}
