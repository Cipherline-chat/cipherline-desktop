import { describe, expect, it } from 'vitest';
import { BACKUP_FAILURE_REASONS, backupFailureReason } from './backupFailureReason';

// What the write phase can really throw, as the renderer sees it (an IPC
// rejection is re-wrapped by Electron as "Error invoking remote method …").
const ipc = (channel: string, inner: string) => `Error invoking remote method '${channel}': Error: ${inner}`;

describe('backupFailureReason', () => {
    it.each([
        // main-process boundaries
        [ipc('backup:open-write', "No handler registered for 'backup:open-write'"), 'ipc_missing'],
        ['Desktop bridge not loaded. Fully quit and re-run the app.', 'bridge'],
        ['window.electronAPI.backupOpenWrite is not a function', 'bridge'],
        [ipc('backup:open-write', 'Path outside allowed root: C:\\Users\\x\\Backups'), 'path_not_allowed'],
        [ipc('backup:open-write', 'Backup directory does not exist: D:\\gone'), 'dir_missing'],
        [ipc('backup:write-chunk', 'Unknown backup write session'), 'session_lost'],
        [ipc('backup:open-write', 'Invalid backup filename — must end in .enc with no path separators'), 'invalid_args'],
        // filesystem errno (Node's "CODE: text, syscall 'path'")
        [ipc('backup:commit', "ENOENT: no such file or directory, rename 'a.partial' -> 'a.enc'"), 'fs_not_found'],
        [ipc('backup:open-write', "EACCES: permission denied, open 'D:\\b\\x.enc.partial'"), 'fs_access'],
        [ipc('backup:open-write', "EPERM: operation not permitted, open 'x'"), 'fs_access'],
        [ipc('backup:commit', "EBUSY: resource busy or locked, rename 'x' -> 'y'"), 'fs_busy'],
        [ipc('backup:open-write', "EROFS: read-only file system, open 'x'"), 'fs_read_only'],
        [ipc('backup:open-write', "EMFILE: too many open files, open 'x'"), 'fs_too_many_files'],
        [ipc('backup:write-chunk', "EIO: i/o error, write"), 'fs_other'],
        [ipc('backup:write-chunk', "ENOSPC: no space left on device, write"), 'space'],
        // Drive HTTP statuses
        ['Drive upload failed: HTTP 429 {"error":"rateLimitExceeded"}', 'drive_rate_limited'],
        ['Drive query failed: 404', 'drive_not_found'],
        ['Drive upload did not complete: HTTP 412', 'drive_conflict'],
        ['Drive upload could not start: HTTP 400', 'drive_http_4xx'],
        ['Drive upload failed: HTTP 401', 'auth'],
        ['Drive query failed: 403', 'auth'],
        ['Drive upload failed: HTTP 503', 'network'],
        // long-standing classes keep their codes
        ['Google Drive is not connected.', 'auth'],
        ['The user has exceeded their Drive storage quota', 'space'],
        ['Backup was written but could not be read back.', 'verify'],
        ['Drive stored 10 bytes but 12 were uploaded', 'verify'],
        ['Failed to fetch', 'network'],
        ['net::ERR_INTERNET_DISCONNECTED', 'network'],
        [ipc('gdrive:upload', 'connect ECONNRESET 1.2.3.4:443'), 'network'],
        // content / internal
        ['OperationError: The operation failed for an operation-specific reason', 'crypto'],
        ['The operation was aborted.', 'aborted'],
        ['Container already finished', 'container'],
        ['writeAt out of range', 'container'],
        ['something nobody anticipated', 'other'],
        ['', 'other'],
    ])('%s -> %s', (message, expected) => {
        expect(backupFailureReason(message)).toBe(expected);
    });

    it('treats undefined as other', () => {
        expect(backupFailureReason(undefined)).toBe('other');
    });

    it('never reads an EACCES "permission denied" as a Google auth failure', () => {
        expect(backupFailureReason("EACCES: permission denied, open 'x'")).toBe('fs_access');
    });

    it('only ever returns a code from the closed set, never message text', () => {
        const samples = [
            "EACCES: permission denied, open 'C:\\Users\\Alice\\secret plan.enc'",
            'Path outside allowed root: /home/alice/Backups',
            'Drive upload failed: HTTP 400 {"error":{"message":"alice@example.com"}}',
            'Ezzzzzzz: weird, open',
            'E: x',
        ];
        for (const m of samples) {
            const r = backupFailureReason(m);
            expect(BACKUP_FAILURE_REASONS).toContain(r);
            expect(r).toMatch(/^[a-z0-9_]{1,32}$/);
        }
    });
});
