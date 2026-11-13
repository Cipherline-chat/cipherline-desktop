import { describe, it, expect } from 'vitest';
import { setXdgAutostart, reconcileXdgAutostart, isOurAutostartEntry, execProgram, type AutostartFs } from './linux-autostart';
import { buildXdgDesktopEntry } from './login-item';

const DIR = '/home/u/.config/autostart';
function fakeFs(files: Record<string, string>): AutostartFs & { files: Record<string, string> } {
    const f = { ...files };
    return {
        files: f,
        readdirSync: (d) => { if (d !== DIR) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return Object.keys(f).filter(k => k.startsWith(d + '/')).map(k => k.slice(d.length + 1)); },
        readFileSync: (p) => { if (!(p in f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return f[p]; },
        writeFileSync: (p, d) => { f[p] = d; },
        renameSync: (a, b) => { f[b] = f[a]; delete f[a]; },
        unlinkSync: (p) => { if (!(p in f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); delete f[p]; },
        mkdirSync: () => undefined,
    };
}
const entry = (exec: string, extra = '') => `[Desktop Entry]\nType=Application\nName=Cipherline\nExec=${exec}\n${extra}`;
const DEB = ['/opt/Cipherline/cipherline', '--autostart'];
const APPIMG = ['/home/u/Apps/Cipherline-1.0.24.AppImage', '--autostart'];
const OWN = `${DIR}/cipherline.desktop`;

describe('isOurAutostartEntry', () => {
    it('recognises the deb binary, a cipherline AppImage and our marker', () => {
        expect(isOurAutostartEntry(entry('/opt/Cipherline/cipherline --autostart'))).toBe(true);
        expect(isOurAutostartEntry(entry('"/home/u/My Apps/Cipherline-1.0.AppImage" --autostart'))).toBe(true);
        expect(isOurAutostartEntry(entry('/usr/bin/whatever', 'X-Cipherline-Managed=true\n'))).toBe(true);
        expect(isOurAutostartEntry(buildXdgDesktopEntry(DEB))).toBe(true);
    });
    it('NEGATIVE: leaves other programs alone, even ones named Cipherline-ish or running as args', () => {
        expect(isOurAutostartEntry(entry('/usr/bin/firefox'))).toBe(false);
        expect(isOurAutostartEntry(entry('/usr/bin/other-app --cipherline'))).toBe(false);
        expect(isOurAutostartEntry(entry('/usr/bin/cipherline-notes'))).toBe(false);
        expect(isOurAutostartEntry('')).toBe(false);
    });
    it('execProgram handles quotes and escapes', () => {
        expect(execProgram('"/a b/c" x')).toBe('/a b/c');
        expect(execProgram('/a/b x y')).toBe('/a/b');
        expect(execProgram(undefined)).toBeNull();
    });
});

describe('setXdgAutostart: AppImage -> .deb switch', () => {
    it('removes the AppImage-era entry under another filename and leaves exactly one pointing at the deb', () => {
        const fs = fakeFs({
            [`${DIR}/appimagekit_abc-Cipherline.desktop`]: entry('/home/u/Apps/Cipherline-1.0.24.AppImage --autostart'),
            [OWN]: buildXdgDesktopEntry(APPIMG),
            [`${DIR}/unrelated.desktop`]: entry('/usr/bin/firefox'),
        });
        setXdgAutostart(fs, DIR, DEB, true);
        const names = Object.keys(fs.files).sort();
        expect(names).toEqual([OWN, `${DIR}/unrelated.desktop`]);
        expect(fs.files[OWN]).toContain('Exec=/opt/Cipherline/cipherline --autostart');
        expect(fs.files[`${DIR}/unrelated.desktop`]).toContain('firefox');
    });
    it('positive control: without the sweep (naive write) the duplicate would survive', () => {
        const fs = fakeFs({ [`${DIR}/Cipherline.desktop`]: entry('/home/u/Apps/Cipherline.AppImage --autostart') });
        // The pre-fix behaviour: write only our own file.
        fs.writeFileSync(OWN, buildXdgDesktopEntry(DEB));
        expect(Object.keys(fs.files)).toHaveLength(2);
        const fixed = fakeFs({ [`${DIR}/Cipherline.desktop`]: entry('/home/u/Apps/Cipherline.AppImage --autostart') });
        setXdgAutostart(fixed, DIR, DEB, true);
        expect(Object.keys(fixed.files)).toEqual([OWN]);
    });
    it('turning OFF removes every entry of ours (a leftover would keep launching the app) but nothing else', () => {
        const fs = fakeFs({
            [OWN]: buildXdgDesktopEntry(DEB),
            [`${DIR}/old.desktop`]: entry('/x/Cipherline.AppImage'),
            [`${DIR}/keep.desktop`]: entry('/usr/bin/keep'),
        });
        setXdgAutostart(fs, DIR, DEB, false);
        expect(Object.keys(fs.files)).toEqual([`${DIR}/keep.desktop`]);
    });
    it('OFF with nothing there is not an error', () => {
        expect(() => setXdgAutostart(fakeFs({}), DIR, DEB, false)).not.toThrow();
    });
});

describe('reconcileXdgAutostart (boot)', () => {
    it('folds a lone foreign enabled entry into the canonical file', () => {
        const fs = fakeFs({ [`${DIR}/Cipherline.desktop`]: entry('/x/Cipherline.AppImage --autostart') });
        expect(reconcileXdgAutostart(fs, DIR, DEB)).toBe(true);
        expect(Object.keys(fs.files)).toEqual([OWN]);
        expect(fs.files[OWN]).toContain('/opt/Cipherline/cipherline');
    });
    it('respects a canonical file the user switched off: foreign removed, ours stays off', () => {
        const off = buildXdgDesktopEntry(DEB).replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false');
        const fs = fakeFs({ [OWN]: off, [`${DIR}/old.desktop`]: entry('/x/Cipherline.AppImage') });
        reconcileXdgAutostart(fs, DIR, DEB);
        expect(Object.keys(fs.files)).toEqual([OWN]);
        expect(fs.files[OWN]).toBe(off);
    });
    it('a disabled foreign entry alone does not turn autostart on', () => {
        const fs = fakeFs({ [`${DIR}/old.desktop`]: entry('/x/Cipherline.AppImage', 'Hidden=true\n') });
        reconcileXdgAutostart(fs, DIR, DEB);
        expect(Object.keys(fs.files)).toEqual([]);
    });
    it('rewrites a stale Exec (AppImage moved) and is a no-op when current', () => {
        const fs = fakeFs({ [OWN]: buildXdgDesktopEntry(['/old/place.AppImage', '--autostart']) });
        expect(reconcileXdgAutostart(fs, DIR, APPIMG)).toBe(true);
        expect(fs.files[OWN]).toContain('Cipherline-1.0.24.AppImage');
        expect(reconcileXdgAutostart(fs, DIR, APPIMG)).toBe(false);
    });
    it('never creates an entry from nothing', () => {
        const fs = fakeFs({ [`${DIR}/keep.desktop`]: entry('/usr/bin/keep') });
        expect(reconcileXdgAutostart(fs, DIR, DEB)).toBe(false);
        expect(Object.keys(fs.files)).toEqual([`${DIR}/keep.desktop`]);
    });
});
