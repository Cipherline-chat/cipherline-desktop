import { describe, it, expect } from 'vitest';
import { ensureMainDesktopEntry, buildMainDesktopEntry, writeManagedDesktopFile, ensureUserIcon, type IdentityFs } from './linux-identity';
import { ensureDesktopEntry } from './wayland-global-shortcuts';

function fakeFs(files: Record<string, string> = {}): IdentityFs & { files: Record<string, string> } {
    const f = { ...files };
    return {
        files: f,
        existsSync: (p) => p in f,
        readFileSync: (p) => { if (!(p in f)) throw new Error('ENOENT'); return f[p]; },
        writeFileSync: (p, d) => { f[p] = d; },
        renameSync: (a, b) => { f[b] = f[a]; delete f[a]; },
        mkdirSync: () => undefined,
        copyFileSync: (a, b) => { if (!(a in f)) throw new Error('ENOENT'); f[b] = f[a]; },
    };
}
const HOME = '/home/u';
const USER_FILE = '/home/u/.local/share/applications/cipherline.desktop';
const IMG = '/home/u/Apps/Cipherline-1.AppImage';

describe('ensureMainDesktopEntry', () => {
    it('.deb: package owns cipherline.desktop, nothing is written', () => {
        const fs = fakeFs();
        expect(ensureMainDesktopEntry(fs, {}, HOME)).toBe('package-owned');
        expect(fs.files).toEqual({});
    });
    it('AppImage first run writes a user-level entry that execs the AppImage and carries the app id + marker', () => {
        const fs = fakeFs();
        expect(ensureMainDesktopEntry(fs, { APPIMAGE: IMG }, HOME)).toBe('written');
        const c = fs.files[USER_FILE];
        expect(c).toContain(`Exec=${IMG} %U`);
        expect(c).toContain('StartupWMClass=Cipherline');
        expect(c).toContain('X-Cipherline-Managed=true');
    });
    it('quotes an AppImage path with spaces', () => {
        const fs = fakeFs();
        ensureMainDesktopEntry(fs, { APPIMAGE: '/home/u/My Apps/C.AppImage' }, HOME);
        expect(fs.files[USER_FILE]).toContain('Exec="/home/u/My Apps/C.AppImage" %U');
    });
    it('AppImage run again is unchanged; a moved AppImage refreshes the Exec', () => {
        const fs = fakeFs();
        ensureMainDesktopEntry(fs, { APPIMAGE: IMG }, HOME);
        expect(ensureMainDesktopEntry(fs, { APPIMAGE: IMG }, HOME)).toBe('unchanged');
        expect(ensureMainDesktopEntry(fs, { APPIMAGE: '/mnt/new/C.AppImage' }, HOME)).toBe('written');
        expect(fs.files[USER_FILE]).toContain('/mnt/new/C.AppImage');
    });
    it('AppImage with the .deb also installed: does not shadow the system entry', () => {
        const fs = fakeFs({ '/usr/share/applications/cipherline.desktop': '[Desktop Entry]\n' });
        expect(ensureMainDesktopEntry(fs, { APPIMAGE: IMG }, HOME)).toBe('system-entry');
        expect(fs.files[USER_FILE]).toBeUndefined();
    });
    it('NEGATIVE: a user file that is not ours (no marker) is never overwritten', () => {
        const mine = '[Desktop Entry]\nName=Mine\nExec=/bin/mine\n';
        const fs = fakeFs({ [USER_FILE]: mine });
        expect(ensureMainDesktopEntry(fs, { APPIMAGE: IMG }, HOME)).toBe('foreign');
        expect(fs.files[USER_FILE]).toBe(mine);
    });
    it('a relative or empty $APPIMAGE is treated as no AppImage', () => {
        expect(ensureMainDesktopEntry(fakeFs(), { APPIMAGE: 'rel.AppImage' }, HOME)).toBe('package-owned');
    });
    it('honours XDG_DATA_HOME', () => {
        const fs = fakeFs();
        ensureMainDesktopEntry(fs, { APPIMAGE: IMG, XDG_DATA_HOME: '/data' }, HOME);
        expect(Object.keys(fs.files)).toEqual(['/data/applications/cipherline.desktop']);
    });
    it('a write failure is reported, never thrown', () => {
        const fs = fakeFs();
        fs.writeFileSync = () => { throw new Error('EROFS'); };
        expect(writeManagedDesktopFile(fs, '/x', 'a.desktop', buildMainDesktopEntry(IMG))).toBe('error');
    });
});

