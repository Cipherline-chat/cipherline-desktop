import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * No backup is written from a store that did not load (backupStoreGuard.ts).
 *
 * Real secureLocalStore over (fake) IndexedDB, driven into each state the way
 * the app reaches it; real runBackup. The vault export is mocked only to see
 * WHETHER the run got that far, and the desktop bridge is a set of spies so a
 * single write call — local folder or Google Drive — would show.
 */

const ctl = vi.hoisted(() => ({ openFailures: [] as unknown[] }));
vi.mock('../utils/attachmentCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/attachmentCache')>();
    return {
        ...actual,
        openDb: async () => {
            if (ctl.openFailures.length) throw ctl.openFailures.shift();
            return actual.openDb();
        },
    };
});

const { buildBackupPlanMock } = vi.hoisted(() => ({ buildBackupPlanMock: vi.fn() }));
vi.mock('./backupRecords', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./backupRecords')>();
    return { ...actual, buildBackupPlan: buildBackupPlanMock };
});
vi.mock('../utils/betaDiagnostics/reporter', () => ({ reportBeta: vi.fn() }));

const { secureLocalStore } = await import('../utils/secureLocalStore');
const { runBackup, BackupStoreUnreadableError, BACKUP_STORE_UNREADABLE_MESSAGE } = await import('./driveBackup');
const { backupStoreBlock } = await import('./backupStoreGuard');

const USER = '44444444-4444-4444-8444-444444444444';
const REACHED_EXPORT = new Error('reached the export');

let bridge: Record<string, ReturnType<typeof vi.fn>>;
function installBridge(masterKey: 'ok' | 'locked' | 'absent' = 'absent'): void {
    const writeCall = () => vi.fn(async () => { throw new Error('a backup write was attempted'); });
    bridge = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: masterKey })),
        // Local folder
        backupBeginWrite: writeCall(), backupAppend: writeCall(), backupWriteAt: writeCall(), backupCommit: writeCall(),
        backupStat: vi.fn(async () => null), backupReadRange: writeCall(), backupAbort: vi.fn(async () => {}),
        writeBackupFile: writeCall(),
        // Google Drive
        gdriveUploadFile: writeCall(), backupStagingDir: vi.fn(async () => '/staging'),
        gdriveStatFile: vi.fn(async () => null), gdriveFindFile: vi.fn(async () => null),
        gdriveAuthStatus: vi.fn(async () => ({ linked: true })), gdriveEnsureFolder: writeCall(),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = bridge;
}
const writes = () => Object.entries(bridge)
    .filter(([k]) => /BeginWrite|Append|WriteAt|Commit|writeBackupFile|UploadFile|EnsureFolder/.test(k))
    .reduce((n, [, f]) => n + f.mock.calls.length, 0);

async function wipeDb(): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve(); req.onerror = () => resolve(); req.onblocked = () => resolve();
    });
}

async function boot(masterKey: 'ok' | 'locked' | 'absent' = 'absent'): Promise<void> {
    secureLocalStore._resetForTest();
    installBridge(masterKey);
    await secureLocalStore.hydrate();
}

const backup = () => runBackup({
    userId: USER, token: 't', password: 'correct horse battery staple',
    destinations: { localDir: '/backups', drive: true, driveFolderId: 'folder-1', fileName: 'cipherline-backup' },
});

beforeEach(async () => {
    ctl.openFailures = [];
    buildBackupPlanMock.mockReset();
    buildBackupPlanMock.mockRejectedValue(REACHED_EXPORT);
    await wipeDb();
    // A signed-in account on disk.
    await boot();
    secureLocalStore.setItem('cipherline_user_id', USER);
    await secureLocalStore.whenAccountReady();
    secureLocalStore.setItem(`cipherline_convs_${USER}`, '[{"id":"conv-1"}]');
    await secureLocalStore.flushNow();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = undefined;
});

