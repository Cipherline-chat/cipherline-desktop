import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    createDriveApi, selectLatestManifest, isValidDriveId, isValidBackupFileName,
    APP_BACKUP_FOLDER, FOLDER_MIME, DriveStatusError,
} from './drive-api';
import { createFakeDrive, type FakeNode } from './test-drive-fake';

// Cipherline holds only `drive.file`: it can see and modify the files and
// folders IT created. These tests pin what the renderer is allowed to ask the
// main process to do with that token: nothing but backup-shaped operations in
// the app's own folder, and never the token itself.

const TOKEN = 'ya29.secret-access-token';
const APP_FOLDER: FakeNode = { id: 'app-folder-id', name: APP_BACKUP_FOLDER, mimeType: FOLDER_MIME, createdTime: '2026-01-01T00:00:00Z' };
const backupFile = (over: Partial<FakeNode> = {}): FakeNode => ({
    id: 'file-1', name: 'cipherline-backup.enc', mimeType: 'application/octet-stream', parents: ['app-folder-id'],
    size: '42', modifiedTime: '2026-02-02T00:00:00Z', createdTime: '2026-02-01T00:00:00Z', ...over,
});

function setup(seed: FakeNode[] = [], opts: { trusted?: string | null } = {}) {
    const fake = createFakeDrive(seed);
    let trusted: string | null = opts.trusted ?? null;
    const api = createDriveApi({
        http: fake.http,
        getToken: async () => TOKEN,
        getTrustedFolderId: () => trusted,
        setTrustedFolderId: (id) => { trusted = id; },
    });
    return { fake, api, trusted: () => trusted };
}

describe('input validation (what a hostile renderer can send)', () => {
    it('drive ids: URL-safe tokens only', () => {
        for (const ok of ['abc', 'A-b_9', 'x'.repeat(128)]) expect(isValidDriveId(ok)).toBe(true);
        for (const bad of ['', '../etc', 'a/b', 'a b', "a'b", 'a?fields=x', 'x'.repeat(129), 5, null, undefined, {}, ['a']]) {
            expect(isValidDriveId(bad), String(bad)).toBe(false);
        }
    });
    it('backup names: a plain *.enc, no separators, no traversal, no control chars', () => {
        expect(isValidBackupFileName('cipherline-backup.enc')).toBe(true);
        expect(isValidBackupFileName('cipherline-backup-2026-01-02.enc')).toBe(true);
        expect(isValidBackupFileName("it's mine.enc")).toBe(true);
        for (const bad of ['', 'a.txt', 'a.enc/', '../a.enc', 'a/../b.enc', 'a\\b.enc', 'a\nb.enc', '.enc'.repeat(80) + 'x', 7, null]) {
            expect(isValidBackupFileName(bad), String(bad)).toBe(false);
        }
    });
});

