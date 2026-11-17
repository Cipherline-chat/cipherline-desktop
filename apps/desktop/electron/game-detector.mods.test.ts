/**
 * FiveM / RedM (build-numbered game executables), alt:V / RAGE MP (GTA5.exe
 * plus a mod runtime) and FACEIT (a platform that only qualifies CS2).
 * Drives the real detector against a fake Windows process list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let tasklist = '';
const tl = (...names: string[]) => names.map(n => `"${n}.exe","1234","Console","1","10,000 K"`).join('\r\n');

vi.mock('child_process', () => ({
    execFile: (file: string, _a: readonly string[], _o: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
        if (file === 'tasklist') return cb(null, { stdout: tasklist, stderr: '' });
        if (file === 'powershell') return cb(null, { stdout: 'ACTIVE\r\n', stderr: '' });
        cb(null, { stdout: '', stderr: '' });
    },
}));

vi.mock('fs/promises', () => {
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return {
        access: async () => { throw enoent(); },
        readFile: async () => { throw enoent(); },
        readdir: async () => { throw enoent(); },
        stat: async () => { throw enoent(); },
    };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let gd: typeof import('./game-detector');

beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    gd = await import('./game-detector');
    gd.__resetGameDetectorForTests();
    gd.setCustomGames([]);
    gd.setIgnoredProcesses([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, 'platform', realPlatform); });

const detect = async (...procs: string[]) => { gd.__resetGameDetectorForTests(); tasklist = tl('System', ...procs); return gd.detectCurrentGame(); };

describe('FiveM', () => {
    const FIVEM = 'Grand Theft Auto V (FiveM)';
    it.each([
        'FiveM_GTAProcess', 'FiveM_b2189_GTAProcess', 'FiveM_b2802_GTAProcess', 'FiveM_b3095_GTAProcess', 'FiveM_b12345_GTAProcess',
        'FiveM_cl2_b3095_GTAProcess', 'FiveM_fxdk_GTAProcess', 'FiveM_cl2_fxdk_b2802_GTAProcess',
        'fivem_b3095_gtaprocess', 'FIVEM_B3095_GTAPROCESS',
    ])('%s is the game', async (exe) => {
        expect(await detect(exe)).toEqual({ name: FIVEM, processName: exe.toLowerCase() });
    });

    it('launcher and helper processes alone are not a game', async () => {
        for (const exe of ['FiveM', 'FiveM_ChromeBrowser', 'FiveM_SteamChild', 'FiveM_ROSLauncher', 'FiveM_ROSService', 'FiveM_ROSSubProcess', 'FiveM_DumpServer', 'FiveM_b3095_ChromeBrowser']) {
            expect(await detect(exe), exe).toBeNull();
        }
        expect(await detect('FiveM', 'FiveM_ChromeBrowser', 'FiveM_SteamChild')).toBeNull();
    });

    it('the game is found with the launcher and helpers around it, in any order', async () => {
        expect(await detect('FiveM', 'FiveM_ChromeBrowser', 'FiveM_b3095_GTAProcess', 'FiveM_SteamChild'))
            .toEqual({ name: FIVEM, processName: 'fivem_b3095_gtaprocess' });
        expect(await detect('FiveM_b3095_GTAProcess', 'FiveM')).toEqual({ name: FIVEM, processName: 'fivem_b3095_gtaprocess' });
    });

    it.each([
        'FiveM_bXYZ_GTAProcess', 'FiveM_b_GTAProcess', 'FiveM_b3095_GTAProcess2', 'xFiveM_b3095_GTAProcess', 'FiveM_b3095_GTAProcessX',
        'FiveM_b3095_GTA', 'FiveM_b3095', 'FiveM_b1234567_GTAProcess', 'FiveM_b3095_b2802_GTAProcess', 'FiveM__GTAProcess',
        'FiveMGTAProcess', 'FiveM_GameProcess', 'GTAProcess', 'CitizenFX', 'FiveM Launcher', 'FiveM-b3095-GTAProcess',
    ])('near-miss %s is not a game', async (exe) => {
        expect(await detect(exe)).toBeNull();
    });

    it('matchPatternGame is pure and anchored', () => {
        expect(gd.matchPatternGame('fivem_b2802_gtaprocess')).toBe(FIVEM);
        expect(gd.matchPatternGame('prefix_fivem_b2802_gtaprocess')).toBeNull();
        expect(gd.matchPatternGame('fivem_b2802_gtaprocess\n')).toBeNull();
        expect(gd.matchPatternGame('')).toBeNull();
    });

    it('priority: a custom game outranks the pattern; the ignore list silences it', async () => {
        gd.setCustomGames([{ processName: 'FiveM_b3095_GTAProcess', displayName: 'My RP' }]);
        expect(await detect('FiveM_b3095_GTAProcess')).toEqual({ name: 'My RP', processName: 'fivem_b3095_gtaprocess' });
        gd.setCustomGames([]);
        gd.setIgnoredProcesses(['fivem_b3095_gtaprocess']);
        expect(await detect('FiveM_b3095_GTAProcess')).toBeNull();
    });
});

describe('RedM', () => {
    const REDM = 'Red Dead Redemption 2 (RedM)';
    it.each(['RedM_GTAProcess', 'RedM_b1311_GTAProcess', 'RedM_b1491_GTAProcess', 'REDM_B1491_GTAPROCESS'])('%s is the game', async (exe) => {
        expect(await detect(exe)).toEqual({ name: REDM, processName: exe.toLowerCase() });
    });
    it('launcher and helpers are not a game; near-misses do not match', async () => {
        for (const exe of ['RedM', 'RedM_ROSLauncher', 'RedM_ChromeBrowser', 'RedM_GameProcess', 'RedM_b1491_RDR2Process', 'RDR2_b1491', 'RedM_bX_GTAProcess']) {
            expect(await detect(exe), exe).toBeNull();
        }
    });
    it('FiveM and RedM never cross-match', () => {
        expect(gd.matchPatternGame('redm_b1491_gtaprocess')).toBe(REDM);
        expect(gd.matchPatternGame('fivem_b1491_gtaprocess')).toBe('Grand Theft Auto V (FiveM)');
    });
});

describe('alt:V and RAGE MP (GTA5.exe + mod runtime)', () => {
    it('GTA5 alone is plain GTA V (positive control)', async () => {
        expect(await detect('GTA5')).toEqual({ name: 'Grand Theft Auto V', processName: 'gta5' });
    });
    it('GTA5 with the alt:V client reads as alt:V', async () => {
        expect(await detect('altv', 'GTA5')).toEqual({ name: 'Grand Theft Auto V (alt:V)', processName: 'gta5' });
        expect(await detect('GTA5', 'altv-webengine')).toEqual({ name: 'Grand Theft Auto V (alt:V)', processName: 'gta5' });
    });
    it('GTA5 with RAGE MP reads as RAGE MP', async () => {
        expect(await detect('ragemp_v', 'GTA5')).toEqual({ name: 'Grand Theft Auto V (RAGE MP)', processName: 'gta5' });
        expect(await detect('GTA5', 'ragemp_game_ui')).toEqual({ name: 'Grand Theft Auto V (RAGE MP)', processName: 'gta5' });
    });
    it('the launchers alone, or their helpers, are not a game', async () => {
        for (const exe of ['altv', 'altv-webengine', 'ragemp_v', 'ragemp_game_ui', 'ragemp_ui']) expect(await detect(exe), exe).toBeNull();
        expect(await detect('altv', 'ragemp_v', 'ragemp_game_ui')).toBeNull();
    });
    it('near-miss names do not qualify GTA5', async () => {
        expect(await detect('GTA5', 'altv2', 'altv_helper', 'ragemp', 'ragemp_vv', 'myaltv')).toEqual({ name: 'Grand Theft Auto V', processName: 'gta5' });
    });
    it('does not touch other games or a custom game on GTA5', async () => {
        expect(await detect('altv', 'cs2')).toEqual({ name: 'Counter-Strike 2', processName: 'cs2' });
        gd.setCustomGames([{ processName: 'gta5', displayName: 'GTA (mine)' }]);
        expect(await detect('altv', 'GTA5')).toEqual({ name: 'GTA (mine)', processName: 'gta5' });
    });
});

describe('FACEIT', () => {
    it('CS2 alone is plain Counter-Strike 2 (positive control)', async () => {
        expect(await detect('cs2')).toEqual({ name: 'Counter-Strike 2', processName: 'cs2' });
    });
    it('CS2 with the FACEIT client or its client-side anti-cheat reads as FACEIT, either order', async () => {
        expect(await detect('FACEIT', 'cs2')).toEqual({ name: 'Counter-Strike 2 (FACEIT)', processName: 'cs2' });
        expect(await detect('cs2', 'faceitclient')).toEqual({ name: 'Counter-Strike 2 (FACEIT)', processName: 'cs2' });
        expect(await detect('CS2', 'FACEIT', 'FACEITclient', 'FACEITService')).toEqual({ name: 'Counter-Strike 2 (FACEIT)', processName: 'cs2' });
    });
    it('the boot-time anti-cheat service alone does NOT label CS2 as FACEIT', async () => {
        expect(await detect('FACEITService', 'cs2')).toEqual({ name: 'Counter-Strike 2', processName: 'cs2' });
    });
    it('FACEIT without a game is never a game', async () => {
        for (const exe of ['FACEIT', 'faceitclient', 'FACEITService']) expect(await detect(exe), exe).toBeNull();
        expect(await detect('FACEIT', 'faceitclient', 'FACEITService')).toBeNull();
    });
    it('FACEIT does not rename other games; near-misses do not qualify', async () => {
        expect(await detect('FACEIT', 'dota2')).toEqual({ name: 'Dota 2', processName: 'dota2' });
        expect(await detect('cs2', 'faceit-helper', 'faceitx', 'myfaceit')).toEqual({ name: 'Counter-Strike 2', processName: 'cs2' });
    });
    it('keeps ignore and custom-game semantics keyed on the real process', async () => {
        gd.setIgnoredProcesses(['cs2']);
        expect(await detect('FACEIT', 'cs2')).toBeNull();
        gd.setIgnoredProcesses([]);
        gd.setCustomGames([{ processName: 'cs2', displayName: 'CS' }]);
        expect(await detect('FACEIT', 'cs2')).toEqual({ name: 'CS', processName: 'cs2' });
    });
    it('qualifyGameName is pure', () => {
        expect(gd.qualifyGameName('cs2', 'Counter-Strike 2', new Set(['faceit']))).toBe('Counter-Strike 2 (FACEIT)');
        expect(gd.qualifyGameName('cs2', 'Counter-Strike 2', new Set())).toBe('Counter-Strike 2');
        expect(gd.qualifyGameName('constructor', 'X', new Set(['faceit']))).toBe('X');
        expect(gd.qualifyGameName('__proto__', 'X', new Set(['faceit']))).toBe('X');
    });
});

describe('Steam-scan helper heuristic is untouched by the new names', () => {
    it('only applies to the Steam-folder layer; the curated pattern layer does not consult it', () => {
        // These would be "helpers" by the Steam heuristic ('service', 'launcher'),
        // yet the game pattern still matches: the two layers are independent.
        expect(gd.isHeuristicHelperName('faceitservice')).toBe(true);
        expect(gd.isHeuristicHelperName('fivem_roslauncher')).toBe(true);
        expect(gd.isHeuristicHelperName('fivem_b3095_gtaprocess')).toBe(false);
        expect(gd.matchPatternGame('fivem_b3095_gtaprocess')).not.toBeNull();
    });
});

describe('the new nulls do not disturb the rest of the database', () => {
    it('other games on the same list still resolve', async () => {
        expect(await detect('FiveM', 'rdr2')).toEqual({ name: 'Red Dead Redemption 2', processName: 'rdr2' });
        expect(await detect('FACEIT', 'eldenring')).toEqual({ name: 'Elden Ring', processName: 'eldenring' });
    });
});
