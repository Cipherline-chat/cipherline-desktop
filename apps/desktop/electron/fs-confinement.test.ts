import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { assertRendererPath, parsePickedDirs, isBackupFileName, PICKED_DIRS_STORE_KEY, type FsConfinementState, type RendererFsOp } from './fs-confinement';
import { isRendererSecureKey } from './secure-store-policy';

const U = '/home/u/.config/Cipherline';

function state(over: Partial<FsConfinementState> = {}): FsConfinementState {
    return {
        userData: U,
        pickedDirs: [],
        pickedFiles: new Set(),
        saveFiles: new Set(),
        platform: 'linux',
        resolveReal: (p) => p,
        pathApi: path.posix as typeof path,
        ...over,
    };
}

const ok = (s: FsConfinementState, op: RendererFsOp, p: string) => expect(() => assertRendererPath(s, op, p)).not.toThrow();
const refused = (s: FsConfinementState, op: RendererFsOp, p: string) =>
    expect(() => assertRendererPath(s, op, p)).toThrow(/outside allowed root|Invalid path/);

const ALL_OPS: RendererFsOp[] = ['read', 'write', 'list', 'unlink', 'backup-dir', 'backup-read', 'drive-upload'];

describe('fs-confinement — E-1 exploit paths are refused', () => {
    it('the renderer cannot write the picked-folder grant list (the E-1 chain, step 2)', () => {
        refused(state(), 'write', `${U}/picked-dirs.json`);
    });

    it('main-owned control files at the top of userData are unreachable on every op', () => {
        const control = ['store.key', 'store.key.tmp', 'secure-store.json', 'secure-store.json.corrupt-1', 'picked-dirs.json',
            'startup-flags.json', 'update-install-attempt.json', '.cl-installed-version', 'window-state.json', 'gpu-topology.json'];
        for (const f of control) for (const op of ALL_OPS) refused(state(), op, `${U}/${f}`);
        for (const op of ALL_OPS) refused(state(), op, U);
    });

    it('traversal out of an app subdirectory is refused', () => {
        refused(state(), 'read', `${U}/cipherline-gifs/../secure-store.json`);
        refused(state(), 'write', `${U}/backup-staging/../../Cipherline/store.key`);
        refused(state(), 'write', `${U}/cipherline-gifs-evil/x.enc`);
    });

    it('a symlink inside an app subdirectory that points at a control file is refused', () => {
        const s = state({ resolveReal: (p) => (p === `${U}/cipherline-gifs/link.enc` ? `${U}/store.key` : p) });
        refused(s, 'read', `${U}/cipherline-gifs/link.enc`);
    });

    it('a picked folder (even "/") does not grant arbitrary read / write / delete', () => {
        const s = state({ pickedDirs: ['/'] });
        refused(s, 'read', '/home/u/.ssh/id_ed25519');
        refused(s, 'write', '/home/u/.bashrc');
        refused(s, 'write', '/home/u/.config/autostart/x.desktop');
        refused(s, 'unlink', '/home/u/.ssh/id_ed25519');
        refused(s, 'backup-read', '/home/u/.ssh/id_ed25519');
        refused(s, 'drive-upload', '/home/u/backups/x.enc');
    });

    it('a picked folder that CONTAINS userData does not reach into it', () => {
        const s = state({ pickedDirs: ['/home/u'] });
        refused(s, 'list', U);
        refused(s, 'backup-dir', U);
        refused(s, 'backup-read', `${U}/x.enc`);
        refused(s, 'unlink', `${U}/x.enc`);
    });

    it('a save-dialog file is write-only and an open-dialog file is read-only', () => {
        const s = state({ saveFiles: new Set(['/home/u/Documents/key.txt']), pickedFiles: new Set(['/home/u/Downloads/a.gif']) });
        refused(s, 'read', '/home/u/Documents/key.txt');
        refused(s, 'unlink', '/home/u/Documents/key.txt');
        refused(s, 'write', '/home/u/Downloads/a.gif');
        refused(s, 'write', '/home/u/Documents/other.txt');
    });

    it('rejects non-strings and NUL bytes', () => {
        for (const bad of [undefined, null, 1, {}, '', `${U}/cipherline-gifs/a\0.enc`]) {
            expect(() => assertRendererPath(state(), 'read', bad as unknown as string)).toThrow(/Invalid path/);
        }
    });

    it('the persisted grant key is not renderer-nameable through secure:* channels', () => {
        expect(isRendererSecureKey(PICKED_DIRS_STORE_KEY)).toBe(false);
    });
});