describe('resolveFolder', () => {
    it('a stored id that is the app folder is used as-is, with no search', async () => {
        const { api, fake } = setup([APP_FOLDER]);
        expect(await api.resolveFolder('app-folder-id', true)).toEqual({ folderId: 'app-folder-id', recovered: false });
        expect(fake.callsMatching(/mimeType=/)).toHaveLength(0);
        expect(fake.callsMatching(/^POST/)).toHaveLength(0);
    });

    it('nothing stored and nothing found: creates "Cipherline Backups" (without parents) and remembers it', async () => {
        const { api, fake, trusted } = setup();
        const res = await api.resolveFolder(null, true);
        expect(res).toEqual({ folderId: 'created-folder-1', recovered: false });
        const post = fake.callsMatching(/^POST/)[0];
        expect(post.body).toEqual({ name: APP_BACKUP_FOLDER, mimeType: FOLDER_MIME });
        expect(trusted()).toBe('created-folder-1');
    });

    it('create:false never creates, and reports no folder when none exists', async () => {
        const { api, fake } = setup();
        expect(await api.resolveFolder(null, false)).toEqual({ folderId: null, recovered: false });
        expect(fake.callsMatching(/^POST/)).toHaveLength(0);
    });

    it('with nothing stored, finds the folder another device made — the OLDEST when two exist', async () => {
        const { api, fake } = setup([
            { ...APP_FOLDER, id: 'newer', createdTime: '2026-05-05T00:00:00Z' },
            { ...APP_FOLDER, id: 'older', createdTime: '2026-01-01T00:00:00Z' },
        ]);
        expect(await api.resolveFolder(undefined, true)).toEqual({ folderId: 'older', recovered: false });
        expect(fake.callsMatching(/^POST/)).toHaveLength(0);
        const search = fake.callsMatching(/mimeType=/)[0].url;
        expect(search).toContain(`name='${APP_BACKUP_FOLDER}'`);
        expect(search).toContain('orderBy=createdTime');
    });

    it.each([403, 404])('a stored id that %i falls back to the app folder and says it recovered', async (status) => {
        const { api, fake } = setup([APP_FOLDER]);
        fake.force('stale-folder', status);
        expect(await api.resolveFolder('stale-folder', true)).toEqual({ folderId: 'app-folder-id', recovered: true });
    });

    it('a stale stored id with no app folder creates one (create:true) or reports none (create:false)', async () => {
        const a = setup();
        expect(await a.api.resolveFolder('gone', true)).toEqual({ folderId: 'created-folder-1', recovered: true });
        const b = setup();
        expect(await b.api.resolveFolder('gone', false)).toEqual({ folderId: null, recovered: true });
        expect(b.fake.callsMatching(/^POST/)).toHaveLength(0);
    });

    it.each([401, 500])('a %i is a real failure — NOT treated as a stale folder', async (status) => {
        const { api, fake } = setup([APP_FOLDER]);
        fake.force('app-folder-id', status);
        await expect(api.resolveFolder('app-folder-id', true)).rejects.toThrow(String(status));
        await expect(api.resolveFolder('app-folder-id', true)).rejects.toBeInstanceOf(DriveStatusError);
    });

    it('a network error propagates unchanged', async () => {
        const { api, fake } = setup([APP_FOLDER]);
        fake.failEverythingWith(new Error('network down'));
        await expect(api.resolveFolder('app-folder-id', true)).rejects.toThrow('network down');
    });

    it('a trashed folder is stale', async () => {
        const { api } = setup([APP_FOLDER, { ...APP_FOLDER, id: 'binned', trashed: true }]);
        expect(await api.resolveFolder('binned', true)).toEqual({ folderId: 'app-folder-id', recovered: true });
    });

    // ── foreign folders ───────────────────────────────────────────────────
    it('a stored id that is a FILE (not a folder) is refused as stale, never used as a folder', async () => {
        const { api } = setup([APP_FOLDER, backupFile({ id: 'a-file' })]);
        expect(await api.resolveFolder('a-file', true)).toEqual({ folderId: 'app-folder-id', recovered: true });
    });

    it('a folder that is not the app folder (other name, never recorded) is refused as stale', async () => {
        const { api } = setup([APP_FOLDER, { id: 'photos', name: 'Holiday photos', mimeType: FOLDER_MIME }]);
        expect(await api.resolveFolder('photos', true)).toEqual({ folderId: 'app-folder-id', recovered: true });
    });

    it('a folder the user RENAMED in Drive is still accepted once the app has recorded it', async () => {
        const { api, fake } = setup([{ id: 'renamed', name: 'My backups', mimeType: FOLDER_MIME }], { trusted: 'renamed' });
        expect(await api.resolveFolder('renamed', true)).toEqual({ folderId: 'renamed', recovered: false });
        expect(fake.callsMatching(/mimeType=/)).toHaveLength(0);
    });

    it('a malformed stored id never reaches Drive: it is treated as stale', async () => {
        const { api, fake } = setup([APP_FOLDER]);
        expect(await api.resolveFolder('../../drive/v3/about', true)).toEqual({ folderId: 'app-folder-id', recovered: true });
        expect(fake.calls.every(c => !c.url.includes('about'))).toBe(true);
    });

    it('every request carries the bearer token and stays on the Drive v3 files endpoint', async () => {
        const { api, fake } = setup();
        await api.resolveFolder(null, true);
        expect(fake.calls.length).toBeGreaterThan(0);
        for (const c of fake.calls) {
            expect(c.auth).toBe(`Bearer ${TOKEN}`);
            expect(c.url.startsWith('https://www.googleapis.com/drive/v3/files')).toBe(true);
        }
    });
});

