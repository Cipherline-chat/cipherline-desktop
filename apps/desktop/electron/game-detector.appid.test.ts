/**
 * The Steam app id of an installed game, learned from the same appmanifests
 * the library scan reads, so the profile row can ask for the game's Steam
 * picture the moment the game is detected (electron/game-art.ts). Same fake
 * Windows Steam library harness as game-detector.defaults.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

const LIB = 'D:/SteamLibrary';
const STEAM = 'C:\\Program Files (x86)\\Steam';
const steamapps = join(LIB, 'steamapps');
const common = join(steamapps, 'common');

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

function install(appid: string, name: string, dir: string, exes: string[]) {
    files.set(join(steamapps, `appmanifest_${appid}.acf`), `"AppState" { "appid" "${appid}" "name" "${name}" "installdir" "${dir}" }`);
    dirs.set(join(common, dir), exes.map(n => ({ name: n, dir: false })));
    dirs.set(steamapps, [...(dirs.get(steamapps) ?? []), { name: `appmanifest_${appid}.acf`, dir: false }]);
}

beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    files.clear(); dirs.clear();
    files.set(join(STEAM, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" "${LIB}" } }`);
    dirs.set(join(STEAM, 'steamapps'), []);
    dirs.set(steamapps, []);
    install('284160', 'BeamNG.drive', 'BeamNG.drive', ['BeamNG.drive.x64.exe']);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    gd = await import('./game-detector');
    gd.__resetGameDetectorForTests();
    gd.setCustomGames([]);
    gd.setIgnoredProcesses([]);
    tasklist = '';
});
afterEach(() => { Object.defineProperty(process, 'platform', realPlatform); vi.restoreAllMocks(); });

describe('Steam app ids from the library scan', () => {
    it('a detected Steam game is findable by name for its app id, and peekDetectedGame returns it without a scan', async () => {
        expect(gd.peekDetectedGame()).toBeNull();
        tasklist = tl('explorer', 'beamng.drive.x64');
        const g = await gd.detectCurrentGame();
        expect(g).toEqual({ name: 'BeamNG.drive', processName: 'beamng.drive.x64' });
        expect(gd.getSteamAppId('BeamNG.drive')).toBe(284160);
        expect(gd.peekDetectedGame()).toEqual(g);
    });

    it('a game that is not in the Steam library has no id; a name two apps share is dropped', async () => {
        install('1111', 'Twin', 'TwinA', ['twina.exe']);
        install('2222', 'Twin', 'TwinB', ['twinb.exe']);
        tasklist = tl('beamng.drive.x64');
        await gd.detectCurrentGame();
        expect(gd.getSteamAppId('Minecraft')).toBeNull();
        expect(gd.getSteamAppId('Twin')).toBeNull();
        expect(gd.getSteamAppId('BeamNG.drive')).toBe(284160);
    });
});