describe('fs-confinement — legitimate flows still work (positive controls)', () => {
    it('GIF library: write (dir not created yet), read, delete, list', () => {
        const s = state();
        ok(s, 'write', `${U}/cipherline-gifs/0b1c.enc`);
        ok(s, 'read', `${U}/cipherline-gifs/0b1c.enc`);
        ok(s, 'unlink', `${U}/cipherline-gifs/0b1c.enc`);
        ok(s, 'list', `${U}/cipherline-gifs`);
    });

    it('Drive backup: staging dir write session, ranged read, upload, cleanup', () => {
        const s = state();
        ok(s, 'backup-dir', `${U}/backup-staging`);
        ok(s, 'backup-read', `${U}/backup-staging/cipherline-backup.enc`);
        ok(s, 'drive-upload', `${U}/backup-staging/cipherline-backup.enc`);
        ok(s, 'unlink', `${U}/backup-staging/cipherline-backup.enc`);
        refused(s, 'drive-upload', `${U}/backup-staging/notes.txt`);
    });

    it('local backup folder: write session, stat/read, list, retire legacy files', () => {
        const s = state({ pickedDirs: ['/mnt/usb/backups'] });
        ok(s, 'backup-dir', '/mnt/usb/backups');
        ok(s, 'backup-dir', '/mnt/usb/backups/sub');
        ok(s, 'backup-read', '/mnt/usb/backups/cipherline-backup.enc');
        ok(s, 'list', '/mnt/usb/backups');
        ok(s, 'unlink', '/mnt/usb/backups/cipherline-backup-2026-01-02.enc');
        ok(s, 'unlink', `/mnt/usb/backups/chunk-${'a'.repeat(64)}.enc`);
        refused(s, 'unlink', '/mnt/usb/backups/photo.jpg');
        refused(s, 'backup-dir', '/mnt/usb/other');
    });

    it('restore from a picked file and GIF import from a picked file', () => {
        const s = state({ pickedFiles: new Set(['/home/u/Downloads/old.enc', '/home/u/Downloads/cat.gif']) });
        ok(s, 'backup-read', '/home/u/Downloads/old.enc');
        ok(s, 'read', '/home/u/Downloads/cat.gif');
    });

    it('save dialog: the named file is writable (recovery-key .txt)', () => {
        ok(state({ saveFiles: new Set(['/home/u/Documents/key.txt']) }), 'write', '/home/u/Documents/key.txt');
    });

    it('Windows: case-insensitive, drive-letter paths', () => {
        const W = 'C:\\Users\\u\\AppData\\Roaming\\Cipherline';
        const s = state({
            userData: W, platform: 'win32', pathApi: path.win32 as typeof path,
            pickedDirs: ['D:\\'], pickedFiles: new Set(),
        });
        ok(s, 'write', 'c:\\users\\u\\appdata\\roaming\\cipherline\\cipherline-gifs/x.enc');
        ok(s, 'backup-dir', 'D:\\');
        ok(s, 'backup-read', 'd:\\cipherline-backup.enc');
        refused(s, 'write', `${W}\\picked-dirs.json`);
        refused(s, 'read', `${W}\\store.key`);
        refused(s, 'read', 'D:\\secrets.txt');
        refused(s, 'write', 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd');
    });
});

describe('fs-confinement — helpers', () => {
    it('isBackupFileName', () => {
        expect(isBackupFileName('a.enc')).toBe(true);
        expect(isBackupFileName('a.enc.partial')).toBe(false);
        expect(isBackupFileName('../a.enc')).toBe(false);
        expect(isBackupFileName('x/a.enc')).toBe(false);
    });
    it('parsePickedDirs tolerates garbage', () => {
        expect(parsePickedDirs(null)).toEqual([]);
        expect(parsePickedDirs('nope')).toEqual([]);
        expect(parsePickedDirs('{"a":1}')).toEqual([]);
        expect(parsePickedDirs('["/a", 3, "", "/b"]')).toEqual(['/a', '/b']);
    });
});

describe('main.ts wiring', () => {
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    const handlerBody = (channel: string) => {
        const i = main.indexOf(`ipcMain.handle('${channel}'`);
        expect(i, channel).toBeGreaterThan(-1);
        return main.slice(i, i + 1000);
    };
    it.each([
        ['fs:read-file', "'read'"], ['fs:write-file', "'write'"], ['fs:read-dir', "'list'"], ['fs:unlink', "'unlink'"],
        ['fs:write-backup-file', "'backup-dir'"], ['backup:begin-write', "'backup-dir'"], ['gdrive:upload-file', "'drive-upload'"],
    ])('%s goes through rendererPath(%s)', (channel, op) => {
        expect(handlerBody(channel)).toContain(`rendererPath(${op}`);
    });
    it('the old whole-userData check is gone and picked folders are not persisted to a plain file', () => {
        expect(main).not.toMatch(/function assertInsideUserData/);
        expect(main).not.toMatch(/writeFileSync\([^)]*[Pp]ickedDirs/);
    });
});