describe('resolveBackupTarget', () => {
    const LEGACY = backupFile({ id: 'legacy-file', parents: ['users-own-folder'] });

    it('a usable stored folder is the target', async () => {
        const { api } = setup([APP_FOLDER]);
        expect(await api.resolveBackupTarget('app-folder-id', 'cipherline-backup.enc')).toEqual({ kind: 'folder', folderId: 'app-folder-id', recovered: false });
    });

    it('a folder the app cannot see but whose backup FILE it can still edit: that file is updated in place', async () => {
        const { api, fake } = setup([LEGACY]);
        fake.force('users-own-folder', 404);
        const t = await api.resolveBackupTarget('users-own-folder', 'cipherline-backup.enc');
        expect(t.kind).toBe('file');
        if (t.kind === 'file') {
            expect(t.folderId).toBe('users-own-folder');
            expect(t.file.id).toBe('legacy-file');
        }
        expect(fake.callsMatching(/^POST/)).toHaveLength(0);
    });

    it('a file the app may not edit is not pinned: the backup moves to the app folder (recovered)', async () => {
        const { api, fake } = setup([APP_FOLDER, { ...LEGACY, canEdit: false }]);
        fake.force('users-own-folder', 403);
        expect(await api.resolveBackupTarget('users-own-folder', 'cipherline-backup.enc'))
            .toEqual({ kind: 'folder', folderId: 'app-folder-id', recovered: true });
    });

    it('no stored id and no app folder: creates it, and it is not a "recovery"', async () => {
        const { api } = setup();
        expect(await api.resolveBackupTarget(null, 'cipherline-backup.enc'))
            .toEqual({ kind: 'folder', folderId: 'created-folder-1', recovered: false });
    });

    it('refuses a file name that is not a backup name', async () => {
        const { api } = setup([APP_FOLDER]);
        await expect(api.resolveBackupTarget('app-folder-id', '../passwd')).rejects.toThrow(/filename/i);
        await expect(api.resolveBackupTarget('app-folder-id', 'notes.txt')).rejects.toThrow(/filename/i);
    });
});

describe('locateBackup', () => {
    it('finds <base>.enc in the app folder', async () => {
        const { api } = setup([APP_FOLDER, backupFile()]);
        const r = await api.locateBackup('app-folder-id', 'cipherline-backup');
        expect(r.inFolder).toBe(true);
        expect(r.file?.id).toBe('file-1');
        expect(r.recovered).toBe(false);
    });

    it('falls back to the newest legacy dated manifest in the folder (never a chunk file)', async () => {
        const { api } = setup([
            APP_FOLDER,
            backupFile({ id: 'old', name: 'cipherline-backup-2026-01-01.enc', modifiedTime: '2026-01-01T00:00:00Z' }),
            backupFile({ id: 'new', name: 'cipherline-backup-2026-01-02.enc', modifiedTime: '2026-01-02T00:00:00Z' }),
            backupFile({ id: 'chunk', name: 'chunk-' + 'a'.repeat(64) + '.enc', modifiedTime: '2026-09-09T00:00:00Z' }),
        ]);
        expect((await api.locateBackup('app-folder-id', 'cipherline-backup')).file?.id).toBe('new');
    });

    it('stale stored folder + the backup sits in a folder the app cannot see: found anywhere, not marked inFolder', async () => {
        const { api, fake } = setup([backupFile({ id: 'legacy', parents: ['users-own-folder'] })]);
        fake.force('users-own-folder', 404);
        const r = await api.locateBackup('users-own-folder', 'cipherline-backup');
        expect(r).toMatchObject({ folderId: null, recovered: true, inFolder: false });
        expect(r.file?.id).toBe('legacy');
        expect(r.file?.parents).toEqual(['users-own-folder']);
    });

    it('nothing anywhere: file null, never an error, never creates a folder', async () => {
        const { api, fake } = setup();
        expect(await api.locateBackup(null, 'cipherline-backup')).toEqual({ file: null, folderId: null, recovered: false, inFolder: false });
        expect(fake.callsMatching(/^POST/)).toHaveLength(0);
    });

    it('a 401 propagates (not "no backup")', async () => {
        const { api, fake } = setup([APP_FOLDER]);
        fake.force('app-folder-id', 401);
        await expect(api.locateBackup('app-folder-id', null)).rejects.toThrow('401');
    });

    it("quotes in the file base cannot break out of the query", async () => {
        const { api, fake } = setup([APP_FOLDER]);
        await api.locateBackup('app-folder-id', "x' or trashed=true or name='");
        const q = fake.callsMatching(/name=/)[0].url;
        expect(q).toContain("name='x\\' or trashed=true or name=\\'.enc'");
    });

    it('rejects a hostile file base outright', async () => {
        const { api } = setup([APP_FOLDER]);
        await expect(api.locateBackup('app-folder-id', '../../x')).rejects.toThrow(/filename/i);
        await expect(api.locateBackup('app-folder-id', 'a/b')).rejects.toThrow(/filename/i);
    });

    it('only backup-shaped files ever come back, even if Drive returns others', async () => {
        const { api } = setup([
            APP_FOLDER,
            backupFile({ id: 'ok', name: 'cipherline-backup.enc' }),
            { id: 'doc', name: 'secrets.docx', mimeType: 'application/msword', parents: ['app-folder-id'] },
        ]);
        const names = (await api.listFolder('app-folder-id')).map(f => f.name);
        expect(names).toEqual(['cipherline-backup.enc']);
    });
});

