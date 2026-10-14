/**
 * Built-in default exclusions: Wallpaper Engine runs all day, so it must never
 * read as "Playing Wallpaper Engine" — whichever detection layer would have
 * matched it. Drives the real detector against a fake Windows Steam library
 * and a fake process list (same harness as game-detector.resident.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

const LIB = 'D:/SteamLibrary';
const STEAM = 'C:\\Program Files (x86)\\Steam';
const steamapps = join(LIB, 'steamapps');
const common = join(steamapps, 'common');
const weDir = join(common, 'wallpaper_engine');
const rivalsDir = join(common, 'MarvelRivals');

const files = new Map<string, string>();
const dirs = new Map<string, Array<{ name: string; dir: boolean }>>();

let tasklist = '';
const tl = (...names: string[]) => names.map(n => `"${n}.exe","1234","Console","1","10,000 K"`).join('\r\n');

vi.mock('child_process', () => ({
    execFile: (file: string, _args: readonly string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
        if (file === 'tasklist') cb(null, { stdout: tasklist, stderr: '' });
        else if (file === 'powershell') cb(null, { stdout: 'ACTIVE\r\n', stderr: '' });
        else cb(null, { stdout: '', stderr: '' });
    },
}));

vi.mock('fs/promises', () => {
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return {
        access: async (p: string) => { if (!files.has(p) && !dirs.has(p)) throw enoent(); },
        readFile: async (p: string) => { const t = files.get(p); if (t === undefined) throw enoent(); return t; },
        readdir: async (p: string, opts?: { withFileTypes?: boolean }) => {
            const d = dirs.get(p);
            if (!d) throw enoent();
            if (!opts?.withFileTypes) return d.map(e => e.name);
            return d.map(e => ({ name: e.name, isFile: () => !e.dir, isDirectory: () => e.dir }));
        },
        stat: async (p: string) => {
            if (!files.has(p) && !dirs.has(p)) throw enoent();
            return { mtimeMs: 1, mode: 0o755 };
        },
    };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let gd: typeof import('./game-detector');

/** Wallpaper Engine's real layout: launcher at the root, the rest under bin/. */
const WE_ROOT = ['launcher.exe'];
const WE_BIN = ['ui32.exe', 'wallpaper32.exe', 'wallpaper64.exe', 'webwallpaper32.exe', 'wallpaperservice32.exe', 'applicationwallpaper64.exe'];
// Everything Wallpaper Engine ships that could be running, as tasklist names.
const WE_PROCS = ['ui32', 'wallpaper32', 'wallpaper64', 'webwallpaper32', 'wallpaperservice32', 'applicationwallpaper64', 'launcher'];

function installWallpaperEngine() {
    files.set(join(steamapps, 'appmanifest_431960.acf'), '"AppState" { "appid" "431960" "name" "Wallpaper Engine" "installdir" "wallpaper_engine" }');
    dirs.set(weDir, [...WE_ROOT.map(name => ({ name, dir: false })), { name: 'bin', dir: true }]);
    dirs.set(join(weDir, 'bin'), WE_BIN.map(name => ({ name, dir: false })));
    dirs.set(steamapps, [...(dirs.get(steamapps) ?? []), { name: 'appmanifest_431960.acf', dir: false }]);
}

beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    files.clear(); dirs.clear();
    files.set(join(STEAM, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" "${LIB}" } }`);
    dirs.set(join(STEAM, 'steamapps'), []);
    files.set(join(steamapps, 'appmanifest_1.acf'), '"AppState" { "appid" "1" "name" "Marvel Rivals" "installdir" "MarvelRivals" }');
    dirs.set(steamapps, [{ name: 'appmanifest_1.acf', dir: false }]);
    dirs.set(rivalsDir, [{ name: 'MarvelRivals.exe', dir: false }]);

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    gd = await import('./game-detector');
    gd.__resetGameDetectorForTests();
    gd.setCustomGames([]);
    gd.setIgnoredProcesses([]);
    tasklist = '';
});

afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', realPlatform);
});

