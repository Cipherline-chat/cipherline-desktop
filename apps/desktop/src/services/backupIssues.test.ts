import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});

const {
    issueFromFailure, readBackupIssues, setBackupIssue, recordRunIssues, checkLocalFolderGrant, BACKUP_ISSUES_KEY, BACKUP_ISSUE_COPY,
} = await import('./backupIssues');

const U = 'u1';
const ipc = (inner: string) => `Error invoking remote method 'backup:begin-write': Error: ${inner}`;
const setBridge = (b: unknown) => { (window as unknown as { electronAPI?: unknown }).electronAPI = b; };

beforeEach(() => { store.clear(); setBridge(undefined); });

describe('issueFromFailure', () => {
    it('maps the failures from the beta reports to the actions that fix them', () => {
        expect(issueFromFailure('local', ipc('Path outside allowed root: D:\\Backups'))).toBe('folder-denied');
        expect(issueFromFailure('local', ipc('Backup directory does not exist: D:\\gone'))).toBe('folder-missing');
        expect(issueFromFailure('drive', 'Google Drive token revoked \u2014 please re-link: x')).toBe('reconnect');
        expect(issueFromFailure('drive', 'Google Drive is not connected.')).toBe('reconnect');
        expect(issueFromFailure('drive', 'Drive query failed: 401')).toBe('reconnect');
    });
    it('ignores transient failures and never crosses destinations', () => {
        expect(issueFromFailure('drive', 'Failed to fetch')).toBeNull();
        expect(issueFromFailure('drive', ipc('Path outside allowed root: D:\\x'))).toBeNull();
        expect(issueFromFailure('local', 'Google Drive token revoked \u2014 please re-link')).toBeNull();
        expect(issueFromFailure('local', ipc("EBUSY: resource busy or locked, rename 'x' -> 'y'"))).toBeNull();
    });
});

describe('recordRunIssues', () => {
    it('sets on a user-fixable failure, keeps it through a transient one, clears on success', () => {
        expect(recordRunIssues(U, { errors: { drive: 'Google Drive token revoked \u2014 please re-link' } })).toBe(true);
        expect(readBackupIssues(U)).toEqual({ drive: 'reconnect' });
        // a network blip next run must not hide the real problem
        expect(recordRunIssues(U, { errors: { drive: 'Failed to fetch' } })).toBe(false);
        expect(readBackupIssues(U)).toEqual({ drive: 'reconnect' });
        // another destination succeeding leaves it alone
        expect(recordRunIssues(U, { succeeded: { local: true } })).toBe(false);
        expect(readBackupIssues(U)).toEqual({ drive: 'reconnect' });
        expect(recordRunIssues(U, { succeeded: { drive: true } })).toBe(true);
        expect(readBackupIssues(U)).toEqual({});
        expect(store.has(BACKUP_ISSUES_KEY(U))).toBe(false);
    });
    it('tracks both destinations independently', () => {
        recordRunIssues(U, { errors: { local: ipc('Path outside allowed root: x'), drive: 'Drive query failed: 401' } });
        expect(readBackupIssues(U)).toEqual({ local: 'folder-denied', drive: 'reconnect' });
        recordRunIssues(U, { succeeded: { local: true } });
        expect(readBackupIssues(U)).toEqual({ drive: 'reconnect' });
    });
    it('is per account and tolerates garbage in storage', () => {
        setBackupIssue('a', 'drive', 'reconnect');
        expect(readBackupIssues('b')).toEqual({});
        store.set(BACKUP_ISSUES_KEY(U), '{"drive":"<script>","local":42}');
        expect(readBackupIssues(U)).toEqual({});
        store.set(BACKUP_ISSUES_KEY(U), 'not json');
        expect(readBackupIssues(U)).toEqual({});
    });
});

describe('checkLocalFolderGrant', () => {
    it('flags a folder main refuses to register (a path that came back inside a restored backup)', async () => {
        setBridge({ registerDir: async () => ({ ok: false }) });
        expect(await checkLocalFolderGrant(U, 'D:\\Backups')).toEqual({ grant: 'denied', changed: true });
        expect(readBackupIssues(U).local).toBe('folder-denied');
        // asking again changes nothing, so callers don't re-notify / re-report
        expect(await checkLocalFolderGrant(U, 'D:\\Backups')).toEqual({ grant: 'denied', changed: false });
    });
    it('clears a stale denial once the folder is registered, but not a missing-folder issue', async () => {
        setBackupIssue(U, 'local', 'folder-denied');
        setBridge({ registerDir: async () => ({ ok: true }) });
        expect(await checkLocalFolderGrant(U, 'D:\\Backups')).toEqual({ grant: 'granted', changed: true });
        expect(readBackupIssues(U)).toEqual({});
        setBackupIssue(U, 'local', 'folder-missing');
        expect(await checkLocalFolderGrant(U, 'D:\\Backups')).toEqual({ grant: 'granted', changed: false });
        expect(readBackupIssues(U).local).toBe('folder-missing');
    });
    it('concludes nothing when the bridge is absent or throws', async () => {
        expect(await checkLocalFolderGrant(U, 'D:\\x')).toEqual({ grant: 'unknown', changed: false });
        setBridge({ registerDir: async () => { throw new Error('boom'); } });
        expect(await checkLocalFolderGrant(U, 'D:\\x')).toEqual({ grant: 'unknown', changed: false });
        expect(readBackupIssues(U)).toEqual({});
    });
});

describe('copy', () => {
    it('every kind has an action label', () => {
        for (const k of ['reconnect', 'folder-denied', 'folder-missing'] as const) expect(BACKUP_ISSUE_COPY[k].action.length).toBeGreaterThan(3);
    });
});