describe('statFile', () => {
    it('returns size and modifiedTime for a backup file', async () => {
        const { api } = setup([backupFile()]);
        expect(await api.statFile('file-1')).toEqual({ size: 42, modifiedTime: '2026-02-02T00:00:00Z' });
    });
    it.each([403, 404])('%i reads as absent', async (s) => {
        const { api, fake } = setup([backupFile()]);
        fake.force('file-1', s);
        expect(await api.statFile('file-1')).toBeNull();
    });
    it('a trashed file reads as absent', async () => {
        const { api } = setup([backupFile({ trashed: true })]);
        expect(await api.statFile('file-1')).toBeNull();
    });
    it('refuses a folder, a non-backup file and a malformed id', async () => {
        const { api, fake } = setup([APP_FOLDER, { id: 'doc', name: 'taxes.pdf', mimeType: 'application/pdf' }]);
        await expect(api.statFile('app-folder-id')).rejects.toThrow(/not a backup file/);
        await expect(api.statFile('doc')).rejects.toThrow(/not a backup file/);
        const before = fake.calls.length;
        await expect(api.statFile('../x')).rejects.toThrow(/Invalid Drive file id/);
        await expect(api.statFile(undefined)).rejects.toThrow(/Invalid Drive file id/);
        expect(fake.calls.length).toBe(before); // never reached Drive
    });
    it('a 401 is a failure, not "absent"', async () => {
        const { api, fake } = setup([backupFile()]);
        fake.force('file-1', 401);
        await expect(api.statFile('file-1')).rejects.toThrow('401');
    });
});