describe('portal id entry follows the running install', () => {
    const PORTAL = '/home/u/.local/share/applications/chat.cipherline.Cipherline.desktop';
    it('refreshes a managed file whose Exec went stale, leaves a foreign one', () => {
        const store: Record<string, string> = {};
        const fsApi = {
            existsSync: (p: string) => p in store,
            readFileSync: (p: string) => store[p],
            writeFileSync: (p: string, d: string) => { store[p] = d; },
            mkdirSync: () => undefined,
        } as never;
        expect(ensureDesktopEntry('/old/C.AppImage', { HOME }, fsApi)).toBe(true);
        expect(store[PORTAL]).toContain('/old/C.AppImage');
        ensureDesktopEntry('/new/C.AppImage', { HOME }, fsApi);
        expect(store[PORTAL]).toContain('/new/C.AppImage');
        store[PORTAL] = '[Desktop Entry]\nExec=/hand/made\n';
        ensureDesktopEntry('/new2/C.AppImage', { HOME }, fsApi);
        expect(store[PORTAL]).toContain('/hand/made');
    });
});

describe('AppImage icon (KDE drew a blank icon: Icon=cipherline had no file behind it)', () => {
    const APPDIR = '/tmp/.mount_CipherXYZ';
    const SRC512 = `${APPDIR}/usr/share/icons/hicolor/512x512/apps/cipherline.png`;
    const DEST512 = '/home/u/.local/share/icons/hicolor/512x512/apps/cipherline.png';
    it('the first AppImage run copies the bundled icon into the user hicolor theme', () => {
        const fs = fakeFs({ [SRC512]: 'PNG' });
        expect(ensureMainDesktopEntry(fs, { APPIMAGE: IMG, APPDIR }, HOME)).toBe('written');
        expect(fs.files[DEST512]).toBe('PNG');
    });
    it('falls back to a smaller bundled size', () => {
        const src = `${APPDIR}/usr/share/icons/hicolor/256x256/apps/cipherline.png`;
        const fs = fakeFs({ [src]: 'PNG256' });
        expect(ensureUserIcon(fs, { APPDIR }, '/home/u/.local/share')).toBe('copied');
        expect(fs.files['/home/u/.local/share/icons/hicolor/256x256/apps/cipherline.png']).toBe('PNG256');
    });
    it('an icon already in the user theme is left alone', () => {
        const fs = fakeFs({ [SRC512]: 'NEW', [DEST512]: 'OLD' });
        expect(ensureUserIcon(fs, { APPDIR }, '/home/u/.local/share')).toBe('present');
        expect(fs.files[DEST512]).toBe('OLD');
    });
    it('no APPDIR (the .deb) or no bundled icon: nothing written, never throws', () => {
        const fs = fakeFs();
        expect(ensureUserIcon(fs, {}, '/home/u/.local/share')).toBe('no-source');
        expect(ensureUserIcon(fs, { APPDIR }, '/home/u/.local/share')).toBe('no-source');
        expect(Object.keys(fs.files)).toEqual([]);
    });
    it('a foreign desktop file (not ours) means no icon copy either', () => {
        const fs = fakeFs({ [USER_FILE]: '[Desktop Entry]\nName=Mine\n', [SRC512]: 'PNG' });
        expect(ensureMainDesktopEntry(fs, { APPIMAGE: IMG, APPDIR }, HOME)).toBe('foreign');
        expect(fs.files[DEST512]).toBeUndefined();
    });
});
