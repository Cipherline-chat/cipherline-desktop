/**
 * A backup failure message → a short reason CODE for beta diagnostics.
 *
 * Only the code leaves the device (`backup_failed {dest, stage, reason}`); the
 * message itself never does — it can carry a folder path, a file name or a
 * Drive id. The codes are a closed set (BACKUP_FAILURE_REASONS), so nothing in
 * the message can be smuggled out through them.
 *
 * ── Why this is finer than it used to be (2026-10-19) ────────────────────────
 * Eight `backup_failed {stage:'write', reason:'other'}` events from one device
 * (local AND Google Drive, 30 minutes) said only "something in the write phase
 * that is not auth / space / verify / network". Everything the write phase can
 * actually throw — a filesystem errno from main, a main-process IPC handler
 * that does not exist in that build, a directory that is gone, a path main
 * refuses, a write session main has forgotten, an AES-GCM failure, a Drive
 * HTTP status — all collapsed into that one bucket. Each now has its own code,
 * so the next report names the failing step.
 *
 * Order matters: an errno is checked BEFORE the old auth rule, because Node's
 * EACCES text ("permission denied") used to read as a Google auth problem.
 */

export const BACKUP_FAILURE_REASONS = [
    // Long-standing codes (kept: dashboards already group by them).
    'auth', 'space', 'verify', 'network', 'bridge', 'other',
    // Filesystem errno classes from main (local destination, temp files).
    'fs_not_found', 'fs_access', 'fs_busy', 'fs_read_only', 'fs_too_many_files', 'fs_other',
    // Main-process boundaries.
    'ipc_missing',        // "No handler registered for …": renderer and main are different builds
    'path_not_allowed',   // main refused the path (not a picked / registered folder)
    'dir_missing',        // the chosen backup folder no longer exists
    'session_lost',       // main has no record of the write session (main restarted / reaped)
    'invalid_args',       // main rejected the call's arguments (file name, mode, …)
    // Content.
    'crypto',             // WebCrypto / AES-GCM failure while sealing records
    'aborted',            // the run was cancelled / an abort signal fired
    'container',          // the container writer's own state / bounds check (a bug, not the disk)
    // Google Drive HTTP statuses that are not auth (401/403) or a 5xx.
    'drive_rate_limited', 'drive_not_found', 'drive_conflict', 'drive_http_4xx',
] as const;

export type BackupFailureReason = typeof BACKUP_FAILURE_REASONS[number];