describe('findFile / listFolder / deleteFolderFiles are confined to the app folder', () => {
    const FOREIGN: FakeNode = { id: 'foreign', name: 'Taxes 2025', mimeType: FOLDER_MIME };
    const seed = () => [
        APP_FOLDER, FOREIGN,
        backupFile({ id: 'keep', name: 'cipherline-backup.enc' }),
        backupFile({ id: 'chunk1', name: 'chunk-' + 'b'.repeat(64) + '.enc' }),
        backupFile({ id: 'foreign-file', name: 'important.enc', parents: ['foreign'] }),
    ];

    it('findFile finds a named backup in the app folder', async () => {
        const { api } = setup(seed());
        expect((await api.findFile('app-folder-id', 'cipherline-backup.enc'))?.id).toBe('keep');
        expect(await api.findFile('app-folder-id', 'nope.enc')).toBeNull();
    });

    it('refuses a foreign folder for find / list / delete — and sends no list or delete request for it', async () => {
        const { api, fake } = setup(seed());
        await expect(api.findFile('foreign', 'important.enc')).rejects.toThrow(/not the Cipherline backup folder/);
        await expect(api.listFolder('foreign')).rejects.toThrow(/not the Cipherline backup folder/);
        await expect(api.deleteFolderFiles('foreign', ['important.enc'])).rejects.toThrow(/not the Cipherline backup folder/);
        expect(fake.callsMatching(/^DELETE/)).toHaveLength(0);
        expect(fake.callsMatching(/in parents/)).toHaveLength(0);
        expect(fake.nodes.has('foreign-file')).toBe(true);
    });

    it('refuses a file id where a folder id belongs, and malformed ids', async () => {
        const { api } = setup(seed());
        await expect(api.listFolder('keep')).rejects.toThrow(/not the Cipherline backup folder/);
        await expect(api.listFolder('a/b')).rejects.toThrow(/Invalid Drive folder id/);
        await expect(api.listFolder(undefined)).rejects.toThrow(/Invalid Drive folder id/);
    });

    it('deletes only the named files that live in the app folder', async () => {
        const { api, fake } = setup(seed());
        const r = await api.deleteFolderFiles('app-folder-id', ['chunk-' + 'b'.repeat(64) + '.enc', 'important.enc']);
        expect(r).toEqual({ deleted: 1, failed: 0 });
        expect(fake.nodes.has('chunk1')).toBe(false);
        expect(fake.nodes.has('keep')).toBe(true);
        expect(fake.nodes.has('foreign-file')).toBe(true); // same name list, different folder: untouched
    });

    it('refuses a name list containing anything that is not a backup file name', async () => {
        const { api, fake } = setup(seed());
        for (const names of [['../x.enc'], ['notes.txt'], 'cipherline-backup.enc', [5], Array(1001).fill('a.enc')]) {
            await expect(api.deleteFolderFiles('app-folder-id', names)).rejects.toThrow(/Invalid backup filename list/);
        }
        expect(fake.callsMatching(/^DELETE/)).toHaveLength(0);
    });

    it('counts a failed delete instead of throwing', async () => {
        const { api, fake } = setup(seed());
        fake.force('chunk1', 500);
        expect(await api.deleteFolderFiles('app-folder-id', ['chunk-' + 'b'.repeat(64) + '.enc'])).toEqual({ deleted: 0, failed: 1 });
    });
});

describe('checkDownload / checkUpload (the gate in front of the byte-moving IPC)', () => {
    it('download: a real backup with the matching name passes, returning its size', async () => {
        const { api } = setup([backupFile()]);
        expect(await api.checkDownload('file-1', 'cipherline-backup.enc')).toEqual({ size: 42 });
    });
    it('download: refuses a foreign / mismatched / folder / malformed target', async () => {
        const { api } = setup([APP_FOLDER, backupFile(), { id: 'doc', name: 'photo.jpg', mimeType: 'image/jpeg' }]);
        await expect(api.checkDownload('file-1', 'other.enc')).rejects.toThrow(/does not match/);
        await expect(api.checkDownload('doc', 'photo.jpg')).rejects.toThrow(/Invalid backup filename/);
        await expect(api.checkDownload('doc', 'cipherline-backup.enc')).rejects.toThrow(/not a backup file/);
        await expect(api.checkDownload('app-folder-id', 'cipherline-backup.enc')).rejects.toThrow(/not a backup file/);
        await expect(api.checkDownload('../x', 'cipherline-backup.enc')).rejects.toThrow(/Invalid Drive file id/);
    });
    it('download: a missing file surfaces as HTTP 404 (the renderer treats that as "no backup")', async () => {
        const { api } = setup([]);
        await expect(api.checkDownload('nope', 'cipherline-backup.enc')).rejects.toThrow(/HTTP 404/);
    });
    it('upload: new file needs the app folder', async () => {
        const { api } = setup([APP_FOLDER, { id: 'foreign', name: 'Taxes', mimeType: FOLDER_MIME }]);
        await expect(api.checkUpload('app-folder-id', 'cipherline-backup.enc', undefined)).resolves.toBeUndefined();
        await expect(api.checkUpload('foreign', 'cipherline-backup.enc', undefined)).rejects.toThrow(/not the Cipherline backup folder/);
        await expect(api.checkUpload('app-folder-id', 'evil.sh', undefined)).rejects.toThrow(/Invalid backup filename/);
    });
    it('upload: updating in place needs an existing backup file (its folder is not consulted)', async () => {
        const { api, fake } = setup([backupFile({ id: 'legacy', parents: ['invisible-folder'] }), { id: 'doc', name: 'cv.pdf', mimeType: 'application/pdf' }]);
        await expect(api.checkUpload('invisible-folder', 'cipherline-backup.enc', 'legacy')).resolves.toBeUndefined();
        await expect(api.checkUpload('invisible-folder', 'cipherline-backup.enc', 'doc')).rejects.toThrow(/not a backup file/);
        fake.force('legacy', 403);
        await expect(api.checkUpload('invisible-folder', 'cipherline-backup.enc', 'legacy')).rejects.toThrow(/HTTP 404/);
    });
});

