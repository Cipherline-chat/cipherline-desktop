import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    AUTOSTART_ARG,
    loginItemTarget,
    electronLoginItemQuery,
    electronLoginItemSettings,
    interpretElectronLoginItem,
    windowsLoginItemNeedsRetrofit,
    leftoverWindowsLaunchItemNames,
    xdgAutostartPath,
    quoteExecArg,
    buildXdgDesktopEntry,
    interpretXdgEntry,
    xdgEntryNeedsRewrite,
    shouldApplyLoginDefault,
    resolveBoolPref,
    encodeBoolPref,
    wasLaunchedAtLogin,
    shouldStartMinimized,
    shouldHideToTrayOnClose,
    DEFAULT_START_MINIMIZED,
    DEFAULT_MINIMIZE_TO_TRAY,
    type LoginItemTarget,
} from './login-item';

// ── A model of Electron's Windows login-item implementation ──────────────────
// HKCU\...\Run holds `name → "exe" args`. setLoginItemSettings writes/deletes
// by name (default: the AppUserModelId). getLoginItemSettings(options):
//   openAtLogin                 = Run[name] === command line built from
//                                 options.path (default execPath) + options.args
//                                 (default [])  ← the comparison that bit us
//   executableWillLaunchAtLogin = some Run value launches options.path (any
//                                 args) and is not disabled in StartupApproved
const EXEC = 'C:\\Users\\Dawson\\AppData\\Local\\Programs\\cipherline\\Cipherline.exe';
const AUMID = 'com.cipherline.desktop';

function fakeWindowsRegistry(execPath = EXEC) {
    const run = new Map<string, { path: string; args: string[] }>();
    const disabled = new Set<string>();
    const cmd = (p: string, a: string[]) => [`"${p}"`, ...a].join(' ');
    return {
        run, disabled,
        set(s: { openAtLogin?: boolean; path?: string; args?: string[]; name?: string; enabled?: boolean }) {
            const name = s.name ?? AUMID;
            if (s.openAtLogin) {
                run.set(name, { path: s.path ?? execPath, args: s.args ?? [] });
                if (s.enabled !== false) disabled.delete(name);
            } else {
                run.delete(name);
            }
        },
        get(o: { path?: string; args?: string[] } = {}) {
            const p = o.path ?? execPath;
            const entry = run.get(AUMID);
            const launchItems = [...run.entries()]
                .filter(([, v]) => v.path === p)
                .map(([name, v]) => ({ name, path: v.path, args: v.args, scope: 'user' as const, enabled: !disabled.has(name) }));
            return {
                openAtLogin: !!entry && cmd(entry.path, entry.args) === cmd(p, o.args ?? []),
                executableWillLaunchAtLogin: launchItems.some(i => i.enabled),
                launchItems,
            };
        },
    };
}

const winInstalled = (): LoginItemTarget => loginItemTarget({ platform: 'win32', isPackaged: true, execPath: EXEC });