describe('runBackup refuses while this device’s data is not loaded', () => {
    it('control: a loaded, ready account gets as far as the export', async () => {
        await boot();
        expect(backupStoreBlock(USER)).toBeNull();
        await expect(backup()).rejects.toBe(REACHED_EXPORT);
        expect(buildBackupPlanMock).toHaveBeenCalledTimes(1);
    });

    it('the whole store unread (StorageReadFailedScreen → Continue anyway): refused before the export', async () => {
        ctl.openFailures = [new DOMException('v', 'VersionError')];
        await boot();
        expect(secureLocalStore.isStoreUnread()).toBe(true);
        // Signing in during that session binds the account but it never becomes ready.
        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.whenAccountReady();
        expect(backupStoreBlock(USER)).toBe('unread');
        const err = await backup().catch(e => e);
        expect(err).toBeInstanceOf(BackupStoreUnreadableError);
        expect(err.message).toBe(BACKUP_STORE_UNREADABLE_MESSAGE);
        expect(buildBackupPlanMock).not.toHaveBeenCalled();
        expect(writes()).toBe(0);
    });

    it('this account’s records failed to load (sign-in load failed): refused', async () => {
        // Signed out at boot; the sign-in's account load then fails.
        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.flushNow();
        await boot();
        ctl.openFailures = [new DOMException('v', 'VersionError')];
        secureLocalStore.setItem('cipherline_user_id', USER);
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.isStoreUnread()).toBe(false);
        expect(backupStoreBlock(USER)).toBe('unread');
        await expect(backup()).rejects.toBeInstanceOf(BackupStoreUnreadableError);
        expect(buildBackupPlanMock).not.toHaveBeenCalled();
        expect(writes()).toBe(0);
    });

    it('a locked keystore: refused', async () => {
        await boot('locked');
        expect(secureLocalStore.isLocked()).toBe(true);
        expect(backupStoreBlock(USER)).toBe('locked');
        await expect(backup()).rejects.toBeInstanceOf(BackupStoreUnreadableError);
        expect(buildBackupPlanMock).not.toHaveBeenCalled();
        expect(writes()).toBe(0);
    });

    it('the account still loading (sign-in in flight): refused', async () => {
        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.flushNow();
        await boot();
        secureLocalStore.setItem('cipherline_user_id', USER); // load starts, not awaited
        expect(backupStoreBlock(USER)).toBe('not-ready');
        await expect(backup()).rejects.toBeInstanceOf(BackupStoreUnreadableError);
        expect(buildBackupPlanMock).not.toHaveBeenCalled();
        await secureLocalStore.whenAccountReady();
    });

    it('another account than the one loaded: refused', async () => {
        await boot();
        expect(backupStoreBlock('55555555-5555-4555-8555-555555555555')).toBe('not-ready');
    });

    it('a load that fails DURING the export (message history, phase 2): refused before any write', async () => {
        await boot();
        buildBackupPlanMock.mockReset();
        buildBackupPlanMock.mockImplementation(async () => {
            // What hydrateMessages() does when its batch decrypt fails mid-export.
            (secureLocalStore as unknown as { noteLoadFailure: (a: string) => void }).noteLoadFailure(USER);
            return { userId: USER, fingerprint: 'f', records: [], attachmentIds: [], attachmentSizeHints: {} };
        });
        await expect(backup()).rejects.toBeInstanceOf(BackupStoreUnreadableError);
        expect(buildBackupPlanMock).toHaveBeenCalledTimes(1);
        expect(writes()).toBe(0);
        expect(bridge.backupStat).not.toHaveBeenCalled();
    });
});

describe('every backup entry point is covered', () => {
    const read = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8');

    it('runBackup checks first thing, and again after the export', () => {
        const src = read('./driveBackup.ts');
        const body = src.slice(src.indexOf('export async function runBackup('));
        const first = body.indexOf('assertBackupStoreReadable(userId)');
        expect(first).toBeGreaterThan(-1);
        expect(first).toBeLessThan(body.indexOf('notifyBackupStateChanged(); // run started'));
        const afterPlan = body.indexOf('assertBackupStoreReadable(userId)', body.indexOf('await buildBackupPlan('));
        expect(afterPlan).toBeGreaterThan(-1);
        expect(afterPlan).toBeLessThan(body.indexOf('runSingleFileBackup('));
    });

    it('the only callers of runBackup are the button and the scheduler (both go through the guard above)', () => {
        const callers: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name) && /\brunBackup\(/.test(fs.readFileSync(p, 'utf8'))) {
                    callers.push(path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/'));
                }
            }
        };
        walk(path.join(__dirname, '..'));
        expect(callers.sort()).toEqual(['components/BackupSection.tsx', 'hooks/useBackupAutoSchedule.ts', 'services/driveBackup.ts']);
    });

    it('the scheduler bails before reading its config or the passphrase', () => {
        const src = read('../hooks/useBackupAutoSchedule.ts');
        const tick = src.slice(src.indexOf('const tick = async'));
        const guard = tick.indexOf('if (backupStoreBlock(userId)) return;');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(tick.indexOf('readBackupCfg(userId)'));
        expect(guard).toBeLessThan(tick.indexOf('getCachedPassword()'));
    });

    it('"Back up now" refuses with the message before it caches the passphrase', () => {
        const src = read('../components/BackupSection.tsx');
        const fn = src.slice(src.indexOf('const onBackupNow = useCallback'));
        const guard = fn.indexOf('const block = backupStoreBlock(userId);');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(fn.indexOf('setCachedPassword('));
        expect(fn.slice(guard, guard + 300)).toContain('if (block)');
        expect(fn.slice(guard, guard + 300)).toContain('backupStoreBlockMessage(block)');
    });

    it('there is no backup-on-quit path that could bypass runBackup', () => {
        const main = fs.readFileSync(path.join(__dirname, '../../electron/main.ts'), 'utf8');
        // Main writes backup files only through the renderer-driven session IPC
        // (backup:begin-write …), which only runBackup's destinations open.
        expect(main).not.toMatch(/before-quit[\s\S]{0,400}backup(BeginWrite|:begin-write)/);
    });
});