describe('selectLatestManifest', () => {
    it('picks the newest manifest, ignoring chunk files and other bases', () => {
        const picked = selectLatestManifest([
            { id: 'a', name: 'cipherline-backup-2026-01-01.enc', modifiedTime: '2026-01-01T00:00:00Z' },
            { id: 'b', name: 'cipherline-backup-2026-01-02.enc', modifiedTime: '2026-01-02T00:00:00Z' },
            { id: 'c', name: 'chunk-abc.enc', modifiedTime: '2026-09-01T00:00:00Z' },
            { id: 'd', name: 'other-2026-09-09.enc', modifiedTime: '2026-09-09T00:00:00Z' },
        ], 'cipherline-backup');
        expect(picked?.id).toBe('b');
        expect(selectLatestManifest([], 'cipherline-backup')).toBeNull();
    });
});

describe('wiring: the renderer never gets the token or a Drive endpoint', () => {
    const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    it('no IPC channel or preload member returns an access token', () => {
        const main = strip(src('main.ts'));
        const preload = strip(src('preload.ts'));
        const env = strip(readFileSync(join(__dirname, '..', 'src', 'env.d.ts'), 'utf8'));
        expect(main).not.toContain('gdrive:get-token');
        expect(preload).not.toContain('gdrive:get-token');
        expect(preload).not.toContain('gdriveGetToken');
        expect(env).not.toContain('gdriveGetToken');
        // getAccessToken is only ever handed to the main-process helpers.
        for (const m of main.matchAll(/getAccessToken/g)) {
            const around = main.slice(Math.max(0, m.index! - 60), m.index! + 40);
            expect(around).toMatch(/import|getToken: getAccessToken/);
        }
    });

    it('the renderer sources hold no googleapis URL and do not fetch Drive', () => {
        for (const rel of ['../src/services/driveBackup.ts', '../src/utils/driveFolders.ts']) {
            const s = strip(src(rel));
            expect(s, rel).not.toMatch(/googleapis\.com/);
            expect(s, rel).not.toMatch(/\bfetch\(/);
            expect(s, rel).not.toMatch(/Authorization/);
        }
    });

    it('every gdrive channel is registered through ipcMain.handle (so the central sender guard applies)', () => {
        const main = src('main.ts');
        const channels = [...main.matchAll(/ipcMain\.handle\('(gdrive:[a-z-]+)'/g)].map(m => m[1]).sort();
        expect(channels).toEqual([
            'gdrive:auth-start', 'gdrive:auth-status', 'gdrive:delete-folder-files', 'gdrive:disconnect', 'gdrive:download-file',
            'gdrive:ensure-folder', 'gdrive:find-file', 'gdrive:list-folder', 'gdrive:locate-backup',
            'gdrive:resolve-backup-target', 'gdrive:resolve-folder', 'gdrive:stat-file', 'gdrive:upload-file',
        ]);
    });

    it('the upload and download handlers gate on drive-api before moving any bytes', () => {
        const main = src('main.ts');
        const up = main.slice(main.indexOf("ipcMain.handle('gdrive:upload-file'"), main.indexOf("ipcMain.handle('gdrive:download-file'"));
        expect(up.indexOf('driveApi.checkUpload')).toBeGreaterThan(-1);
        expect(up.indexOf('driveApi.checkUpload')).toBeLessThan(up.indexOf('uploadFileResumable('));
        const down = main.slice(main.indexOf("ipcMain.handle('gdrive:download-file'"));
        expect(down.indexOf('driveApi.checkDownload')).toBeGreaterThan(-1);
        expect(down.indexOf('driveApi.checkDownload')).toBeLessThan(down.indexOf('downloadFileToPath('));
    });
});