const ERRNO_RE = /\b(E[A-Z]{2,15})\b(?::| \()/;

function errnoReason(code: string): BackupFailureReason | null {
    switch (code) {
        case 'ENOSPC': case 'EDQUOT': case 'EFBIG': return 'space';
        case 'ENOENT': case 'ENOTDIR': return 'fs_not_found';
        case 'EACCES': case 'EPERM': return 'fs_access';
        case 'EBUSY': case 'ETXTBSY': case 'EAGAIN': return 'fs_busy';
        case 'EROFS': return 'fs_read_only';
        case 'EMFILE': case 'ENFILE': return 'fs_too_many_files';
        case 'EIO': case 'EISDIR': case 'EEXIST': case 'EINVAL': case 'ENAMETOOLONG': case 'EXDEV': case 'ELOOP': return 'fs_other';
        default: return null;
    }
}

/** HTTP status carried by a Drive helper's message ("… HTTP 404", "status 429"). */
function httpStatus(m: string): number | null {
    const hit = /\b(?:HTTP|status|failed:)[ :]*(\d{3})\b/i.exec(m);
    return hit ? Number(hit[1]) : null;
}

export function backupFailureReason(message: string | undefined): BackupFailureReason {
    const m = message ?? '';
    if (!m) return 'other';

    // Main-process boundary problems first: they say WHY the step could not run at all.
    if (/No handler registered for/i.test(m)) return 'ipc_missing';
    if (/bridge not loaded|is not a function|electronAPI/i.test(m)) return 'bridge';
    if (/Path outside allowed root|Refusing to/i.test(m)) return 'path_not_allowed';
    if (/Backup directory does not exist/i.test(m)) return 'dir_missing';
    if (/Unknown backup write session/i.test(m)) return 'session_lost';
    if (/Invalid backup (?:dir|filename|write mode)|Invalid path\b/i.test(m)) return 'invalid_args';

    const errno = ERRNO_RE.exec(m)?.[1];
    if (errno) {
        const r = errnoReason(errno);
        if (r) return r;
        if (/^ECONN|^ETIMEDOUT$|^ENOTFOUND$|^EAI_|^ENETUNREACH$|^EHOSTUNREACH$|^EPIPE$/.test(errno)) return 'network';
    }

    const status = httpStatus(m);
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'drive_rate_limited';
    if (status === 404) return 'drive_not_found';
    if (status === 409 || status === 412) return 'drive_conflict';
    if (status !== null && status >= 500) return 'network';
    if (status !== null && status >= 400) return 'drive_http_4xx';

    if (/not (?:connected|linked)|session expired|reconnect|auth|token|grant|unauthori[sz]ed/i.test(m)) return 'auth';
    if (/quota|storage|space|disk full|ENOSPC/i.test(m)) return 'space';
    if (/verif|doesn't match|read back|could not be read|stored \d+ bytes but/i.test(m)) return 'verify';
    if (/Container already finished|out of range|record (?:is truncated|length mismatch)/i.test(m)) return 'container';
    if (/AbortError|aborted|cancell?ed/i.test(m)) return 'aborted';
    if (/OperationError|decrypt|encrypt|cipher|crypto/i.test(m)) return 'crypto';
    if (/network|fetch|timeout|timed out|ECONN|offline|net::ERR_/i.test(m)) return 'network';
    if (/permission/i.test(m)) return 'auth';
    return 'other';
}

/**
 * WHICH kind of auth failure a Drive message was (only meaningful when
 * `backupFailureReason(m) === 'auth'`). `reason: 'auth'` alone could not say
 * whether a refresh token had been revoked or expired (the user must
 * reconnect), the link was already gone, or Google answered 401/403 to an
 * otherwise valid link, so a week of `{drive, setup, auth}` events from one
 * device could not be explained from the report. Sent as `cause`; a closed
 * set, never message text.
 */
export const BACKUP_AUTH_CAUSES = [
    'revoked',         // invalid_grant / unauthorized_client: electron/googleDriveAuth.ts wiped the link
    'refresh_failed',  // the token endpoint refused a refresh for some other reason (e.g. invalid_client)
    'not_linked',      // no refresh token and no live access token, or the renderer saw "not connected"
    'session_expired', // Drive answered 401 while creating the folder
    'http_401',
    'http_403',
] as const;
export type BackupAuthCause = typeof BACKUP_AUTH_CAUSES[number];

export function backupAuthCause(message: string | undefined): BackupAuthCause | null {
    const m = message ?? '';
    if (!m || backupFailureReason(m) !== 'auth') return null;
    if (/token revoked|re-?link/i.test(m)) return 'revoked';
    if (/token refresh failed/i.test(m)) return 'refresh_failed';
    if (/session expired|reconnect/i.test(m)) return 'session_expired';
    if (/not (?:connected|linked)/i.test(m)) return 'not_linked';
    const status = httpStatus(m);
    if (status === 401) return 'http_401';
    if (status === 403) return 'http_403';
    return null;
}

/** `{ reason }` plus `cause` when it is an auth failure with a known cause. */
export function backupFailureDetail(message: string | undefined): { reason: BackupFailureReason; cause?: BackupAuthCause } {
    const reason = backupFailureReason(message);
    const cause = reason === 'auth' ? backupAuthCause(message) : null;
    return cause ? { reason, cause } : { reason };
}
