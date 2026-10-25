/**
 * The Steam-folder heuristic credits any executable in a game's install
 * folder to that game. A launcher / anti-cheat / updater from that folder
 * that stays resident therefore read as "Playing <game>" for as long as it
 * lived — a friend showed as playing Marvel Rivals for a week. These tests
 * drive the real detector against a fake Windows Steam library and a fake
 * process list, with a fake clock, and pin the backstop: a heuristic match is
 * only believed for a bounded amount of active time.
 *
 * The fixture exe is a deliberately unremarkable name ("ToolHost.exe"): the
 * backstop exists for resident software whose name gives nothing away.
 * Launchers / updaters / anti-cheat named as such (the actual Marvel Rivals
 * case, MarvelRivals_Launcher.exe) are no longer credited at all — see
 * game-detector.launcher.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

const LIB = 'D:/SteamLibrary';
const STEAM = 'C:\\Program Files (x86)\\Steam';
const steamapps = join(LIB, 'steamapps');
const gameDir = join(steamapps, 'common', 'MarvelRivals');

// The fake disk: absolute path -> file text (string) or directory listing.
const files = new Map<string, string>();
const dirs = new Map<string, Array<{ name: string; dir: boolean }>>();

let tasklist = '';
const tl = (...names: string[]) => names.map(n => `"${n}.exe","1234","Console","1","10,000 K"`).join('\r\n');

vi.mock('child_process', () => ({
    execFile: (file: string, _args: readonly string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
        if (file === 'tasklist') cb(null, { stdout: tasklist, stderr: '' });
        else if (file === 'powershell') cb(null, { stdout: 'ACTIVE\r\n', stderr: '' }); // not a suspended UWP ghost
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
let clock = 0;

const HOUR = 3_600_000;
const MIN = 60_000;

beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    files.clear(); dirs.clear();
    files.set(join(STEAM, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" "${LIB}" } }`);
    dirs.set(join(STEAM, 'steamapps'), []);
    files.set(join(steamapps, 'appmanifest_1.acf'), '"AppState" { "name" "Marvel Rivals" "installdir" "MarvelRivals" }');
    dirs.set(steamapps, [{ name: 'appmanifest_1.acf', dir: false }]);
    dirs.set(join(steamapps, 'common', 'MarvelRivals'), [{ name: 'ToolHost.exe', dir: false }]);
    dirs.set(gameDir, [{ name: 'ToolHost.exe', dir: false }]);

    clock = Date.UTC(2026, 9, 1, 12, 0, 0);
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
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

/** One scan at `clock`, then advance the clock by `advanceMs`. */
async function scan(advanceMs = 0) {
    const r = await gd.detectCurrentGame();
    clock += advanceMs;
    return r;
}

/** Scan every `stepMs` for `totalMs`; returns the last answer. */
async function runFor(totalMs: number, stepMs = 2 * MIN) {
    let last = await scan(0);
    for (let t = 0; t < totalMs; t += stepMs) { clock += stepMs; last = await scan(0); }
    return last;
}

describe('Steam-folder heuristic — resident software backstop', () => {
    it('credits the Steam folder exe to the game while it is plausibly being played', async () => {
        tasklist = tl('system', 'toolhost');
        expect(await scan()).toEqual({ name: 'Marvel Rivals', processName: 'toolhost' });
        expect(await runFor(3 * HOUR)).toEqual({ name: 'Marvel Rivals', processName: 'toolhost' });
        expect(await runFor(11 * HOUR)).toEqual({ name: 'Marvel Rivals', processName: 'toolhost' }); // 14 h in, still inside the budget
    });

    it('REGRESSION: a resident exe from the folder stops reading as "playing" once it exceeds the budget', async () => {
        // The stuck state: the process never exits, so the old code reported
        // it forever.
        tasklist = tl('system', 'toolhost');
        expect(await scan()).not.toBeNull();
        expect(await runFor(gd.HEURISTIC_MAX_ACTIVE_MS + HOUR)).toBeNull();
        // ...and keeps not reading as play on every later scan, for days.
        expect(await runFor(3 * 24 * HOUR)).toBeNull();
    });

    it('a fresh launch (the process left the list and came back) starts a new session', async () => {
        tasklist = tl('toolhost');
        await scan();
        expect(await runFor(gd.HEURISTIC_MAX_ACTIVE_MS + HOUR)).toBeNull();
        tasklist = tl('system');           // game closed
        expect(await runFor(4 * MIN)).toBeNull();
        tasklist = tl('toolhost'); // played again
        clock += 4 * MIN;
        expect(await scan()).toEqual({ name: 'Marvel Rivals', processName: 'toolhost' });
    });

    it('time the machine spent asleep (or with polling off) does not count against a real session', async () => {
        tasklist = tl('toolhost');
        await scan();
        clock += 20 * HOUR;               // overnight sleep: one scan, a 20 h gap
        expect(await scan()).toEqual({ name: 'Marvel Rivals', processName: 'toolhost' });
        expect(await runFor(10 * HOUR)).toEqual({ name: 'Marvel Rivals', processName: 'toolhost' });
    });

    it('but a resident exe on a laptop that sleeps every night is still caught (sleep neither resets nor counts)', async () => {
        tasklist = tl('toolhost');
        await scan();
        for (let day = 0; day < 3; day++) {
            await runFor(8 * HOUR);       // awake and polling
            clock += 9 * HOUR;            // asleep
        }
        expect(await scan()).toBeNull();  // 24 h of awake time by now
    });

    it('a scan gap beyond a day cannot be assumed to be the same instance', async () => {
        tasklist = tl('toolhost');
        await scan();
        expect(await runFor(gd.HEURISTIC_MAX_ACTIVE_MS + HOUR)).toBeNull();
        clock += 2 * 24 * HOUR;           // app was not scanning for two days
        expect(await scan()).toEqual({ name: 'Marvel Rivals', processName: 'toolhost' });
    });

    it('does not bound the exact layers: a curated-database game and a custom game keep reading as played', async () => {
        tasklist = tl('cs2');
        expect(await runFor(gd.HEURISTIC_MAX_ACTIVE_MS + 4 * HOUR)).toEqual({ name: 'Counter-Strike 2', processName: 'cs2' });

        gd.__resetGameDetectorForTests();
        gd.setCustomGames([{ processName: 'mything', displayName: 'My Thing' }]);
        tasklist = tl('mything');
        expect(await runFor(gd.HEURISTIC_MAX_ACTIVE_MS + 4 * HOUR)).toEqual({ name: 'My Thing', processName: 'mything' });
    });

    it('resetHeuristicSessions (game activity switched off) forgets every session', async () => {
        tasklist = tl('toolhost');
        await scan();
        expect(await runFor(gd.HEURISTIC_MAX_ACTIVE_MS + HOUR)).toBeNull();
        gd.resetHeuristicSessions();
        expect(await scan()).toEqual({ name: 'Marvel Rivals', processName: 'toolhost' });
    });
});