describe('Windows "Start with Windows" round trip', () => {
    it('CONTROL — the old code: written with --autostart, read back bare → OFF (the reported bug)', () => {
        const reg = fakeWindowsRegistry();
        // main.ts before this fix: set with the marker...
        reg.set({ openAtLogin: true, args: ['--autostart'] });
        // ...read with `app.getLoginItemSettings()` — no args → compares against [].
        expect(reg.get().openAtLogin).toBe(false);
        // The item IS registered — the toggle was simply misreading it.
        expect(reg.run.get(AUMID)?.args).toEqual(['--autostart']);
    });

    it('write and read built from one target agree: ON stays ON', () => {
        const reg = fakeWindowsRegistry();
        const t = winInstalled();
        reg.set(electronLoginItemSettings(t, true));
        const state = interpretElectronLoginItem(t, reg.get(electronLoginItemQuery(t)));
        expect(state).toEqual({ supported: true, enabled: true, needsApproval: false });
        expect(reg.get(electronLoginItemQuery(t)).openAtLogin).toBe(true);
    });

    it('OFF removes it and reads OFF', () => {
        const reg = fakeWindowsRegistry();
        const t = winInstalled();
        reg.set(electronLoginItemSettings(t, true));
        reg.set(electronLoginItemSettings(t, false));
        expect(interpretElectronLoginItem(t, reg.get(electronLoginItemQuery(t))).enabled).toBe(false);
        expect(reg.run.size).toBe(0);
    });

    it('the registered command line is "<installed exe>" --autostart', () => {
        const t = winInstalled();
        expect(t).toEqual({ kind: 'windows', path: EXEC, args: [AUTOSTART_ARG] });
        expect(electronLoginItemSettings(t, true)).toEqual({ openAtLogin: true, path: EXEC, args: ['--autostart'], enabled: true });
    });

    it('a pre-marker entry (no --autostart) reads ON and is flagged for retrofit', () => {
        const reg = fakeWindowsRegistry();
        const t = winInstalled();
        reg.set({ openAtLogin: true }); // what builds before c965df32 wrote
        const s = reg.get(electronLoginItemQuery(t));
        expect(interpretElectronLoginItem(t, s).enabled).toBe(true);
        expect(windowsLoginItemNeedsRetrofit(s)).toBe(true);
        reg.set(electronLoginItemSettings(t, true));
        expect(windowsLoginItemNeedsRetrofit(reg.get(electronLoginItemQuery(t)))).toBe(false);
    });

    it('an entry the user disabled in Task Manager reads OFF, and turning it ON re-enables it', () => {
        const reg = fakeWindowsRegistry();
        const t = winInstalled();
        reg.set(electronLoginItemSettings(t, true));
        reg.disabled.add(AUMID);
        expect(interpretElectronLoginItem(t, reg.get(electronLoginItemQuery(t))).enabled).toBe(false);
        expect(windowsLoginItemNeedsRetrofit(reg.get(electronLoginItemQuery(t)))).toBe(false);
        reg.set(electronLoginItemSettings(t, true));
        expect(interpretElectronLoginItem(t, reg.get(electronLoginItemQuery(t))).enabled).toBe(true);
    });

    it('turning OFF also finds same-exe entries under another value name', () => {
        const reg = fakeWindowsRegistry();
        const t = winInstalled();
        reg.run.set('electron.app.Cipherline', { path: EXEC, args: [] });
        reg.set(electronLoginItemSettings(t, false));
        const after = reg.get(electronLoginItemQuery(t));
        expect(interpretElectronLoginItem(t, after).enabled).toBe(true); // still launches
        const names = leftoverWindowsLaunchItemNames(after.launchItems, EXEC);
        expect(names).toEqual(['electron.app.Cipherline']);
        for (const name of names) reg.set({ openAtLogin: false, name });
        expect(interpretElectronLoginItem(t, reg.get(electronLoginItemQuery(t))).enabled).toBe(false);
    });

    it('leftover scan ignores machine-scope and other executables; path match is case-insensitive', () => {
        expect(leftoverWindowsLaunchItemNames([
            { name: 'a', path: EXEC.toUpperCase(), scope: 'user' },
            { name: 'b', path: EXEC, scope: 'machine' },
            { name: 'c', path: 'C:\\Other\\x.exe', scope: 'user' },
        ], EXEC)).toEqual(['a']);
        expect(leftoverWindowsLaunchItemNames(undefined, EXEC)).toEqual([]);
    });

    it('portable build points at the real .exe, not the per-run temp extraction', () => {
        const t = loginItemTarget({
            platform: 'win32', isPackaged: true,
            execPath: 'C:\\Users\\D\\AppData\\Local\\Temp\\2abc\\Cipherline.exe',
            portableExecutable: 'D:\\Apps\\Cipherline 1.0.18.exe',
        });
        expect(t).toEqual({ kind: 'windows', path: 'D:\\Apps\\Cipherline 1.0.18.exe', args: ['--autostart'] });
    });

    it('dev build (npm run dev:windows → bare electron.exe) is unsupported, never registered', () => {
        const t = loginItemTarget({ platform: 'win32', isPackaged: false, execPath: 'C:\\dev\\cl\\node_modules\\electron\\dist\\electron.exe' });
        expect(t).toEqual({ kind: 'unsupported', reason: 'dev-build' });
        expect(interpretElectronLoginItem(t, { openAtLogin: true })).toEqual({ supported: false, enabled: false, needsApproval: false });
        expect(shouldApplyLoginDefault({ target: t, storeOk: true, isSmokeTest: false, defaultAppliedFlag: null })).toBe(false);
    });
});

