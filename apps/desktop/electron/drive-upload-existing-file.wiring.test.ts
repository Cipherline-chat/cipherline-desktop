import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A user who picked their own Drive folder under the old (metadata-scope)
// folder browser keeps their backup FILE — the app created it, so `drive.file`
// still covers it — but the folder is no longer visible. The renderer then
// updates that file by id (driveBackup.ts → resolveDriveBackupTarget), which
// needs the id to survive the whole bridge: preload → IPC handler → uploader.
// Source-reading wiring tests, like the other *.wiring.test.ts files here.

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('gdrive:upload-file carries an optional existing file id end to end', () => {
    it('preload forwards a fourth argument', () => {
        const preload = src('preload.ts');
        expect(preload).toMatch(/gdriveUploadFile:\s*\(folderId: string, fileName: string, filePath: string, existingFileId\?: string\)/);
        expect(preload).toContain("ipcRenderer.invoke('gdrive:upload-file', folderId, fileName, filePath, existingFileId)");
    });

    it('the IPC handler validates the id and hands it to the uploader', () => {
        const main = src('main.ts');
        const handler = main.slice(main.indexOf("ipcMain.handle('gdrive:upload-file'"), main.indexOf("ipcMain.handle('gdrive:download-file'"));
        expect(handler).toContain('existingFileId?: string');
        expect(handler).toMatch(/existingFileId !== undefined && \(typeof existingFileId !== 'string' \|\| !\/\^\[A-Za-z0-9_-\]\+\$\/\.test\(existingFileId\)\)/);
        expect(handler).toContain('filePath, existingFileId');
    });

    it('the uploader PATCHes that file id instead of searching the folder for it', () => {
        const transfer = src('driveTransfer.ts');
        expect(transfer).toContain('existingFileId?: string');
        expect(transfer).toContain('existingFileId ? { id: existingFileId } : await findDriveFile(');
    });
});

describe('the OAuth request stays narrow', () => {
    it('googleDriveAuth.ts requests exactly email + drive.file', () => {
        const auth = src('googleDriveAuth.ts');
        expect(auth).toContain("const SCOPE = 'email https://www.googleapis.com/auth/drive.file';");
    });
});