describe('Wallpaper Engine is never a game by default', () => {
    it('Steam appmanifest layer: none of its executables read as "Playing Wallpaper Engine"', async () => {
        installWallpaperEngine();
        for (const proc of WE_PROCS) {
            gd.__resetGameDetectorForTests();
            tasklist = tl('system', proc);
            expect(await gd.detectCurrentGame(), proc).toBeNull();
        }
    });

    it('the whole Wallpaper Engine process set at once is not a game', async () => {
        installWallpaperEngine();
        tasklist = tl('system', ...WE_PROCS);
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('process-name layer: its distinctive exes are excluded even when the Steam folder is not recognised as Wallpaper Engine', async () => {
        // A copy under another appid / install folder (beta branch, moved
        // install): only the process-name list can catch it.
        files.set(join(steamapps, 'appmanifest_999999.acf'), '"AppState" { "appid" "999999" "name" "Wallpaper Engine Beta" "installdir" "we_beta" }');
        const betaDir = join(common, 'we_beta');
        dirs.set(betaDir, [{ name: 'bin', dir: true }]);
        dirs.set(join(betaDir, 'bin'), WE_BIN.map(name => ({ name, dir: false })));
        dirs.set(steamapps, [...dirs.get(steamapps)!, { name: 'appmanifest_999999.acf', dir: false }]);
        for (const proc of ['wallpaper32', 'wallpaper64', 'webwallpaper32', 'wallpaperservice32', 'applicationwallpaper64']) {
            gd.__resetGameDetectorForTests();
            tasklist = tl('system', proc);
            expect(await gd.detectCurrentGame(), proc).toBeNull();
        }
        // The generic name cannot be caught by name alone; this documents that
        // it is the folder/appid context (tests above) that covers ui32.
        gd.__resetGameDetectorForTests();
        tasklist = tl('system', 'ui32');
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Wallpaper Engine Beta', processName: 'ui32' });
    });

    it('the exclusion is recognised by appid or install folder, not by display name', async () => {
        // Renamed in the manifest (localised / edited), same appid.
        installWallpaperEngine();
        files.set(join(steamapps, 'appmanifest_431960.acf'), '"AppState" { "appid" "431960" "name" "Fondos Animados" "installdir" "wallpaper_engine" }');
        tasklist = tl('ui32');
        expect(await gd.detectCurrentGame()).toBeNull();
        expect(gd.isDefaultExcludedSteamApp('431960', 'anything')).toBe(true);
        expect(gd.isDefaultExcludedSteamApp('999', 'Wallpaper_Engine')).toBe(true);
        expect(gd.isDefaultExcludedSteamApp('1', 'MarvelRivals')).toBe(false);
        expect(gd.isDefaultExcludedSteamApp(undefined, undefined)).toBe(false);
    });

    it('a real game running alongside Wallpaper Engine is still detected, in either list order', async () => {
        installWallpaperEngine();
        tasklist = tl('system', 'wallpaper64', 'webwallpaper32', 'ui32', 'marvelrivals');
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Marvel Rivals', processName: 'marvelrivals' });

        gd.__resetGameDetectorForTests();
        tasklist = tl('marvelrivals', 'wallpaper64', 'ui32', 'launcher');
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Marvel Rivals', processName: 'marvelrivals' });

        gd.__resetGameDetectorForTests();
        tasklist = tl('wallpaper64', 'cs2'); // curated-database game
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Counter-Strike 2', processName: 'cs2' });
    });

    it('generic names are NOT excluded globally: ui32/launcher inside another game folder still count for that game', async () => {
        installWallpaperEngine();
        dirs.set(rivalsDir, [{ name: 'MarvelRivals.exe', dir: false }, { name: 'ui64.exe', dir: false }]);
        tasklist = tl('ui64');
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Marvel Rivals', processName: 'ui64' });
    });

    it('a name shared by Wallpaper Engine and one real game stays ambiguous (dropped), not credited to the real game', async () => {
        installWallpaperEngine();
        dirs.set(rivalsDir, [{ name: 'MarvelRivals.exe', dir: false }, { name: 'ui32.exe', dir: false }]);
        tasklist = tl('ui32');
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('is independent of the user\'s ignored list: clearing it does not bring Wallpaper Engine back', async () => {
        installWallpaperEngine();
        gd.setIgnoredProcesses(['somethingelse']);
        gd.setIgnoredProcesses([]);
        tasklist = tl('wallpaper64', 'ui32');
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('a user who wants it shown can opt back in with a custom game (Layer 1 outranks the default)', async () => {
        installWallpaperEngine();
        gd.setCustomGames([{ processName: 'wallpaper64', displayName: 'Wallpaper Engine' }]);
        tasklist = tl('system', 'wallpaper64');
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Wallpaper Engine', processName: 'wallpaper64' });
    });

    it('NEGATIVE CONTROL: an identically laid-out Steam app that is not Wallpaper Engine IS detected, so the nulls above are the exclusion', async () => {
        // Same folder shape, different appid / installdir / names.
        files.set(join(steamapps, 'appmanifest_777.acf'), '"AppState" { "appid" "777" "name" "Some Other App" "installdir" "other_app" }');
        const otherDir = join(common, 'other_app');
        dirs.set(otherDir, [{ name: 'otherapp.exe', dir: false }, { name: 'bin', dir: true }]);
        dirs.set(join(otherDir, 'bin'), [{ name: 'otherrender64.exe', dir: false }, { name: 'ui32.exe', dir: false }]);
        dirs.set(steamapps, [...dirs.get(steamapps)!, { name: 'appmanifest_777.acf', dir: false }]);
        for (const proc of ['otherapp', 'otherrender64', 'ui32']) {
            gd.__resetGameDetectorForTests();
            tasklist = tl('system', proc);
            expect(await gd.detectCurrentGame(), proc).toEqual({ name: 'Some Other App', processName: proc });
        }
    });
});