describe('macOS login item', () => {
    const t = loginItemTarget({ platform: 'darwin', isPackaged: true, execPath: '/Applications/Cipherline.app/Contents/MacOS/Cipherline' });

    it('uses the SMAppService main-app item, no path/args', () => {
        expect(t).toEqual({ kind: 'mac' });
        expect(electronLoginItemSettings(t, true)).toEqual({ openAtLogin: true });
        expect(electronLoginItemSettings(t, false)).toEqual({ openAtLogin: false });
        expect(electronLoginItemQuery(t)).toEqual({});
    });

    it('status enabled → ON; requires-approval → ON + needsApproval; not-registered → OFF', () => {
        expect(interpretElectronLoginItem(t, { openAtLogin: true, status: 'enabled' })).toEqual({ supported: true, enabled: true, needsApproval: false });
        expect(interpretElectronLoginItem(t, { openAtLogin: false, status: 'requires-approval' })).toEqual({ supported: true, enabled: true, needsApproval: true });
        expect(interpretElectronLoginItem(t, { openAtLogin: false, status: 'not-registered' })).toEqual({ supported: true, enabled: false, needsApproval: false });
    });

    it('dev build is unsupported (would register Electron.app)', () => {
        expect(loginItemTarget({ platform: 'darwin', isPackaged: false, execPath: '/x/Electron.app/Contents/MacOS/Electron' }).kind).toBe('unsupported');
    });
});

