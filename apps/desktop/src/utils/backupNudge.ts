/**
 * Decision logic for the home screen's backup tile.
 *
 * Split out of HomePanel.tsx so it can be unit-tested without dragging the
 * whole component tree (and axios, and the DOM) into the test environment —
 * same reasoning as homePins.ts / inviteLimits.ts.
 *
 * The tile only exists when there's something to act on: a healthy backup
 * renders nothing at all rather than an "all good" row.
 */

export interface BackupNudge {
    critical: boolean; chip: string; title: string; body: string;
    /** Label of the tile's button; the tile always opens Settings -> Storage. Default "Back up now". */
    cta?: string;
}

/** A destination the user has to fix (services/backupIssues.ts), as the tile needs it. */
export type BackupDestIssue = 'drive' | 'local';

/** Why automatic backups aren't running, as recorded by useBackupAutoSchedule. */
export type BackupBlockedReason = 'no-passphrase' | 'last-run-failed';

const BACKUP_BODY =
    "Your history only exists on this device. If you lose it it's gone — by design, nobody can recover it for you.";
const BACKUP_STALLED_BODY =
    "Automatic backups are on but can't run without your passphrase — open Storage to re-enter it.";

/**
 * @param lastBackupAt epoch ms of the last SUCCESSFUL backup, or null if none.
 * @param opts.configured whether a real backup destination is set up.
 * @param opts.blocked why the schedule is stalled, if it is.
 * @param opts.now injectable clock — reading Date.now() inside a render would
 *                make it impure, and tests need determinism.
 *
 * This used to take only `lastBackupAt` and treat "no timestamp" as "you have
 * no backup yet". That reported the same thing for three very different
 * situations: a genuinely un-configured account, a configured one whose first
 * scheduled run simply hadn't fired, and a schedule permanently stalled on a
 * missing cached passphrase. Only the first deserves that wording, and the
 * last is the one that actually needs the user to do something.
 */
export function computeBackupNudge(
    lastBackupAt: number | null,
    opts: { configured?: boolean; blocked?: BackupBlockedReason | null; issue?: BackupDestIssue | null; now?: number } = {},
): BackupNudge | null {
    const { configured = false, blocked = null, issue = null, now = Date.now() } = opts;

    // A destination that cannot work until the user acts (Drive sign-in gone, saved
    // folder not allowed on this install). Without this the scheduler failed in
    // silence, run after run. A missing passphrase outranks it: that stalls every destination.
    if (issue && blocked !== 'no-passphrase') {
        return issue === 'drive'
            ? { critical: true, chip: 'Action needed', title: 'Google Drive backups are paused', body: 'Google Drive needs to be reconnected on this device. Open Storage to sign in again; your existing backup in Drive is untouched.', cta: 'Reconnect' }
            : { critical: true, chip: 'Action needed', title: "Cipherline can't use your backup folder", body: 'The saved backup folder is not available on this device. Open Storage to choose it again.', cta: 'Choose folder' };
    }

    if (!lastBackupAt) {
        if (blocked === 'no-passphrase') {
            return { critical: true, chip: 'Action needed', title: "Automatic backups aren't running", body: BACKUP_STALLED_BODY };
        }
        // Automatic backups are configured and simply haven't had their first
        // run yet: the user has done what this tile asks, so it goes away the
        // moment they set it up instead of lingering as a "pending" copy of
        // the same banner. If the schedule is actually stalled that is the
        // `blocked` case above, which stays.
        if (configured) return null;
        return { critical: false, chip: 'Needs attention', title: 'You have no backup yet', body: BACKUP_BODY };
    }

    // A stalled schedule matters even when an older backup exists — it means
    // everything since that backup is unprotected and silently staying that way.
    if (blocked === 'no-passphrase') {
        return { critical: true, chip: 'Action needed', title: "Automatic backups aren't running", body: BACKUP_STALLED_BODY };
    }

    const days = Math.floor((now - lastBackupAt) / 86_400_000);
    if (days < 7) return null;
    return {
        critical: days >= 30,
        chip: days >= 30 ? 'Action needed' : 'Needs attention',
        title: `Last backup was ${days} days ago`,
        body: BACKUP_BODY,
    };
}
