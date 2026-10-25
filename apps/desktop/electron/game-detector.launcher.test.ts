/**
 * Owner report 2026-10-19: "it is still saying that someone is playing
 * marvel rivals … this person is not playing it".
 *
 * Marvel Rivals' Steam folder (steamapps/common/MarvelRivals):
 *
 *   MarvelRivals_Launcher.exe                               ← NetEase launcher; stays open
 *   MarvelGame/Marvel/Binaries/Win64/Marvel-Win64-Shipping.exe   ← the game
 *
 * The Steam-folder layer scanned two levels deep, so the ONLY exe it could
 * credit to "Marvel Rivals" was the launcher — the one process that keeps
 * running after the game closes. These tests drive the real detector against
 * that layout and pin: the launcher never reads as playing; the game process
 * does, and only while it runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

const LIB = 'D:/SteamLibrary';
const STEAM = 'C:\\Program Files (x86)\\Steam';
const steamapps = join(LIB, 'steamapps');
const gameDir = join(steamapps, 'common', 'MarvelRivals');

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

/** Lay out a directory tree: path → children ('/'-suffixed = folder). */
function tree(root: string, layout: Record<string, string[]>) {
    for (const [rel, children] of Object.entries(layout)) {
        const p = rel ? join(root, rel) : root;
        dirs.set(p, children.map(c => ({ name: c.replace(/\/$/, ''), dir: c.endsWith('/') })));
    }
}

beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    files.clear(); dirs.clear();
    files.set(join(STEAM, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" "${LIB}" } }`);
    dirs.set(join(STEAM, 'steamapps'), []);
    files.set(join(steamapps, 'appmanifest_2767030.acf'), '"AppState" { "appid" "2767030" "name" "Marvel Rivals" "installdir" "MarvelRivals" }');
    dirs.set(steamapps, [{ name: 'appmanifest_2767030.acf', dir: false }]);
    tree(gameDir, {
        '': ['MarvelRivals_Launcher.exe', 'MarvelGame/', 'launcher_update/'],
        'launcher_update': ['MarvelRivals_Updater.exe'],
        'MarvelGame': ['Marvel/', 'Engine/'],
        'MarvelGame/Marvel': ['Binaries/', 'Content/'],
        'MarvelGame/Marvel/Binaries': ['Win64/'],
        'MarvelGame/Marvel/Binaries/Win64': ['Marvel-Win64-Shipping.exe', 'CrashReportClient.exe', 'ThirdParty/'],
        'MarvelGame/Engine': ['Binaries/'],
        'MarvelGame/Engine/Binaries': ['Win64/'],
        'MarvelGame/Engine/Binaries/Win64': ['CrashReportClient.exe', 'UnrealCEFSubProcess.exe'],
    });
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

describe('Marvel Rivals — the launcher is not the game', () => {
    it('REGRESSION: the launcher left open after the game closed does not read as playing', async () => {
        tasklist = tl('system', 'explorer', 'marvelrivals_launcher');
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('nor does its updater or the crash reporter', async () => {
        tasklist = tl('marvelrivals_updater', 'crashreportclient', 'unrealcefsubprocess');
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('the game process itself reads as playing (found four folders down, Unreal layout)', async () => {
        tasklist = tl('marvelrivals_launcher', 'marvel-win64-shipping');
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Marvel Rivals', processName: 'marvel-win64-shipping' });
    });

    it('…and stops the moment the game process exits, launcher or not', async () => {
        tasklist = tl('marvelrivals_launcher', 'marvel-win64-shipping');
        expect(await gd.detectCurrentGame()).not.toBeNull();
        tasklist = tl('marvelrivals_launcher');
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('a non-Steam install (Epic, moved folder) is still recognised by the exact exe name', async () => {
        dirs.clear();
        tasklist = tl('marvel-win64-shipping');
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Marvel Rivals', processName: 'marvel-win64-shipping' });
        tasklist = tl('marvelrivals_launcher');
        gd.__resetGameDetectorForTests();
        expect(await gd.detectCurrentGame()).toBeNull();
    });

    it('a custom game still opts a launcher back in (Layer 1 outranks every exclusion)', async () => {
        gd.setCustomGames([{ processName: 'marvelrivals_launcher', displayName: 'Rivals (launcher)' }]);
        tasklist = tl('marvelrivals_launcher');
        expect(await gd.detectCurrentGame()).toEqual({ name: 'Rivals (launcher)', processName: 'marvelrivals_launcher' });
    });
});

describe('isHeuristicHelperName', () => {
    it.each([
        'marvelrivals_launcher', 'riotclientux_launcher', 'gameupdater', 'crashreportclient', 'easyanticheat_eos',
        'start_protected_game_anticheat', 'beservice_x64', 'unins000', 'unins', 'vc_redist.x64', 'ue4prereqsetup_x64',
        'steamwebhelper', 'gameoverlayui', 'cefsubprocess', 'bugsplat64', 'gamebugreporter', 'ubisoftconnectinstaller',
    ])('%s is a helper', (n) => { expect(gd.isHeuristicHelperName(n)).toBe(true); });

    it.each([
        'marvel-win64-shipping', 'eldenring', 'cs2', 'hades2', 'r5apex', 'stardewvalley', 'rocketleague', 'toolhost',
        'bepinex_game', 'subnautica', 'terraria',
    ])('%s is not', (n) => { expect(gd.isHeuristicHelperName(n)).toBe(false); });
});