describe('Linux XDG autostart', () => {
    it('CONTROL — the old default skipped Linux entirely; it is now applied there too', () => {
        // main.ts before: `(process.platform === 'win32' || process.platform === 'darwin')`
        const oldEligible = (platform: string) => platform === 'win32' || platform === 'darwin';
        expect(oldEligible('linux')).toBe(false);
        const t = loginItemTarget({ platform: 'linux', isPackaged: true, execPath: '/opt/Cipherline/cipherline' });
        expect(shouldApplyLoginDefault({ target: t, storeOk: true, isSmokeTest: false, defaultAppliedFlag: null })).toBe(true);
    });

    it('deb: Exec is the installed binary with the marker', () => {
        const t = loginItemTarget({ platform: 'linux', isPackaged: true, execPath: '/opt/Cipherline/cipherline' });
        expect(t).toEqual({ kind: 'xdg', exec: ['/opt/Cipherline/cipherline', '--autostart'] });
        const entry = buildXdgDesktopEntry((t as { exec: string[] }).exec);
        expect(entry).toContain('[Desktop Entry]\n');
        expect(entry).toContain('\nType=Application\n');
        expect(entry).toContain('\nExec=/opt/Cipherline/cipherline --autostart\n');
        expect(entry).toContain('\nX-GNOME-Autostart-enabled=true\n');
        expect(interpretXdgEntry(entry).enabled).toBe(true);
    });

    it('AppImage: Exec is $APPIMAGE (the file), never the /tmp/.mount_* execPath', () => {
        const t = loginItemTarget({
            platform: 'linux', isPackaged: true,
            execPath: '/tmp/.mount_CipherXyZ12/cipherline',
            appImage: '/home/dawson/Apps/Cipherline 1.0.18.AppImage',
        });
        expect(t).toEqual({ kind: 'xdg', exec: ['/home/dawson/Apps/Cipherline 1.0.18.AppImage', '--autostart'] });
        expect(buildXdgDesktopEntry((t as { exec: string[] }).exec))
            .toContain('\nExec="/home/dawson/Apps/Cipherline 1.0.18.AppImage" --autostart\n');
    });

    it('a moved AppImage is rewritten; a matching or disabled entry is left alone', () => {
        const oldExec = ['/home/d/old/Cipherline.AppImage', '--autostart'];
        const newExec = ['/home/d/new/Cipherline.AppImage', '--autostart'];
        expect(xdgEntryNeedsRewrite(buildXdgDesktopEntry(oldExec), newExec)).toBe(true);
        expect(xdgEntryNeedsRewrite(buildXdgDesktopEntry(newExec), newExec)).toBe(false);
        expect(xdgEntryNeedsRewrite(null, newExec)).toBe(false); // never creates
        expect(xdgEntryNeedsRewrite(buildXdgDesktopEntry(oldExec) + 'Hidden=true\n', newExec)).toBe(false);
    });

    it('desktop-environment "off" markers read as OFF; absent file reads OFF', () => {
        const base = buildXdgDesktopEntry(['/opt/Cipherline/cipherline', '--autostart']);
        expect(interpretXdgEntry(null).enabled).toBe(false);
        expect(interpretXdgEntry(base.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false')).enabled).toBe(false);
        expect(interpretXdgEntry(base + 'Hidden=true\n').enabled).toBe(false);
        // A key in a different group does not count.
        expect(interpretXdgEntry(base + '[Desktop Action x]\nHidden=true\n').enabled).toBe(true);
    });

    it('Exec quoting follows the Desktop Entry spec', () => {
        expect(quoteExecArg('/opt/Cipherline/cipherline')).toBe('/opt/Cipherline/cipherline');
        expect(quoteExecArg('/a b/c')).toBe('"/a b/c"');
        expect(quoteExecArg('/a$b/"c"')).toBe('"/a\\$b/\\"c\\""');
        expect(quoteExecArg('/100%/x')).toBe('/100%%/x');
    });

    it('path honours an absolute XDG_CONFIG_HOME, else ~/.config', () => {
        expect(xdgAutostartPath('/home/d')).toBe('/home/d/.config/autostart/cipherline.desktop');
        expect(xdgAutostartPath('/home/d/', '/xdg/cfg/')).toBe('/xdg/cfg/autostart/cipherline.desktop');
        expect(xdgAutostartPath('/home/d', 'relative/ignored')).toBe('/home/d/.config/autostart/cipherline.desktop');
    });

    it('the written file round-trips through a real filesystem', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-autostart-'));
        try {
            const file = xdgAutostartPath(dir, path.join(dir, 'cfg'));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, buildXdgDesktopEntry(['/opt/Cipherline/cipherline', AUTOSTART_ARG]));
            expect(interpretXdgEntry(fs.readFileSync(file, 'utf8')).enabled).toBe(true);
            fs.unlinkSync(file);
            expect(interpretXdgEntry(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null).enabled).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('default resolution', () => {
    it('no stored value → ON; stored false → OFF; stored true → ON', () => {
        for (const def of [DEFAULT_START_MINIMIZED, DEFAULT_MINIMIZE_TO_TRAY]) {
            expect(def).toBe(true);
            expect(resolveBoolPref(null, def)).toBe(true);
            expect(resolveBoolPref(undefined, def)).toBe(true);
            expect(resolveBoolPref('', def)).toBe(true);
            expect(resolveBoolPref('garbage', def)).toBe(true);
            expect(resolveBoolPref('false', def)).toBe(false);
            expect(resolveBoolPref('true', def)).toBe(true);
        }
    });

    it('CONTROL — old minimizeToTray read (`=== "true"`) made a fresh install OFF', () => {
        const oldRead = (stored: string | null) => stored === 'true';
        expect(oldRead(null)).toBe(false);
        expect(resolveBoolPref(null, DEFAULT_MINIMIZE_TO_TRAY)).toBe(true);
    });

    it('a restored backup value wins over the default (it is just a stored value)', () => {
        // importLocalHistory writes appPrefs via secure:replace-many; after that
        // the store holds the backed-up string and resolution reads it.
        const store = new Map<string, string>();
        expect(resolveBoolPref(store.get('minimizeToTray'), DEFAULT_MINIMIZE_TO_TRAY)).toBe(true);
        store.set('minimizeToTray', 'false'); // restored
        expect(resolveBoolPref(store.get('minimizeToTray'), DEFAULT_MINIMIZE_TO_TRAY)).toBe(false);
    });

    it('encode/resolve round-trip', () => {
        expect(resolveBoolPref(encodeBoolPref(false), true)).toBe(false);
        expect(resolveBoolPref(encodeBoolPref(true), false)).toBe(true);
    });

    it('login default applies once, never over a recorded choice, never blind or in smoke test', () => {
        const t = winInstalled();
        expect(shouldApplyLoginDefault({ target: t, storeOk: true, isSmokeTest: false, defaultAppliedFlag: null })).toBe(true);
        expect(shouldApplyLoginDefault({ target: t, storeOk: true, isSmokeTest: false, defaultAppliedFlag: 'true' })).toBe(false);
        expect(shouldApplyLoginDefault({ target: t, storeOk: false, isSmokeTest: false, defaultAppliedFlag: null })).toBe(false);
        expect(shouldApplyLoginDefault({ target: t, storeOk: true, isSmokeTest: true, defaultAppliedFlag: null })).toBe(false);
    });
});

describe('start minimized only for a login launch', () => {
    const base = { showInstaller: false, storeOk: true, startMinimizedStored: null as string | null };

    it('login launch + default → minimized', () => {
        expect(shouldStartMinimized({ ...base, launchedAtLogin: wasLaunchedAtLogin(['C:\\x\\Cipherline.exe', '--autostart'], 'win32', false) })).toBe(true);
        expect(shouldStartMinimized({ ...base, launchedAtLogin: wasLaunchedAtLogin(['/opt/Cipherline/cipherline', '--autostart'], 'linux', false) })).toBe(true);
        expect(shouldStartMinimized({ ...base, launchedAtLogin: wasLaunchedAtLogin(['/Applications/Cipherline.app/Contents/MacOS/Cipherline'], 'darwin', true) })).toBe(true);
    });

    it('CONTROL — the user double-clicking the app always sees the window (pre-c965df32 minimized every launch)', () => {
        const oldDecision = (stored: string | null) => stored === 'true'; // ignored how it was launched
        expect(oldDecision('true')).toBe(true);
        const launched = wasLaunchedAtLogin(['C:\\x\\Cipherline.exe'], 'win32', false);
        expect(launched).toBe(false);
        expect(shouldStartMinimized({ ...base, startMinimizedStored: 'true', launchedAtLogin: launched })).toBe(false);
    });

    it('first launch after install (installer "Run Cipherline" / splash up) shows the window', () => {
        expect(shouldStartMinimized({ ...base, launchedAtLogin: false, showInstaller: true })).toBe(false);
        // even a login launch defers to the splash
        expect(shouldStartMinimized({ ...base, launchedAtLogin: true, showInstaller: true })).toBe(false);
    });

    it('explicit OFF, or an unreadable store, shows the window', () => {
        expect(shouldStartMinimized({ ...base, launchedAtLogin: true, startMinimizedStored: 'false' })).toBe(false);
        expect(shouldStartMinimized({ ...base, launchedAtLogin: true, storeOk: false })).toBe(false);
    });

    it('macOS ignores argv-less heuristics: no wasOpenedAtLogin → shown; other platforms ignore the mac flag', () => {
        expect(wasLaunchedAtLogin(['/Applications/Cipherline.app/Contents/MacOS/Cipherline'], 'darwin', false)).toBe(false);
        expect(wasLaunchedAtLogin(['C:\\x\\Cipherline.exe'], 'win32', true)).toBe(false);
    });
});

describe('minimize to tray never strands the window', () => {
    it('hides only with the pref on, a real tray icon, and no quit in progress', () => {
        expect(shouldHideToTrayOnClose({ isQuitting: false, minimizeToTray: true, trayExists: true })).toBe(true);
        expect(shouldHideToTrayOnClose({ isQuitting: false, minimizeToTray: true, trayExists: false })).toBe(false);
        expect(shouldHideToTrayOnClose({ isQuitting: true, minimizeToTray: true, trayExists: true })).toBe(false);
        expect(shouldHideToTrayOnClose({ isQuitting: false, minimizeToTray: false, trayExists: true })).toBe(false);
    });
});
